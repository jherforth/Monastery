//! Deploying to Dokploy (custom git source + the committed Dockerfile). Maintenance-only — Coolify is
//! the primary target (decision D4 in docs/SIMPLIFICATION_PLAN.md).

use super::*;

/// Create or update the Dokploy app for this project and start a deployment.
pub(crate) async fn deploy(cx: DeployContext) -> Result<Json<serde_json::Value>, ApiError> {
    let DeployContext { state, req, base: base_url, api_token, effective_tunnel_token, project_name, project_path, framework, port, pocketbase_url, manifest_existed, mut manifest, cloudflare_api_token, client, .. } = cx;
    let base = base_url.as_str();
    let dockerfile_path = project_path.join("Dockerfile");
    // Dokploy clones a git source and builds its Dockerfile — it does NOT accept an inline
    // Dockerfile. So we point Dokploy at the project's repo (custom git, token-in-URL) and
    // ensure a Dockerfile is committed there. Dokploy's custom-git provider is permissive
    // (no host validation), so it works with a local IP/.local Forgejo.
    //
    // tRPC note: query procedures use GET, mutations POST `{ "json": input }`; the list
    // endpoints are `server.all` / `project.all` (no `*.list`); `project.all` returns each
    // project with its nested (auto-created "production") environments.
    let git = resolve_project_git(&state, &project_path).await?;

    // Pinned host port + tunnel identity + branch note (see the Coolify arm for details).
    let host_port: u16 = manifest
        .targets
        .get("dokploy")
        .map(|t| t.host_port)
        .unwrap_or_else(|| {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            req.app_name.hash(&mut h);
            20000 + (h.finish() % 10000) as u16
        });
    let tunnel_ref = effective_tunnel_token
        .as_deref()
        .and_then(crate::cloudflare::parse_tunnel_token)
        .or_else(|| {
            manifest
                .targets
                .get("dokploy")
                .and_then(|t| t.cloudflare.as_ref())
                .map(|c| c.tunnel_ref())
        });
    let branch_mismatch = manifest
        .targets
        .get("dokploy")
        .and_then(|t| t.branch.as_deref())
        .map(|b| b != git.branch)
        .unwrap_or(false);

    // Write the manifest BEFORE the pre-deploy push so the identity file rides the same
    // commit Dokploy clones — collaborators get it with the repo.
    record_manifest_target(
        &project_path, &mut manifest, "dokploy", &req.app_name,
        &git.branch, host_port, req.domain.as_deref(), tunnel_ref.as_ref(),
    );

    // Ensure the generated Dockerfile (written above if missing) and any local changes are
    // committed and pushed so Dokploy's clone includes them.
    if let Err(e) = harness_core::GitService::git_push(
        &project_path, &git.remote_url, &git.token, &git.branch,
        "Add/update Dockerfile for Dokploy deployment (Monastery)",
    ) {
        tracing::warn!("Could not push before Dokploy deploy (continuing; remote may be current): {}", e);
    }
    let git_repository = build_authed_clone_url(&git.remote_url, &git.token);

    // Resolve the app: local cache first, else adopt via the manifest marker
    // (cross-instance discovery — see the Coolify arm).
    let mut adopted = false;
    let mut existing = lookup_deployment(&state, req.project_id, req.connection_id).await?;
    if existing.is_none() && manifest_existed && manifest.targets.contains_key("dokploy") {
        if let Some(found_id) =
            discover_dokploy_app_by_marker(&client, base, &api_token, &manifest.marker()).await
        {
            tracing::info!("Adopted existing Dokploy app {} via deploy manifest marker", found_id);
            let _ = save_deployment(
                &state, req.project_id, req.connection_id, "dokploy",
                &found_id, &req.app_name, "",
            ).await;
            existing = Some(found_id);
            adopted = true;
        }
    }

    // Redeploy the SAME app if we've deployed this (project, connection) before. On 404
    // (app deleted in Dokploy) drop the stale mapping and fall through to recreate.
    if let Some(existing_app_id) = existing {
        let deploy_url = format!("{}/api/trpc/application.deploy", base);
        match client.post(&deploy_url)
            .header("x-api-key", &api_token).header("Content-Type", "application/json")
            .json(&serde_json::json!({ "json": { "applicationId": existing_app_id } }))
            .send().await
        {
            Ok(r) if r.status().is_success() => {
                if !manifest_existed {
                    // Legacy migration: stamp the marker so other instances can adopt.
                    // Best-effort — Dokploy's update schema varies across versions.
                    let _ = dokploy_mutation(&client, base, &api_token, "application.update", serde_json::json!({
                        "applicationId": existing_app_id,
                        "description": format!(
                            "Deployed from Monastery — project: {} [{}]",
                            project_name, manifest.marker()
                        ),
                    })).await;
                }
                let (routing_configured, routing_error, routed_url) = run_cloudflare_routing(
                    &state, cloudflare_api_token.as_deref(), tunnel_ref.as_ref(),
                    req.domain.as_deref(), host_port,
                ).await;
                return Ok(Json(serde_json::json!({
                    "success": true,
                    "platform": "dokploy",
                    "app_id": existing_app_id,
                    "app_name": req.app_name,
                    "deploy_triggered": true,
                    "redeployed": true,
                    "adopted": adopted,
                    "deploy_id": manifest.deploy_id,
                    "branch_mismatch": branch_mismatch,
                    "dashboard_url": format!("{}/dashboard/home", base.trim_end_matches("/api")),
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
            Ok(r) if r.status().as_u16() == 404 => {
                tracing::warn!("Dokploy app {} no longer exists (404) — recreating.", existing_app_id);
                let _ = sqlx::query("DELETE FROM deployments WHERE project_id = ? AND connection_id = ?")
                    .bind(req.project_id.to_string())
                    .bind(req.connection_id.to_string())
                    .execute(&*state.db).await;
            }
            Ok(r) => {
                let status = r.status().as_u16();
                let body = r.text().await.unwrap_or_default();
                let snippet: String = body.chars().take(200).collect();
                return Err(ApiError::Internal(format!("Dokploy redeploy failed (HTTP {}): {}", status, snippet)));
            }
            Err(e) => {
                return Err(ApiError::Internal(format!("Dokploy redeploy request failed: {}", e)));
            }
        }
    }

    // Helper to dig the payload out of a tRPC/superjson response envelope.
    fn trpc_array(data: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
        data["result"]["data"]["json"].as_array()
            .or_else(|| data["result"]["data"].as_array())
            .or_else(|| data["result"].as_array())
    }

    // Step 1: Fetch servers (GET query) → serverId
    let server_url = format!("{}/api/trpc/server.all", base);
    let server_resp = client
        .get(&server_url)
        .header("x-api-key", &api_token)
        .send()
        .await;

    let (server_id, server_ip) = match server_resp {
        Ok(resp) if resp.status().is_success() => {
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            let servers = trpc_array(&data).cloned().unwrap_or_default();
            // Honor an explicitly chosen server; otherwise use the first one.
            let pick = req.server_uuid.as_deref()
                .and_then(|want| servers.iter().find(|s| {
                    s["serverId"].as_str().or_else(|| s["id"].as_str()) == Some(want)
                }))
                .or_else(|| servers.first());
            let id = pick.and_then(|srv| srv["serverId"].as_str().or_else(|| srv["id"].as_str()))
                .map(|s| s.to_string());
            let ip = pick.and_then(|srv| srv["ipAddress"].as_str().or_else(|| srv["ip"].as_str()))
                .map(|s| s.to_string());
            (id, ip)
        }
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            tracing::warn!("Dokploy server fetch failed (HTTP {}): {}", status, body);
            (None, None)
        }
        Err(e) => {
            tracing::warn!("Dokploy server fetch error: {}", e);
            (None, None)
        }
    };

    // Step 2: Fetch projects (GET query). Take the first project and its first
    // (auto-created) environment.
    let proj_url = format!("{}/api/trpc/project.all", base);
    let proj_resp = client
        .get(&proj_url)
        .header("x-api-key", &api_token)
        .send()
        .await;

    let (project_id, mut env_id) = match proj_resp {
        Ok(resp) if resp.status().is_success() => {
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            match trpc_array(&data).and_then(|arr| arr.first()) {
                Some(project) => {
                    let pid = project["projectId"].as_str()
                        .or_else(|| project["id"].as_str())
                        .map(|s| s.to_string());
                    let eid = project["environments"].as_array()
                        .and_then(|envs| envs.first())
                        .and_then(|e| e["environmentId"].as_str().or_else(|| e["id"].as_str()))
                        .map(|s| s.to_string());
                    (pid, eid)
                }
                None => (None, None),
            }
        }
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            tracing::warn!("Dokploy project fetch failed (HTTP {}): {}", status, body);
            (None, None)
        }
        Err(e) => {
            tracing::warn!("Dokploy project fetch error: {}", e);
            (None, None)
        }
    };

    // Require at least one project. (We use the first project returned.)
    let project_id = match project_id {
        Some(p) => p,
        None => {
            return Err(ApiError::Config(
                "Dokploy deployment requires at least one project. Create a project in Dokploy first — it includes a default 'production' environment.".into(),
            ));
        }
    };

    // Step 3: If project.all didn't include the environment, fetch it explicitly
    // via environment.byProjectId (GET query with input).
    if env_id.is_none() {
        let input = serde_json::json!({ "json": { "projectId": project_id } }).to_string();
        let env_url = format!("{}/api/trpc/environment.byProjectId", base);
        if let Ok(resp) = client
            .get(&env_url)
            .header("x-api-key", &api_token)
            .query(&[("input", input.as_str())])
            .send()
            .await
        {
            if resp.status().is_success() {
                let data: serde_json::Value = resp.json().await.unwrap_or_default();
                env_id = trpc_array(&data)
                    .and_then(|arr| arr.first())
                    .and_then(|e| e["environmentId"].as_str().or_else(|| e["id"].as_str()))
                    .map(|s| s.to_string());
            }
        }
    }

    // Step 4: Ensure we have all required IDs before building the payload
    let env_id = match env_id {
        Some(id) => id,
        None => {
            return Err(ApiError::Config(
                "Could not determine a Dokploy environmentId for the project. Verify the project has an environment in Dokploy.".into(),
            ));
        }
    };
    let server_id = match server_id {
        Some(id) => id,
        None => {
            return Err(ApiError::Config(
                "Could not determine a Dokploy serverId. Verify your Dokploy instance has at least one server connected.".into(),
            ));
        }
    };

    // Step 6: Create the application (only name/appName/description/environmentId/serverId
    // are accepted — source & build are configured in the next two calls).
    let create_body = dokploy_mutation(&client, base, &api_token, "application.create", serde_json::json!({
        "name": req.app_name,
        "appName": req.app_name,
        // The manifest marker makes this app discoverable/adoptable by other Monastery
        // instances working from the same repo (see deploy_manifest.rs).
        "description": format!("Deployed from Monastery — project: {} [{}]", project_name, manifest.marker()),
        "environmentId": env_id,
        "serverId": server_id,
    })).await?;

    let app_id = create_body["result"]["data"]["json"]["applicationId"].as_str()
        .or_else(|| create_body["result"]["data"]["json"]["appId"].as_str())
        .or_else(|| create_body["result"]["data"]["json"]["id"].as_str())
        .ok_or_else(|| ApiError::Internal("Dokploy application.create returned no applicationId".into()))?
        .to_string();

    // Step 7: Point the app at the project's git repo (custom git, token-in-URL). Without a
    // source, Dokploy defaults to a GitHub provider that doesn't exist ("Github Provider not
    // found") and the container shows "select-a-container".
    dokploy_mutation(&client, base, &api_token, "application.saveGitProvider", serde_json::json!({
        "applicationId": app_id,
        "customGitUrl": git_repository,
        "customGitBranch": git.branch,
        "customGitBuildPath": "/",
        // Dokploy's schema marks these required (.required()), even though we don't use them.
        "watchPaths": [],
        "enableSubmodules": false,
    })).await?;

    // Step 8: Build from the Dockerfile committed in the repo.
    dokploy_mutation(&client, base, &api_token, "application.saveBuildType", serde_json::json!({
        "applicationId": app_id,
        "buildType": "dockerfile",
        "dockerfile": "Dockerfile",
        "dockerContextPath": ".",
        // Required-but-unused for a dockerfile build (Dokploy's schema uses .required()).
        "dockerBuildStage": "",
        "herokuVersion": "",
        "railpackVersion": "",
    })).await?;

    // Step 8.5: Wire the shared Pocketbase URL as both runtime env and build arg (frontend
    // apps bake env at build time). Must happen before the deploy/build.
    if let Some(ref pb_url) = pocketbase_url {
        let pb_line = format!("POCKETBASE_URL={}\n", pb_url);
        if let Err(e) = dokploy_mutation(&client, base, &api_token, "application.saveEnvironment", serde_json::json!({
            "applicationId": app_id,
            "env": pb_line,
            "buildArgs": pb_line,
            "buildSecrets": "",
            "createEnvFile": false,
        })).await {
            tracing::warn!("Dokploy saveEnvironment (POCKETBASE_URL) failed: {:?}", e);
        }
    }

    // (host_port was pinned/derived above, before the manifest write.)
    let mut tunnel_error: Option<String> = None;

    // The container port the app actually listens on = the LAST `EXPOSE` in the Dockerfile
    // (final stage), which is more reliable than the wizard "Port" for a repo Dockerfile.
    // Fall back to the wizard port if there's no EXPOSE.
    let container_port = std::fs::read_to_string(&dockerfile_path).ok()
        .and_then(|df| df.lines().rev().find_map(|l| {
            l.trim().strip_prefix("EXPOSE ")
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|p| p.split('/').next())
                .and_then(|p| p.parse::<u16>().ok())
        }))
        .unwrap_or(port);

    // Always publish the app's port on the host BEFORE deploying (Swarm applies port
    // mappings at deploy time). Previously this only happened when the tunnel toggle was
    // on — but the published port is what makes host_service_url truthful, lets the app
    // be added to an existing tunnel later, and matches the Coolify arm's behavior.
    if let Err(e) = dokploy_mutation(&client, base, &api_token, "port.create", serde_json::json!({
        "applicationId": app_id,
        "publishedPort": host_port,
        "targetPort": container_port,
        "publishMode": "host",
        "protocol": "tcp",
    })).await {
        let msg = format!("port publish failed: {:?}", e);
        tracing::warn!("Dokploy {}", msg);
        if req.include_cloudflare_tunnel { tunnel_error = Some(msg); }
    }

    // Step 9: Trigger the deploy (clones the repo, builds the Dockerfile, applies the port).
    let deploy_success = dokploy_mutation(&client, base, &api_token, "application.deploy",
        serde_json::json!({ "applicationId": app_id })).await.is_ok();

    // Remember this app so future deploys redeploy it in place.
    let _ = save_deployment(&state, req.project_id, req.connection_id, "dokploy", &app_id, &req.app_name, &server_id).await;

    // Deploy the cloudflared connector as a Dokploy compose service (raw compose, host
    // networking) after the app. Best-effort: failures don't fail the main deploy.
    let mut tunnel_deployed = false;
    if req.include_cloudflare_tunnel {
        match effective_tunnel_token.as_deref() {
            Some(token) => {
                let compose_yaml = format!(
                    "services:\n  cloudflared:\n    image: cloudflare/cloudflared:latest\n    command: tunnel --no-autoupdate run\n    environment:\n      - TUNNEL_TOKEN={token}\n    network_mode: host\n    restart: unless-stopped\n",
                    token = token,
                );
                let svc_name = format!("{}-cloudflared", req.app_name);
                let created = dokploy_mutation(&client, base, &api_token, "compose.create", serde_json::json!({
                    "name": svc_name,
                    "appName": svc_name,
                    "description": format!("Cloudflare Tunnel connector for {} (Monastery)", req.app_name),
                    "environmentId": env_id,
                    "serverId": server_id,
                    "composeType": "docker-compose",
                    "composeFile": compose_yaml,
                })).await;
                match created {
                    Ok(body) => {
                        let compose_id = body["result"]["data"]["json"]["composeId"].as_str()
                            .or_else(|| body["result"]["data"]["json"]["id"].as_str())
                            .map(|s| s.to_string());
                        match compose_id {
                            Some(cid) => {
                                // Mark it a raw compose (default sourceType is github) and set the file.
                                let _ = dokploy_mutation(&client, base, &api_token, "compose.update", serde_json::json!({
                                    "composeId": cid, "sourceType": "raw", "composeFile": compose_yaml,
                                })).await;
                                match dokploy_mutation(&client, base, &api_token, "compose.deploy", serde_json::json!({ "composeId": cid })).await {
                                    Ok(_) => { tunnel_deployed = true; }
                                    Err(e) => { if tunnel_error.is_none() { tunnel_error = Some(format!("{:?}", e)); } }
                                }
                            }
                            None => { if tunnel_error.is_none() { tunnel_error = Some("compose.create returned no composeId".into()); } }
                        }
                    }
                    Err(e) => { if tunnel_error.is_none() { tunnel_error = Some(format!("{:?}", e)); } }
                }
            }
            None => { tunnel_error = Some("Cloudflare tunnel was requested but no token was provided — paste one in the wizard or save one under Settings → Hosting → Tunnel tokens.".into()); }
        }
    }

    // Automated Cloudflare routing (Public Hostname + DNS) — best-effort.
    let (routing_configured, routing_error, routed_url) = run_cloudflare_routing(
        &state, cloudflare_api_token.as_deref(), tunnel_ref.as_ref(),
        req.domain.as_deref(), host_port,
    ).await;

    Ok(Json(serde_json::json!({
        "success": true,
        "platform": "dokploy",
        "app_id": app_id,
        "app_name": req.app_name,
        "deploy_triggered": deploy_success,
        "redeployed": false,
        "adopted": adopted,
        "deploy_id": manifest.deploy_id,
        "branch_mismatch": branch_mismatch,
        "dashboard_url": format!("{}/dashboard/home", base.trim_end_matches("/api")),
        "framework": framework,
        "port": port,
        "host_port": host_port,
        // The port is now always published, so the LAN URL is always real.
        "access_url": server_ip.as_ref().map(|ip| format!("http://{}:{}", ip, host_port)),
        "tunnel_requested": req.include_cloudflare_tunnel,
        "tunnel_deployed": tunnel_deployed,
        "tunnel_error": tunnel_error,
        // Always returned (tunnel toggle or not) — see the Coolify arm for the
        // 127.0.0.1-vs-localhost rationale.
        "host_service_url": format!("http://127.0.0.1:{}", host_port),
        "tunnel_service_url": format!("http://127.0.0.1:{}", host_port),
        "routing_configured": routing_configured,
        "routing_error": routing_error,
        "routed_url": routed_url,
        "pocketbase_url": pocketbase_url,
    })))
}
