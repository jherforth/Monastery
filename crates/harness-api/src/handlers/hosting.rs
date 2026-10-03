//! Hosting service connections (Coolify, Dokploy, Pocketbase, Cloudflare).

use super::*;

#[derive(Debug, Deserialize)]
pub(crate) struct ConnectHostingRequest {
    name: String,
    service_type: String, // "dokploy" | "coolify" | "pocketbase"
    base_url: String,
    api_token: String,
    #[serde(default)]
    email: Option<String>,
}

/// List all hosting service connections
pub async fn list_hosting_connections(
    State(state): State<AppState>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, name, service_type, base_url, api_token, username, email, is_default, created_at, last_synced_at, tunnel_token FROM hosting_connections ORDER BY created_at DESC"
    )
    .fetch_all(&*state.db)
    .await?;

    let connections: Vec<serde_json::Value> = rows.iter().map(|row| {
        let id: String = row.get(0);
        let name: String = row.get(1);
        let service_type: String = row.get(2);
        let base_url: String = row.get(3);
        let _api_token: String = row.get(4); // Don't expose token in list
        let username: Option<String> = row.get(5);
        let email: Option<String> = row.get(6);
        let is_default: i64 = row.get(7);
        let created_at: String = row.get(8);
        let last_synced_at: Option<String> = row.get(9);
        // Like api_token: presence only, never the secret itself.
        let tunnel_token: Option<String> = row.get(10);

        serde_json::json!({
            "id": id,
            "name": name,
            "service_type": service_type,
            "base_url": base_url,
            "username": username,
            "email": email,
            "is_default": is_default != 0,
            "created_at": created_at,
            "last_synced_at": last_synced_at,
            "has_tunnel_token": tunnel_token.map(|t| !t.trim().is_empty()).unwrap_or(false),
        })
    }).collect();

    Ok(Json(connections))
}

/// Set (or clear, with null/empty) the Cloudflare tunnel connector token stored on a
/// dokploy/coolify connection. Each platform server runs its own tunnel, so tokens live
/// per-connection; deploys with the tunnel enabled fall back to this when no token is pasted.
#[derive(Debug, Deserialize)]
pub struct SetTunnelTokenRequest {
    pub tunnel_token: Option<String>,
}

pub async fn set_hosting_tunnel_token(
    Path(id): Path<uuid::Uuid>,
    State(state): State<AppState>,
    Json(req): Json<SetTunnelTokenRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = sqlx::query("SELECT service_type FROM hosting_connections WHERE id = ?")
        .bind(id.to_string())
        .fetch_optional(&*state.db)
        .await?;
    let service_type: String = match row {
        Some(r) => r.get(0),
        None => return Err(ApiError::NotFound("Connection not found".into())),
    };
    if !["dokploy", "coolify"].contains(&service_type.as_str()) {
        return Err(ApiError::Config(
            "Tunnel tokens attach to deployment platforms (Dokploy or Coolify) — the token belongs to the tunnel running on that platform's server.".into(),
        ));
    }
    let token = req.tunnel_token.as_deref().map(str::trim).filter(|t| !t.is_empty());
    sqlx::query("UPDATE hosting_connections SET tunnel_token = ? WHERE id = ?")
        .bind(token)
        .bind(id.to_string())
        .execute(&*state.db)
        .await?;
    Ok(Json(serde_json::json!({ "success": true, "has_tunnel_token": token.is_some() })))
}

/// Connect a new hosting service
pub async fn connect_hosting_service(
    State(state): State<AppState>,
    Json(req): Json<ConnectHostingRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Validate service type
    if !["dokploy", "coolify", "pocketbase", "cloudflare"].contains(&req.service_type.as_str()) {
        return Err(ApiError::Config(format!(
            "Invalid service_type '{}'. Must be one of: dokploy, coolify, pocketbase",
            req.service_type
        )));
    }

    // Validate URL
    if !req.base_url.starts_with("http://") && !req.base_url.starts_with("https://") {
        return Err(ApiError::Config("Base URL must start with http:// or https://".into()));
    }

    let id = uuid::Uuid::new_v4();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO hosting_connections (id, name, service_type, base_url, api_token, username, email, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id.to_string())
    .bind(&req.name)
    .bind(&req.service_type)
    .bind(&req.base_url)
    .bind(&req.api_token)
    .bind(None::<String>) // username filled after test
    .bind(req.email.as_deref())
    .bind(0i64)
    .bind(&now)
    .execute(&*state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "id": id.to_string(),
        "name": req.name,
        "service_type": req.service_type,
        "base_url": req.base_url,
        "username": null,
        "email": req.email,
        "is_default": false,
        "created_at": now,
        "last_synced_at": null,
    })))
}

