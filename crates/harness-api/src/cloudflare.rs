//! Cloudflare API automation for tunnel routing.
//!
//! Token tunnels are remotely managed: the connector container only needs TUNNEL_TOKEN, while
//! the public-hostname → service mapping and DNS live in Cloudflare's config. Historically that
//! made "add a Public Hostname + CNAME" a manual Zero Trust dashboard step after every deploy.
//! With a Cloudflare API token (Account → Cloudflare Tunnel:Edit, Zone → DNS:Edit) this module
//! performs both steps idempotently.
//!
//! Routing failures must NEVER fail a deploy — callers surface the error string in
//! `DeployResult.routing_error` and the UI falls back to the manual instructions.

use base64::Engine as _;

const API_BASE: &str = "https://api.cloudflare.com/client/v4";

/// Identity of a tunnel, parsed from a connector token or recalled from the deploy manifest.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TunnelRef {
    pub account_id: String,
    pub tunnel_id: String,
}

/// Parse a cloudflared connector token: base64 JSON `{"a": account, "t": tunnel, "s": secret}`.
/// The secret is deliberately dropped — only identifiers leave this function.
pub fn parse_tunnel_token(token: &str) -> Option<TunnelRef> {
    let token = token.trim();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(token)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(token))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token))
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    Some(TunnelRef {
        account_id: json.get("a")?.as_str()?.to_string(),
        tunnel_id: json.get("t")?.as_str()?.to_string(),
    })
}

