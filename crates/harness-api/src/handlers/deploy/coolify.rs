//! Deploying to Coolify (clone-at-build: an inline Dockerfile that clones the repo itself).

use super::*;

/// Create or update the Coolify app for this project and start a deployment.
pub(crate) async fn deploy(cx: DeployContext) -> Result<Json<serde_json::Value>, ApiError> {
    let DeployContext { state, req, base: base_url, api_token, effective_tunnel_token, project_name, project_path, framework, output_dir, port, pocketbase_url, manifest_existed, mut manifest, cloudflare_api_token, client, .. } = cx;
    let base = base_url.as_str();
    use base64::Engine as _;

    // "Clone-at-build" deployment: we send Coolify an inline Dockerfile that itself
    // git-clones the project repo at build time. The clone runs inside the Docker build
    // on the deploy server (which can reach the forge on the LAN), so it bypasses
    // Coolify's git-URL validation entirely and works with IP / .local / self-signed
    // forges — the all-local homelab case. Coolify's own git flows only support SSH
    // deploy keys or provider OAuth apps, not arbitrary token-in-URL HTTPS (it strips the
    // host down to owner/repo and clones over SSH, which fails for self-hosted forges).
    let git = resolve_project_git(&state, &project_path).await?;
    let clone_url = build_authed_clone_url(&git.remote_url, &git.token);
    let (clone_dockerfile, container_port) =
        generate_clone_dockerfile(&framework, &output_dir, port, &clone_url, &git.branch);
    // The container listens on this port (e.g. 80 for nginx-served builds); use it for
    // Coolify's port mapping and the tunnel instead of the framework's dev port.
    let port = container_port;

    // Host port to publish the app on, so it's directly reachable at
    // http://<server-ip>:<host_port> on the LAN — no DNS / sslip.io / Traefik domain
    // needed (the all-local case). Must NOT be 80/443 — those are owned by Coolify's
    // proxy on the deploy host, so publishing there fails with "port is already
    // allocated". The manifest PINS the port once assigned (stable across renames and
    // Monastery instances — Cloudflare Public Hostname rules keep working forever);
    // first deploy derives it deterministically from the app name.
    let host_port: u16 = manifest
        .targets
        .get("coolify")
        .map(|t| t.host_port)
        .unwrap_or_else(|| {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            req.app_name.hash(&mut h);
            20000 + (h.finish() % 10000) as u16
        });

    // Tunnel identity for automated routing: a freshly pasted connector token wins,
    // else whatever an earlier deploy recorded in the manifest (token-less redeploys).
    let tunnel_ref = effective_tunnel_token
        .as_deref()
        .and_then(crate::cloudflare::parse_tunnel_token)
        .or_else(|| {
            manifest
                .targets
                .get("coolify")
                .and_then(|t| t.cloudflare.as_ref())
                .map(|c| c.tunnel_ref())
        });

    // Branch note: the manifest records which branch this target tracks; a mismatch is
    // surfaced (not blocked) so accidental cross-branch deploys are visible.
    let branch_mismatch = manifest
        .targets
        .get("coolify")
        .and_then(|t| t.branch.as_deref())
        .map(|b| b != git.branch)
        .unwrap_or(false);

    // Resolve the app to redeploy: local cache first; else cross-instance discovery via
    // the manifest marker embedded in the Coolify app description (a collaborator's
    // instance or a rebuilt DB adopts the existing app instead of duplicating it).
    let mut adopted = false;
    let mut existing = lookup_deployment(&state, req.project_id, req.connection_id).await?;
    if existing.is_none() && manifest_existed && manifest.targets.contains_key("coolify") {
        if let Some((found_uuid, found_server)) =
            discover_coolify_app_by_marker(&client, base, &api_token, &manifest.marker()).await
        {
            tracing::info!("Adopted existing Coolify app {} via deploy manifest marker", found_uuid);
            let _ = save_deployment(
                &state, req.project_id, req.connection_id, "coolify",
                &found_uuid, &req.app_name, found_server.as_deref().unwrap_or(""),
            ).await;
            existing = Some(found_uuid);
            adopted = true;
        }
    }

    // If already deployed for this (project, connection), redeploy the SAME app with a
    // forced (no-cache) rebuild so the in-Dockerfile clone re-fetches the latest commit.
    // If the app was deleted in Coolify (404), drop the stale mapping and fall through to
    // create a fresh one — so a user who wipes the app in Coolify can just redeploy.
    if let Some(existing_uuid) = existing {
        // Refresh the app's stored Dockerfile FIRST. A Coolify redeploy rebuilds from the
        // Dockerfile it saved at create time; because that Dockerfile was byte-identical
        // every redeploy, the `git clone` layer stayed cached and the app kept serving the
        // code from its first build. Re-sending a freshly-generated Dockerfile (new
        // embedded cachebust) changes the clone layer's cache key so `force=true` actually
        // re-clones the latest commit. Best-effort: if the update fails we still trigger the
        // forced rebuild below (no worse than before).
        let dockerfile_b64 = base64::engine::general_purpose::STANDARD.encode(clone_dockerfile.as_bytes());
        let patch_url = format!("{}/api/v1/applications/{}", base, existing_uuid);
        // The PATCH also re-syncs port + domain config (same field names as create):
        // redeploys must CONVERGE drifted or missing settings. Field-tested reason: an
        // app created without ports_mappings could never gain one — the published host
        // port (which tunnel routing points at) only takes effect via this PATCH plus
        // the forced redeploy below.
        let mut patch_body = serde_json::json!({
            "dockerfile": dockerfile_b64,
            "ports_exposes": port.to_string(),
            "ports_mappings": format!("{}:{}", host_port, port),
        });
        if let Some(ref domain) = req.domain {
            if !domain.is_empty() {
                patch_body["domains"] = serde_json::Value::String(domain.clone());
            }
        }
        match client
            .patch(&patch_url)
            .header("Authorization", format!("Bearer {}", api_token))
            .header("Content-Type", "application/json")
            .json(&patch_body)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                tracing::info!(
                    "Refreshed Coolify app {} before redeploy (dockerfile + ports {}:{}{})",
                    existing_uuid, host_port, port,
                    req.domain.as_deref().filter(|d| !d.is_empty()).map(|d| format!(" + domain {}", d)).unwrap_or_default()
                );
            }
            Ok(r) => {
                tracing::warn!(
                    "Coolify Dockerfile refresh returned HTTP {} — redeploying with force anyway",
                    r.status().as_u16()
                );
            }
            Err(e) => {
                tracing::warn!("Coolify Dockerfile refresh request failed ({}) — redeploying with force anyway", e);
            }
        }

        let deploy_url = format!("{}/api/v1/deploy?uuid={}&force=true", base, existing_uuid);
        match client
            .get(&deploy_url)
            .header("Authorization", format!("Bearer {}", api_token))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => {
                // Redeploys also refresh identity + routing: the manifest is (re)written
                // (this is how pre-manifest deployments gain one), and Cloudflare routing
                // is re-ensured — redeploy is exactly when domains change.
                record_manifest_target(
                    &project_path, &mut manifest, "coolify", &req.app_name,
                    &git.branch, host_port, req.domain.as_deref(), tunnel_ref.as_ref(),
                );
                if !manifest_existed {
                    // Legacy migration: stamp the marker into the app description so other
                    // instances can discover it. Best-effort.
                    let _ = client
                        .patch(format!("{}/api/v1/applications/{}", base, existing_uuid))
                        .header("Authorization", format!("Bearer {}", api_token))
                        .header("Content-Type", "application/json")
                        .json(&serde_json::json!({
                            "description": format!(
                                "Deployed from Monastery — project: {} [{}]",
                                project_name, manifest.marker()
                            ),
                        }))
                        .send()
                        .await;
                }
                let (routing_configured, routing_error, routed_url) = run_cloudflare_routing(
                    &state, cloudflare_api_token.as_deref(), tunnel_ref.as_ref(),
                    req.domain.as_deref(), host_port,
                ).await;
                return Ok(Json(serde_json::json!({
                    "success": true,
                    "platform": "coolify",
                    "app_uuid": existing_uuid,
                    "app_name": req.app_name,
                    "deploy_triggered": true,
                    "redeployed": true,
                    "adopted": adopted,
                    "deploy_id": manifest.deploy_id,
                    "branch_mismatch": branch_mismatch,
                    "dashboard_url": format!("{}/projects", base.trim_end_matches("/api/v1")),
                    "framework": framework,
                    "port": port,
                    "host_port": host_port,
                    "host_service_url": format!("http://127.0.0.1:{}", host_port),
                    "tunnel_service_url": format!("http://127.0.0.1:{}", host_port),
                    "routing_configured": routing_configured,
                    "routing_error": routing_error,
                    "routed_url": routed_url,
                })));
            }
            // 404 = the app no longer exists in Coolify (deleted by the user). Forget the
            // stale mapping and continue on to recreate it below.
            Ok(r) if r.status().as_u16() == 404 => {
                tracing::warn!("Coolify app {} no longer exists (404) — recreating a fresh app.", existing_uuid);
                let _ = sqlx::query("DELETE FROM deployments WHERE project_id = ? AND connection_id = ?")
                    .bind(req.project_id.to_string())
                    .bind(req.connection_id.to_string())
                    .execute(&*state.db)
                    .await;
            }
            // Any other failure is likely transient — surface it instead of silently
            // creating a duplicate app.
            Ok(r) => {
                let status = r.status().as_u16();
                let body = r.text().await.unwrap_or_default();
                let snippet: String = body.chars().take(200).collect();
                return Err(ApiError::Internal(format!("Coolify redeploy failed (HTTP {}): {}", status, snippet)));
            }
            Err(e) => {
                return Err(ApiError::Internal(format!("Coolify redeploy request failed: {}", e)));
            }
        }
    }

    // Fetch available project and server from Coolify
    let projects_url = format!("{}/api/v1/projects", base);
    let projects_resp = client
        .get(&projects_url)
        .header("Authorization", format!("Bearer {}", api_token))
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to fetch Coolify projects: {}", e)))?;

    if !projects_resp.status().is_success() {
        let status = projects_resp.status().as_u16();
        let body = projects_resp.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!("Failed to list Coolify projects: HTTP {}: {}", status, body)));
    }

    let projects: Vec<serde_json::Value> = projects_resp.json().await
        .map_err(|e| ApiError::Internal(format!("Failed to parse Coolify projects: {}", e)))?;
    let project_uuid = if let Some(proj) = projects.first().and_then(|p| p["uuid"].as_str()) {
        proj.to_string()
    } else {
        // No projects exist — auto-create a "Monastery" project
        let create_proj_url = format!("{}/api/v1/projects", base);
        let proj_resp = client
            .post(&create_proj_url)
            .header("Authorization", format!("Bearer {}", api_token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "name": "Monastery",
                "description": "Auto-created by Monastery for deployments"
            }))
            .send()
            .await
            .map_err(|e| ApiError::Internal(format!("Failed to create Coolify project: {}", e)))?;
        if !proj_resp.status().is_success() {
            let status = proj_resp.status().as_u16();
            let _body = proj_resp.text().await.unwrap_or_default();
            return Err(ApiError::Config(format!(
                "No projects found and auto-creation failed (HTTP {}). Create a project in the Coolify dashboard first.",
                status
            )));
        }
        let proj: serde_json::Value = proj_resp.json().await
            .map_err(|e| ApiError::Internal(format!("Failed to parse created project: {}", e)))?;
        proj["uuid"].as_str()
            .ok_or_else(|| ApiError::Config("Auto-created project but could not read its UUID. Check Coolify dashboard.".into()))?
            .to_string()
    };

    // Fetch first available server
    let servers_url = format!("{}/api/v1/servers", base);
    let servers_resp = client
        .get(&servers_url)
        .header("Authorization", format!("Bearer {}", api_token))
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("Failed to fetch Coolify servers: {}", e)))?;

    if !servers_resp.status().is_success() {
        let status = servers_resp.status().as_u16();
        let body = servers_resp.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!("Failed to list Coolify servers: HTTP {}: {}", status, body)));
    }

    let servers: Vec<serde_json::Value> = servers_resp.json().await
        .map_err(|e| ApiError::Internal(format!("Failed to parse Coolify servers: {}", e)))?;

    // Coolify's first server is the built-in "localhost" — the Coolify host itself,
    // identified by ip == "host.docker.internal". Deploying there runs the app ON the
    // Coolify box (colliding with whatever already serves port 80 there), not on the
    // user's VPS. Prefer a usable, non-localhost server; fall back progressively so we
    // never hard-fail when only localhost exists.
    let is_localhost = |s: &serde_json::Value| s["ip"].as_str() == Some("host.docker.internal");
    let is_usable = |s: &serde_json::Value| {
        // Treat missing flags as usable so an unexpected API shape doesn't exclude everything.
        s["is_usable"].as_bool().unwrap_or(true) && s["is_reachable"].as_bool().unwrap_or(true)
    };
    // If the user explicitly picked a server in the wizard, honor it. Otherwise
    // auto-select a usable, non-localhost server (see comment above).
    let explicit_server = req.server_uuid.as_deref()
        .and_then(|want| servers.iter().find(|s| s["uuid"].as_str() == Some(want)));
    if req.server_uuid.is_some() && explicit_server.is_none() {
        return Err(ApiError::Config(
            "The selected server was not found in Coolify. Refresh the server list and try again.".into()
        ));
    }
    let chosen_server = explicit_server
        .or_else(|| servers.iter().find(|s| is_usable(s) && !is_localhost(s)))
        .or_else(|| servers.iter().find(|s| !is_localhost(s)))
        .or_else(|| servers.iter().find(|s| is_usable(s)))
        .or_else(|| servers.first());

    let chosen_server = chosen_server.ok_or_else(|| ApiError::Config(
        "No servers found in Coolify. You must add a server in the Coolify dashboard first. Go to Servers → Add Server, then retry the deployment.".into()
    ))?;
    let server_uuid = chosen_server["uuid"].as_str().ok_or_else(|| ApiError::Config(
        "Coolify server entry is missing its uuid. Check the Coolify dashboard.".into()
    ))?;
    let chosen_server_name = chosen_server["name"].as_str().unwrap_or("unknown").to_string();
    if is_localhost(chosen_server) {
        tracing::warn!(
            "Coolify deploy is targeting the built-in localhost server ('{}'). \
             Add a remote server in Coolify (Servers → Add Server) to deploy to your VPS.",
            chosen_server_name
        );
    }

    // Create a Dockerfile application on Coolify. The Dockerfile clones the repo at
    // build time (see generate_clone_dockerfile), so the app source ends up in the image
    // without Coolify needing to clone anything itself.
    let create_url = format!("{}/api/v1/applications/dockerfile", base);
    // Coolify requires the dockerfile field base64-encoded.
    let dockerfile_b64 = base64::engine::general_purpose::STANDARD.encode(clone_dockerfile.as_bytes());

    let mut payload = serde_json::json!({
        "project_uuid": project_uuid,
        "server_uuid": server_uuid,
        "environment_name": "production",
        "name": req.app_name,
        // The manifest marker makes this app discoverable/adoptable by other Monastery
        // instances working from the same repo (see deploy_manifest.rs).
        "description": format!("Deployed from Monastery — project: {} [{}]", project_name, manifest.marker()),
        "build_pack": "dockerfile",
        "dockerfile": dockerfile_b64,
        "ports_exposes": port.to_string(),
        "base_directory": "/",
        // When wiring a Pocketbase env we must set it BEFORE the build, so defer the deploy
        // (instant_deploy=false) and trigger it explicitly after injecting the env.
        "instant_deploy": pocketbase_url.is_none(),
    });

    // Attach custom domain (Coolify API uses "domains", not "fqdn")
    if let Some(ref domain) = req.domain {
        if !domain.is_empty() {
            payload["domains"] = serde_json::Value::String(domain.clone());
        }
    }

    // Always publish the app on the host port so it's reachable on the LAN at
    // http://<server-ip>:<host_port> (and so a host-networked Cloudflare connector can
    // reach it). host_port avoids 80/443 to not collide with Coolify's proxy.
    payload["ports_mappings"] = serde_json::Value::String(format!("{}:{}", host_port, port));

    let resp = client
        .post(&create_url)
        .header("Authorization", format!("Bearer {}", api_token))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("Coolify API request failed: {}", e)))?;

    let coolify_status = resp.status();
    if !coolify_status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!(
            "Coolify returned HTTP {}: {}",
            coolify_status.as_u16(),
            if body.len() > 300 { format!("{}...", &body[..300]) } else { body }
        )));
    }

    let app: serde_json::Value = resp.json().await
        .map_err(|e| ApiError::Internal(format!("Failed to parse Coolify response: {}", e)))?;

    let app_uuid = app["uuid"].as_str().unwrap_or("unknown");

    // Remember this app so future deploys redeploy it in place instead of creating a new one.
    let _ = save_deployment(&state, req.project_id, req.connection_id, "coolify", app_uuid, &req.app_name, server_uuid).await;

    // Persist the portable identity + desired state into the repo.
    record_manifest_target(
        &project_path, &mut manifest, "coolify", &req.app_name,
        &git.branch, host_port, req.domain.as_deref(), tunnel_ref.as_ref(),
    );

    // Inject the shared Pocketbase URL (build-time + runtime) then deploy; otherwise
    // instant_deploy already queued the build.
    let deploy_success = if let Some(ref pb_url) = pocketbase_url {
        let _ = client
            .post(format!("{}/api/v1/applications/{}/envs", base, app_uuid))
            .header("Authorization", format!("Bearer {}", api_token))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({
                "key": "POCKETBASE_URL", "value": pb_url,
                "is_buildtime": true, "is_runtime": true,
            }))
            .send().await;
        let dep = client
            .get(format!("{}/api/v1/deploy?uuid={}&force=true", base, app_uuid))
            .header("Authorization", format!("Bearer {}", api_token))
            .send().await;
        matches!(dep, Ok(r) if r.status().is_success())
    } else {
        // instant_deploy=true queued the deployment automatically.
        coolify_status.is_success()
    };

    // Optionally launch a Cloudflare Tunnel connector as a sidecar Coolify Service so
    // the user doesn't have to run cloudflared themselves. A token tunnel is remotely
    // managed: the connector only needs the token; the public-hostname → service mapping
    // is still configured in the Cloudflare Zero Trust dashboard (point it at the
    // returned tunnel_service_url). The connector uses host networking so it can reach
    // the app published on the VPS host above.
    let mut tunnel_deployed = false;
    let mut tunnel_error: Option<String> = None;
    if req.include_cloudflare_tunnel {
        match effective_tunnel_token.as_deref() {
            Some(token) => {
                let compose = format!(
                    "services:\n  cloudflared:\n    image: cloudflare/cloudflared:latest\n    command: tunnel --no-autoupdate run\n    environment:\n      - TUNNEL_TOKEN={token}\n    network_mode: host\n    restart: unless-stopped\n",
                    token = token,
                );
                let compose_b64 = base64::engine::general_purpose::STANDARD.encode(compose.as_bytes());
                let svc_payload = serde_json::json!({
                    "project_uuid": project_uuid,
                    "server_uuid": server_uuid,
                    "environment_name": "production",
                    "name": format!("{}-cloudflared", req.app_name),
                    "description": format!("Cloudflare Tunnel connector for {} (Monastery)", req.app_name),
                    "docker_compose_raw": compose_b64,
                    "instant_deploy": true,
                });
                match client
                    .post(format!("{}/api/v1/services", base))
                    .header("Authorization", format!("Bearer {}", api_token))
                    .header("Content-Type", "application/json")
                    .json(&svc_payload)
                    .send()
                    .await
                {
                    Ok(r) if r.status().is_success() => { tunnel_deployed = true; }
                    Ok(r) => {
                        let status = r.status().as_u16();
                        let body = r.text().await.unwrap_or_default();
                        let snippet: String = body.chars().take(200).collect();
                        let msg = format!("Cloudflare connector deploy failed (HTTP {}): {}", status, snippet);
                        tracing::warn!("{}", msg);
                        tunnel_error = Some(msg);
                    }
                    Err(e) => {
                        let msg = format!("Cloudflare connector deploy request failed: {}", e);
                        tracing::warn!("{}", msg);
                        tunnel_error = Some(msg);
                    }
                }
            }
            None => {
                tunnel_error = Some("Cloudflare tunnel was requested but no token was provided — paste one in the wizard or save one under Settings → Hosting → Tunnel tokens.".into());
            }
        }
    }

    // Automated Cloudflare routing (Public Hostname + DNS) — best-effort, never fails
    // the deploy; the wizard shows manual instructions on routing_error.
    let (routing_configured, routing_error, routed_url) = run_cloudflare_routing(
        &state, cloudflare_api_token.as_deref(), tunnel_ref.as_ref(),
        req.domain.as_deref(), host_port,
    ).await;

    Ok(Json(serde_json::json!({
        "success": true,
        "platform": "coolify",
        "app_uuid": app_uuid,
        "app_name": req.app_name,
        "deploy_triggered": deploy_success,
        "redeployed": false,
        "adopted": adopted,
        "deploy_id": manifest.deploy_id,
        "branch_mismatch": branch_mismatch,
        "dashboard_url": format!("{}/projects", base.trim_end_matches("/api/v1")),
        "framework": framework,
        "port": port,
        "server": chosen_server_name,
        "server_is_localhost": is_localhost(chosen_server),
        "host_port": host_port,
        // Direct LAN URL — reachable without DNS once the build finishes and the
        // container is up. Uses the chosen server's IP.
        "access_url": chosen_server["ip"].as_str().map(|ip| format!("http://{}:{}", ip, host_port)),
        "tunnel_requested": req.include_cloudflare_tunnel,
        "tunnel_deployed": tunnel_deployed,
        "tunnel_error": tunnel_error,
        // The exact "Service" URL for a tunnel Public Hostname. ALWAYS returned (tunnel
        // toggle or not) so an app can be added to an existing tunnel after the fact.
        // Use 127.0.0.1 (not "localhost"): cloudflared resolves "localhost" to IPv6 ::1,
        // but the published host port binds on IPv4 — so localhost gives "connection refused".
        "host_service_url": format!("http://127.0.0.1:{}", host_port),
        "tunnel_service_url": format!("http://127.0.0.1:{}", host_port),
        "routing_configured": routing_configured,
        "routing_error": routing_error,
        "routed_url": routed_url,
        "pocketbase_url": pocketbase_url,
    })))
}