/// Delete a hosting service connection
pub async fn delete_hosting_connection(
    Path(id): Path<uuid::Uuid>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    sqlx::query("DELETE FROM hosting_connections WHERE id = ?")
        .bind(id.to_string())
        .execute(&*state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Test a hosting service connection
pub async fn test_hosting_connection(
    Path(id): Path<uuid::Uuid>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = sqlx::query(
        "SELECT service_type, base_url, api_token FROM hosting_connections WHERE id = ?"
    )
    .bind(id.to_string())
    .fetch_optional(&*state.db)
    .await?;

    let (service_type, base_url, api_token) = match row {
        Some(r) => {
            let st: String = r.get(0);
            let bu: String = r.get(1);
            let at: String = r.get(2);
            (st, bu, at)
        }
        None => return Err(ApiError::NotFound("Connection not found".into())),
    };

    // Try to reach the service's health or user endpoint
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| ApiError::Internal(format!("Failed to build HTTP client: {}", e)))?;

    let (test_url, auth_header_name) = match service_type.as_str() {
        "dokploy" => (format!("{}/api/health", base_url.trim_end_matches('/')), "x-api-key"),
        "coolify" => (format!("{}/api/v1/health", base_url.trim_end_matches('/')), "Authorization"),
        "pocketbase" => (format!("{}/api/health", base_url.trim_end_matches('/')), "Authorization"),
        // Cloudflare: verify the API token itself. On auth failure the message below names
        // the scopes routing automation needs.
        "cloudflare" => (format!("{}/user/tokens/verify", base_url.trim_end_matches('/')), "Authorization"),
        _ => (format!("{}/api", base_url.trim_end_matches('/')), "Authorization"),
    };

    let mut req = client.get(&test_url);
    if auth_header_name == "Authorization" {
        req = req.header("Authorization", format!("Bearer {}", api_token));
    } else {
        req = req.header(auth_header_name, &api_token);
    }

    match req.send().await
    {
        Ok(resp) => {
            let status = resp.status();
            if !status.is_success() && service_type == "cloudflare" && (status.as_u16() == 401 || status.as_u16() == 403) {
                return Ok(Json(serde_json::json!({
                    "healthy": false,
                    "message": "Cloudflare rejected the token. It needs: Account → Cloudflare Tunnel: Edit, and Zone → DNS: Edit (for every zone you deploy to).",
                })));
            }
            if status.is_success() {
                // Update last_synced_at
                let now = chrono::Utc::now().to_rfc3339();
                let _ = sqlx::query("UPDATE hosting_connections SET last_synced_at = ? WHERE id = ?")
                    .bind(&now)
                    .bind(id.to_string())
                    .execute(&*state.db)
                    .await;

                Ok(Json(serde_json::json!({
                    "healthy": true,
                    "message": format!("Connection successful (HTTP {})", status.as_u16()),
                })))
            } else if status.as_u16() == 401 || status.as_u16() == 403 {
                Ok(Json(serde_json::json!({
                    "healthy": false,
                    "message": "Authentication failed. Check your API token.",
                })))
            } else {
                Ok(Json(serde_json::json!({
                    "healthy": false,
                    "message": format!("Service returned HTTP {}. Check the URL and try again.", status.as_u16()),
                })))
            }
        }
        Err(e) => Ok(Json(serde_json::json!({
            "healthy": false,
            "message": format!("Connection failed: {}", e),
        }))),
    }
}

/// A deployable server returned by a hosting platform, normalized across providers.
#[derive(Debug, Serialize)]
pub(crate) struct HostingServer {
    /// Coolify server uuid, or Dokploy serverId — the value passed back as `server_uuid`.
    pub uuid: String,
    pub name: String,
    pub ip: Option<String>,
    /// True for the platform's built-in "localhost" server (the host running Coolify/Dokploy).
    pub is_localhost: bool,
    /// Whether the platform reports the server as reachable/usable for deployment.
    pub is_usable: bool,
}

/// List the servers available on a hosting connection so the UI can let the user pick
/// a deployment target. Works for both Coolify (`/api/v1/servers`) and Dokploy
/// (`/api/trpc/server.all`).
pub async fn list_hosting_servers(
    Path(id): Path<uuid::Uuid>,
    State(state): State<AppState>,
) -> Result<Json<Vec<HostingServer>>, ApiError> {
    let row = sqlx::query(
        "SELECT service_type, base_url, api_token FROM hosting_connections WHERE id = ?"
    )
    .bind(id.to_string())
    .fetch_optional(&*state.db)
    .await?;

    let (service_type, base_url, api_token) = match row {
        Some(r) => (r.get::<String, _>(0), r.get::<String, _>(1), r.get::<String, _>(2)),
        None => return Err(ApiError::NotFound("Hosting connection not found".into())),
    };

    let base = base_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| ApiError::Internal(format!("Failed to build HTTP client: {}", e)))?;

    match service_type.as_str() {
        "coolify" => {
            let resp = client
                .get(format!("{}/api/v1/servers", base))
                .header("Authorization", format!("Bearer {}", api_token))
                .send()
                .await
                .map_err(|e| ApiError::Internal(format!("Failed to fetch Coolify servers: {}", e)))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(ApiError::Internal(format!("Failed to list Coolify servers: HTTP {}: {}", status, body)));
            }
            let servers: Vec<serde_json::Value> = resp.json().await
                .map_err(|e| ApiError::Internal(format!("Failed to parse Coolify servers: {}", e)))?;
            let out = servers.iter().filter_map(|s| {
                let uuid = s["uuid"].as_str()?.to_string();
                let ip = s["ip"].as_str().map(|v| v.to_string());
                Some(HostingServer {
                    name: s["name"].as_str().unwrap_or("unnamed").to_string(),
                    is_localhost: ip.as_deref() == Some("host.docker.internal"),
                    is_usable: s["is_usable"].as_bool().unwrap_or(true) && s["is_reachable"].as_bool().unwrap_or(true),
                    ip,
                    uuid,
                })
            }).collect();
            Ok(Json(out))
        }
        "dokploy" => {
            let resp = client
                .get(format!("{}/api/trpc/server.all", base))
                .header("x-api-key", &api_token)
                .send()
                .await
                .map_err(|e| ApiError::Internal(format!("Failed to fetch Dokploy servers: {}", e)))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(ApiError::Internal(format!("Failed to list Dokploy servers: HTTP {}: {}", status, body)));
            }
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            let list = data["result"]["data"]["json"].as_array()
                .or_else(|| data["result"]["data"].as_array())
                .or_else(|| data["result"].as_array())
                .cloned()
                .unwrap_or_default();
            let out = list.iter().filter_map(|s| {
                let uuid = s["serverId"].as_str().or_else(|| s["id"].as_str())?.to_string();
                let ip = s["ipAddress"].as_str().or_else(|| s["ip"].as_str()).map(|v| v.to_string());
                let is_localhost = matches!(ip.as_deref(), Some("") | Some("127.0.0.1") | Some("localhost") | None);
                Some(HostingServer {
                    name: s["name"].as_str().unwrap_or("unnamed").to_string(),
                    is_localhost,
                    is_usable: s["serverStatus"].as_str().map(|st| st == "active").unwrap_or(true),
                    ip,
                    uuid,
                })
            }).collect();
            Ok(Json(out))
        }
        other => Err(ApiError::Config(format!(
            "Listing servers is not supported for service type '{}'.", other
        ))),
    }
}