/// Collapse a Cloudflare error response body into a short readable string.
fn cf_errors(body: &serde_json::Value) -> String {
    body.get("errors")
        .and_then(|e| e.as_array())
        .map(|errs| {
            errs.iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown Cloudflare error".to_string())
}

async fn cf_get(client: &reqwest::Client, api_token: &str, path: &str) -> Result<serde_json::Value, String> {
    let resp = client
        .get(format!("{}{}", API_BASE, path))
        .bearer_auth(api_token)
        .send()
        .await
        .map_err(|e| format!("Cloudflare API request failed: {}", e))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Invalid Cloudflare response: {}", e))?;
    if !status.is_success() || body.get("success").and_then(|s| s.as_bool()) == Some(false) {
        return Err(format!("Cloudflare API {} (HTTP {}): {}", path, status.as_u16(), cf_errors(&body)));
    }
    Ok(body)
}

async fn cf_send_json(
    client: &reqwest::Client,
    api_token: &str,
    method: reqwest::Method,
    path: &str,
    payload: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resp = client
        .request(method.clone(), format!("{}{}", API_BASE, path))
        .bearer_auth(api_token)
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("Cloudflare API request failed: {}", e))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Invalid Cloudflare response: {}", e))?;
    if !status.is_success() || body.get("success").and_then(|s| s.as_bool()) == Some(false) {
        return Err(format!(
            "Cloudflare API {} {} (HTTP {}): {}",
            method, path, status.as_u16(), cf_errors(&body)
        ));
    }
    Ok(body)
}

/// Upsert the tunnel ingress rule `hostname → http://127.0.0.1:{host_port}` while preserving all
/// other rules and keeping the catch-all (`http_status:404`) last (Cloudflare rejects the config
/// otherwise). Read-modify-write — the caller must hold the app-level cloudflare config lock.
async fn ensure_ingress(
    client: &reqwest::Client,
    api_token: &str,
    tun: &TunnelRef,
    hostname: &str,
    host_port: u16,
) -> Result<(), String> {
    let path = format!("/accounts/{}/cfd_tunnel/{}/configurations", tun.account_id, tun.tunnel_id);
    let current = cf_get(client, api_token, &path).await?;

    // A locally-managed (config-file) tunnel ignores remote config — pushing rules at it would
    // silently do nothing. Detect and tell the user to use the dashboard/config file instead.
    if let Some(src) = current["result"]["source"].as_str() {
        if src == "local" {
            return Err("This tunnel is locally managed (config file) — remote ingress configuration is ignored. Use a token (remotely-managed) tunnel or add the hostname to the tunnel's config.yml.".to_string());
        }
    }

    // A never-configured token tunnel can return null config — start from empty.
    let mut ingress: Vec<serde_json::Value> = current["result"]["config"]["ingress"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let service = format!("http://127.0.0.1:{}", host_port);
    let new_rule = serde_json::json!({ "hostname": hostname, "service": service });

    // Split off the catch-all (any rule without a hostname), upsert ours among the rest.
    let catch_alls: Vec<serde_json::Value> = ingress
        .iter()
        .filter(|r| r.get("hostname").and_then(|h| h.as_str()).map(|h| !h.is_empty()) != Some(true))
        .cloned()
        .collect();
    ingress.retain(|r| r.get("hostname").and_then(|h| h.as_str()).map(|h| !h.is_empty()) == Some(true));

    if let Some(existing) = ingress.iter_mut().find(|r| r.get("hostname").and_then(|h| h.as_str()) == Some(hostname)) {
        *existing = new_rule;
    } else {
        ingress.push(new_rule);
    }
    // Exactly one catch-all, always last.
    ingress.push(
        catch_alls.into_iter().next().unwrap_or_else(|| serde_json::json!({ "service": "http_status:404" })),
    );

    let payload = serde_json::json!({ "config": { "ingress": ingress } });
    cf_send_json(client, api_token, reqwest::Method::PUT, &path, &payload).await?;
    Ok(())
}

/// Find the zone id for a hostname by progressively stripping labels
/// (`a.b.example.com` → `b.example.com` → `example.com`) — correct for multi-label TLDs.
async fn find_zone(client: &reqwest::Client, api_token: &str, hostname: &str) -> Result<(String, String), String> {
    let labels: Vec<&str> = hostname.split('.').collect();
    for start in 0..labels.len().saturating_sub(1) {
        let candidate = labels[start..].join(".");
        let body = cf_get(client, api_token, &format!("/zones?name={}", candidate)).await?;
        if let Some(zone) = body["result"].as_array().and_then(|z| z.first()) {
            if let Some(id) = zone["id"].as_str() {
                return Ok((id.to_string(), candidate));
            }
        }
    }
    Err(format!(
        "No Cloudflare zone found for {} — is the domain added to this Cloudflare account?",
        hostname
    ))
}

/// Upsert the proxied CNAME `hostname → {tunnel_id}.cfargotunnel.com`.
async fn ensure_cname(
    client: &reqwest::Client,
    api_token: &str,
    zone_id: &str,
    hostname: &str,
    tunnel_id: &str,
) -> Result<(), String> {
    let content = format!("{}.cfargotunnel.com", tunnel_id);
    let existing = cf_get(
        client,
        api_token,
        &format!("/zones/{}/dns_records?type=CNAME&name={}", zone_id, hostname),
    )
    .await?;
    let payload = serde_json::json!({
        "type": "CNAME",
        "name": hostname,
        "content": content,
        "proxied": true,
        "ttl": 1,
    });
    if let Some(record) = existing["result"].as_array().and_then(|r| r.first()) {
        let record_id = record["id"].as_str().unwrap_or_default();
        cf_send_json(
            client,
            api_token,
            reqwest::Method::PATCH,
            &format!("/zones/{}/dns_records/{}", zone_id, record_id),
            &payload,
        )
        .await?;
    } else {
        cf_send_json(
            client,
            api_token,
            reqwest::Method::POST,
            &format!("/zones/{}/dns_records", zone_id),
            &payload,
        )
        .await?;
    }
    Ok(())
}

/// End-to-end idempotent routing: ingress rule + proxied CNAME for `hostname` → the app's
/// published host port. Returns the public https URL on success, a readable error otherwise.
pub async fn ensure_routing(
    client: &reqwest::Client,
    api_token: &str,
    tun: &TunnelRef,
    hostname: &str,
    host_port: u16,
) -> Result<String, String> {
    ensure_ingress(client, api_token, tun, hostname, host_port).await?;
    let (zone_id, _zone_name) = find_zone(client, api_token, hostname).await?;
    ensure_cname(client, api_token, &zone_id, hostname, &tun.tunnel_id).await?;
    Ok(format!("https://{}", hostname))
}
