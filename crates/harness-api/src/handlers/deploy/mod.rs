//! Deploying a project to a hosting platform.

use super::*;

mod dockerfile;
pub(crate) use dockerfile::*;
mod coolify;
mod dokploy;

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct DeployRequest {
    pub connection_id: uuid::Uuid,
    pub project_id: uuid::Uuid,
    pub app_name: String,
    /// Target server to deploy to. When the platform has multiple servers, the UI lets
    /// the user pick one (its uuid for Coolify / serverId for Dokploy). When omitted,
    /// the backend auto-selects a usable, non-localhost server.
    #[serde(default)]
    pub server_uuid: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub include_pocketbase: bool,
    #[serde(default)]
    pub pocketbase_connection_id: Option<uuid::Uuid>,
    #[serde(default)]
    pub include_cloudflare_tunnel: bool,
    #[serde(default)]
    pub cloudflare_tunnel_token: Option<String>,
    /// Cloudflare API connection for automated tunnel routing (Public Hostname + DNS).
    /// When omitted, the backend falls back to the newest 'cloudflare' hosting connection.
    #[serde(default)]
    pub cloudflare_connection_id: Option<uuid::Uuid>,
}

/// Preview generated deploy files without actually deploying
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct PreviewDeployRequest {
    pub project_id: uuid::Uuid,
    #[serde(default)]
    pub include_pocketbase: bool,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub include_cloudflare_tunnel: bool,
    #[serde(default)]
    pub cloudflare_tunnel_token: Option<String>,
}

pub async fn preview_deploy(
    State(state): State<AppState>,
    Json(req): Json<PreviewDeployRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project = ProjectCtx::load(&state, req.project_id).await?;
    let project_name = project.name.clone();

    let project_path = project.dir.clone();
    if !project_path.exists() {
        return Err(ApiError::NotFound(format!("Project directory not found: {:?}", project_path)));
    }

    let (framework, build_cmd, output_dir, default_port) = detect_framework(&project_path);
    let port = req.port.unwrap_or(default_port);
    let dockerfile = generate_dockerfile(&framework, &build_cmd, &output_dir, port);
    let app_name = req.app_name.unwrap_or_else(|| project_name.clone());

    let mut files: Vec<serde_json::Value> = vec![
        serde_json::json!({
            "name": "Dockerfile",
            "content": dockerfile,
            "language": "dockerfile"
        }),
    ];

    // Generate docker-compose.yml if Pocketbase or Cloudflare Tunnel is included
    let needs_compose = req.include_pocketbase || req.include_cloudflare_tunnel;
    if needs_compose {
        let compose = generate_docker_compose(
            &app_name, port,
            req.include_pocketbase,
            req.include_cloudflare_tunnel,
        );
        files.push(serde_json::json!({
            "name": "docker-compose.yml",
            "content": compose,
            "language": "yaml"
        }));
    }

    // The port the deployed CONTAINER will actually listen on — same rule the Coolify deploy
    // uses (generate_clone_dockerfile): nginx-served frameworks are always 80 regardless of the
    // wizard's Port field; Node-server frameworks use the requested port. Surfacing this in the
    // preview is what lets the wizard warn when the user's Port entry will be ignored — the
    // field-found failure mode was a port mapping targeting :3000 while nginx served :80.
    let container_port: u16 = match framework.as_str() {
        "nextjs" | "express" | "fastify" | "node" => port,
        _ => 80, // vite-react | vue | react | static | unknown → nginx
    };

    Ok(Json(serde_json::json!({
        "framework": framework,
        "build_command": build_cmd,
        "output_dir": output_dir,
        "default_port": default_port,
        "port": port,
        "container_port": container_port,
        "app_name": app_name,
        "files": files,
    })))
}

/// Git info needed to deploy a project from its forge repository.
pub(crate) struct GitDeployInfo {
    pub(crate) remote_url: String,
    pub(crate) branch: String,
    pub(crate) token: String,
}

/// Extract the host (and optional port) from a URL string without pulling in a URL crate.
pub(crate) fn url_host(url: &str) -> Option<String> {
    let after_scheme = url.split("://").nth(1)?;
    // Strip any userinfo (user:pass@) then take up to the first '/'.
    let authority = after_scheme.splitn(2, '/').next()?;
    let host = authority.rsplitn(2, '@').next()?; // part after '@' if present, else whole
    Some(host.to_string())
}

/// Build an authenticated clone URL using the forge token, for the in-Dockerfile `git clone`.
/// Uses the `oauth2:<token>@` form Forgejo/Gitea/GitLab accept, for both https and http (some
/// all-local forges are HTTP-only). Leaves SSH or already-credentialed URLs untouched.
pub(crate) fn build_authed_clone_url(remote_url: &str, token: &str) -> String {
    if remote_url.contains('@') {
        remote_url.to_string()
    } else if let Some(rest) = remote_url.strip_prefix("https://") {
        format!("https://oauth2:{}@{}", token, rest)
    } else if let Some(rest) = remote_url.strip_prefix("http://") {
        format!("http://oauth2:{}@{}", token, rest)
    } else {
        remote_url.to_string()
    }
}

/// Resolve the project's git remote, branch, and a matching forge token (for clone auth).
pub(crate) async fn resolve_project_git(
    state: &AppState,
    project_path: &std::path::Path,
) -> Result<GitDeployInfo, ApiError> {
    use sqlx::Row;
    let status = harness_core::GitService::git_status(project_path).map_err(ApiError::Core)?;
    let remote_url = status.remote_url.ok_or_else(|| ApiError::Config(
        "This project has no git remote. Push it to your git forge first — the deploy clones the app from there.".into()
    ))?;
    let branch = if status.branch.trim().is_empty() { "main".to_string() } else { status.branch };

    // Find a forge connection token matching the remote's host; fall back to the most recent.
    let host = url_host(&remote_url);
    let rows = sqlx::query("SELECT api_token, base_url FROM git_connections ORDER BY created_at DESC")
        .fetch_all(&*state.db)
        .await?;
    let mut token: Option<String> = None;
    if let Some(h) = host.as_deref() {
        for r in &rows {
            let bu: String = r.get(1);
            if bu.contains(h) { token = Some(r.get::<String, _>(0)); break; }
        }
    }
    if token.is_none() {
        token = rows.first().map(|r| r.get::<String, _>(0));
    }
    let token = token.ok_or_else(|| ApiError::Config(
        "No git forge connection found to authenticate the repo clone. Connect your forge in Settings first.".into()
    ))?;

    Ok(GitDeployInfo { remote_url, branch, token })
}

/// Look up the remote app uuid previously deployed for this (project, connection), if any.
pub(crate) async fn lookup_deployment(
    state: &AppState,
    project_id: uuid::Uuid,
    connection_id: uuid::Uuid,
) -> Result<Option<String>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT app_uuid FROM deployments WHERE project_id = ? AND connection_id = ?")
        .bind(project_id.to_string())
        .bind(connection_id.to_string())
        .fetch_optional(&*state.db)
        .await?;
    Ok(row.map(|r| r.get::<String, _>(0)))
}

/// Persist (or update) the app uuid deployed for this (project, connection).
pub(crate) async fn save_deployment(
    state: &AppState,
    project_id: uuid::Uuid,
    connection_id: uuid::Uuid,
    platform: &str,
    app_uuid: &str,
    app_name: &str,
    server_uuid: &str,
) -> Result<(), ApiError> {
    let now = chrono::Utc::now().to_rfc3339();
    // Upsert on the (project_id, connection_id) unique constraint.
    sqlx::query(
        "INSERT INTO deployments (id, project_id, connection_id, platform, app_uuid, app_name, server_uuid, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(project_id, connection_id) DO UPDATE SET \
           app_uuid = excluded.app_uuid, app_name = excluded.app_name, server_uuid = excluded.server_uuid, updated_at = excluded.updated_at"
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(project_id.to_string())
    .bind(connection_id.to_string())
    .bind(platform)
    .bind(app_uuid)
    .bind(app_name)
    .bind(server_uuid)
    .bind(&now)
    .bind(&now)
    .execute(&*state.db)
    .await?;
    Ok(())
}

/// Update the deploy manifest's target entry for a platform and write it into the project dir.
/// Best-effort persistence: a failed write logs a warning but never fails the deploy.
pub(crate) fn record_manifest_target(
    project_path: &std::path::Path,
    manifest: &mut crate::deploy_manifest::DeployManifest,
    platform: &str,
    app_name: &str,
    branch: &str,
    host_port: u16,
    domain: Option<&str>,
    tunnel: Option<&crate::cloudflare::TunnelRef>,
) {
    {
        let entry = manifest
            .targets
            .entry(platform.to_string())
            .or_insert_with(|| crate::deploy_manifest::TargetState {
                app_name: app_name.to_string(),
                branch: None,
                host_port,
                domain: None,
                cloudflare: None,
            });
        entry.app_name = app_name.to_string();
        entry.branch = Some(branch.to_string());
        entry.host_port = host_port;
        if let Some(d) = domain.filter(|d| !d.is_empty()) {
            entry.domain = Some(d.to_string());
        }
        if let Some(t) = tunnel {
            let hostname = domain
                .filter(|d| !d.is_empty())
                .map(str::to_string)
                .or_else(|| entry.cloudflare.as_ref().and_then(|c| c.hostname.clone()));
            entry.cloudflare = Some(crate::deploy_manifest::CloudflareState {
                account_id: t.account_id.clone(),
                tunnel_id: t.tunnel_id.clone(),
                hostname,
            });
        }
    }
    if let Err(e) = crate::deploy_manifest::save(project_path, manifest) {
        tracing::warn!("Deploy manifest not written: {}", e);
    }
}

/// Run Cloudflare routing automation (ingress rule + proxied CNAME), best-effort.
/// Returns (routing_configured, routing_error, routed_url) for the DeployResult. All-None means
/// routing wasn't applicable (no domain, or no tunnel identity to route through).
pub(crate) async fn run_cloudflare_routing(
    state: &AppState,
    api_token: Option<&str>,
    tunnel: Option<&crate::cloudflare::TunnelRef>,
    domain: Option<&str>,
    host_port: u16,
) -> (Option<bool>, Option<String>, Option<String>) {
    let Some(domain) = domain.filter(|d| !d.is_empty()) else { return (None, None, None) };
    let Some(tun) = tunnel else { return (None, None, None) };
    let Some(token) = api_token else {
        return (
            Some(false),
            Some("No Cloudflare connection configured — add one in Settings → Hosting to automate Public Hostname + DNS, or add them manually in the Zero Trust dashboard.".into()),
            None,
        );
    };
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build() {
        Ok(c) => c,
        Err(e) => return (Some(false), Some(format!("Failed to build HTTP client: {}", e)), None),
    };
    // The ingress list is replaced wholesale (read-modify-write) — serialize against other
    // Monastery deploys so parallel writers can't drop each other's rules.
    let _guard = state.cloudflare_config_lock.lock().await;
    match crate::cloudflare::ensure_routing(&client, token, tun, domain, host_port).await {
        Ok(url) => (Some(true), None, Some(url)),
        Err(e) => {
            tracing::warn!("Cloudflare routing automation failed: {}", e);
            (Some(false), Some(e), None)
        }
    }
}

/// Cross-instance discovery: find a Coolify application whose description carries the deploy
/// manifest marker. Returns (app_uuid, server_uuid_if_present).
pub(crate) async fn discover_coolify_app_by_marker(
    client: &reqwest::Client,
    base: &str,
    api_token: &str,
    marker: &str,
) -> Option<(String, Option<String>)> {
    let resp = client
        .get(format!("{}/api/v1/applications", base))
        .header("Authorization", format!("Bearer {}", api_token))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let apps: Vec<serde_json::Value> = resp.json().await.ok()?;
    let app = apps.iter().find(|a| {
        a["description"].as_str().map(|d| d.contains(marker)).unwrap_or(false)
    })?;
    let uuid = app["uuid"].as_str()?.to_string();
    let server = app["server_uuid"]
        .as_str()
        .or_else(|| app["destination"]["server"]["uuid"].as_str())
        .map(str::to_string);
    Some((uuid, server))
}

/// Cross-instance discovery for Dokploy: walk project.all → environments → applications and
/// match the manifest marker in each application's description.
pub(crate) async fn discover_dokploy_app_by_marker(
    client: &reqwest::Client,
    base: &str,
    api_token: &str,
    marker: &str,
) -> Option<String> {
    let resp = client
        .get(format!("{}/api/trpc/project.all", base))
        .header("x-api-key", api_token)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let data: serde_json::Value = resp.json().await.ok()?;
    let projects = data["result"]["data"]["json"]
        .as_array()
        .or_else(|| data["result"]["data"].as_array())
        .or_else(|| data["result"].as_array())?;
    for project in projects {
        let envs = project["environments"].as_array().cloned().unwrap_or_default();
        for env in envs {
            let apps = env["applications"].as_array().cloned().unwrap_or_default();
            for app in apps {
                if app["description"].as_str().map(|d| d.contains(marker)).unwrap_or(false) {
                    if let Some(id) = app["applicationId"].as_str().or_else(|| app["id"].as_str()) {
                        return Some(id.to_string());
                    }
                }
            }
        }
    }
    None
}

/// POST a Dokploy tRPC mutation (`{ "json": input }`) and return the parsed response, mapping a
/// non-2xx tRPC error into a readable `ApiError` (so failures like a missing source provider surface
/// clearly instead of only showing up later in Dokploy's build logs).
pub(crate) async fn dokploy_mutation(
    client: &reqwest::Client,
    base: &str,
    api_token: &str,
    procedure: &str,
    input: serde_json::Value,
) -> Result<serde_json::Value, ApiError> {
    let url = format!("{}/api/trpc/{}", base, procedure);
    let resp = client
        .post(&url)
        .header("x-api-key", api_token)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "json": input }))
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("Dokploy {} request failed: {}", procedure, e)))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    if !status.is_success() {
        let msg = body["error"]["json"]["message"].as_str()
            .or_else(|| body["message"].as_str())
            .unwrap_or("unknown error");
        return Err(ApiError::Internal(format!(
            "Dokploy {} failed (HTTP {}): {}", procedure, status.as_u16(), msg
        )));
    }
    Ok(body)
}

/// Resolve the Pocketbase URL to wire into a deploy: the `base_url` of the configured Pocketbase
/// hosting connection (the "one shared Pocketbase" model). Returns None when the deploy didn't
/// request Pocketbase or no connection is configured.
pub(crate) async fn resolve_pocketbase_url(state: &AppState, req: &DeployRequest) -> Option<String> {
    use sqlx::Row;
    if !req.include_pocketbase {
        return None;
    }
    // Prefer the explicitly chosen connection; otherwise fall back to any pocketbase connection.
    let row = if let Some(id) = req.pocketbase_connection_id {
        sqlx::query("SELECT base_url FROM hosting_connections WHERE id = ? AND service_type = 'pocketbase'")
            .bind(id.to_string())
            .fetch_optional(&*state.db).await.ok().flatten()
    } else {
        sqlx::query("SELECT base_url FROM hosting_connections WHERE service_type = 'pocketbase' ORDER BY created_at DESC LIMIT 1")
            .fetch_optional(&*state.db).await.ok().flatten()
    };
    row.map(|r| r.get::<String, _>(0).trim_end_matches('/').to_string())
}

/// Coolify stores a deployment's `logs` as a JSON-encoded string of `[{ "output": "...", ... }]`.
/// Flatten it to plain text (or pass through if it's already text/an array).
pub(crate) fn coolify_logs_to_text(v: &serde_json::Value) -> String {
    let lines_from = |arr: &Vec<serde_json::Value>| {
        arr.iter().filter_map(|e| e["output"].as_str().map(|s| s.to_string())).collect::<Vec<_>>().join("\n")
    };
    if let Some(s) = v.as_str() {
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(s) {
            return lines_from(&arr);
        }
        return s.to_string();
    }
    if let Some(arr) = v.as_array() {
        return lines_from(arr);
    }
    String::new()
}

/// Char-safe tail of a string (keep the last `max` chars).
pub(crate) fn tail_chars(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        s.to_string()
    } else {
        format!("…(truncated)…\n{}", chars[chars.len() - max..].iter().collect::<String>())
    }
}

/// Fetch the latest deployment's status + build log for an app on a hosting connection, so the UI
/// can hand a failed build to the connected LLM to fix. Query param: `?app=<app uuid/id>`.
pub async fn get_deployment_log(
    Path(id): Path<uuid::Uuid>,
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let app = params.get("app").cloned().unwrap_or_default();
    if app.is_empty() {
        return Err(ApiError::Config("Missing 'app' query parameter".into()));
    }
    let row = sqlx::query("SELECT service_type, base_url, api_token FROM hosting_connections WHERE id = ?")
        .bind(id.to_string())
        .fetch_optional(&*state.db).await?;
    let (service_type, base_url, api_token) = match row {
        Some(r) => (r.get::<String, _>(0), r.get::<String, _>(1), r.get::<String, _>(2)),
        None => return Err(ApiError::NotFound("Hosting connection not found".into())),
    };
    let base = base_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| ApiError::Internal(format!("Failed to build HTTP client: {}", e)))?;

    match service_type.as_str() {
        "coolify" => {
            let resp = client
                .get(format!("{}/api/v1/deployments/applications/{}?take=1", base, app))
                .header("Authorization", format!("Bearer {}", api_token))
                .send().await
                .map_err(|e| ApiError::Internal(format!("Coolify deployments request failed: {}", e)))?;
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            // Response may be an array, or { deployments: [...] }.
            let latest = body.as_array().and_then(|a| a.first())
                .or_else(|| body["deployments"].as_array().and_then(|a| a.first()))
                .cloned().unwrap_or_default();
            let status = latest["status"].as_str().unwrap_or("unknown").to_string();
            let logs = tail_chars(&coolify_logs_to_text(&latest["logs"]), 8000);
            let detail = format!("deployment_uuid={} | status={}", latest["deployment_uuid"].as_str().unwrap_or("(none)"), status);
            Ok(Json(serde_json::json!({ "status": status, "logs": logs, "detail": detail })))
        }
        "dokploy" => {
            // Fetch the application itself — `application.one` embeds its `deployments`, validates
            // the id (throws NOT_FOUND if stale), and is a single call. More reliable than
            // `deployment.all`, which silently returns [] for a mismatched/absent applicationId.
            let one_input = serde_json::json!({ "json": { "applicationId": app } }).to_string();
            let resp = client
                .get(format!("{}/api/trpc/application.one", base))
                .header("x-api-key", &api_token)
                .query(&[("input", one_input.as_str())])
                .send().await
                .map_err(|e| ApiError::Internal(format!("Dokploy application.one failed: {}", e)))?;
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            // Surface a tRPC error (e.g. NOT_FOUND for a stale app id, or auth) so it's not
            // mistaken for "no logs".
            if let Some(err) = data["error"]["json"]["message"].as_str()
                .or_else(|| data["error"]["message"].as_str())
            {
                return Err(ApiError::Internal(format!("Dokploy application.one error: {} (app id sent: {})", err, app)));
            }
            // Envelope varies (superjson `result.data.json` vs plain `result.data`).
            let appobj = if data["result"]["data"]["json"].is_object() {
                &data["result"]["data"]["json"]
            } else {
                &data["result"]["data"]
            };
            let mut list = appobj["deployments"].as_array().cloned().unwrap_or_default();
            // `deployments: true` has no orderBy, so sort newest-first ourselves.
            list.sort_by(|a, b| b["createdAt"].as_str().unwrap_or("").cmp(a["createdAt"].as_str().unwrap_or("")));
            if list.is_empty() {
                return Ok(Json(serde_json::json!({
                    "status": "no-deployments",
                    "logs": format!("Dokploy has no deployment records for application '{}' (it was found, but no builds are recorded). Trigger a deploy, then retry.", app),
                })));
            }
            let latest = list.first().cloned().unwrap_or_default();
            let status = latest["status"].as_str().unwrap_or("unknown").to_string();
            let deployment_id = latest["deploymentId"].as_str().unwrap_or("").to_string();
            // Read the deployment's log file. Capture any tRPC error instead of swallowing it —
            // readLogs SSHes to the deployment's server (execAsyncRemote) and can fail there.
            let mut logs = String::new();
            let mut readlogs_err: Option<String> = None;
            let mut readlogs_raw: Option<String> = None;
            if !deployment_id.is_empty() {
                let logs_input = serde_json::json!({ "json": { "deploymentId": deployment_id, "tail": 300 } }).to_string();
                match client.get(format!("{}/api/trpc/deployment.readLogs", base))
                    .header("x-api-key", &api_token)
                    .query(&[("input", logs_input.as_str())])
                    .send().await
                {
                    Ok(r) => {
                        // Capture the raw body so we can see exactly what readLogs returned when it
                        // looks empty (e.g. IS_CLOUD short-circuit vs an unexpected envelope).
                        let raw = r.text().await.unwrap_or_default();
                        let d: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
                        if let Some(err) = d["error"]["json"]["message"].as_str()
                            .or_else(|| d["error"]["message"].as_str())
                        {
                            readlogs_err = Some(err.to_string());
                        } else {
                            logs = d["result"]["data"]["json"].as_str()
                                .or_else(|| d["result"]["data"].as_str())
                                .unwrap_or("").to_string();
                        }
                        if logs.trim().is_empty() && readlogs_err.is_none() {
                            readlogs_raw = Some(raw.chars().take(400).collect::<String>().replace('\n', "\\n"));
                        }
                    }
                    Err(e) => readlogs_err = Some(e.to_string()),
                }
            }
            // If the log file came back empty, fall back to the deployment's recorded errorMessage
            // (real failure info, worth sending to the LLM).
            if logs.trim().is_empty() {
                if let Some(err_msg) = latest["errorMessage"].as_str().filter(|s| !s.trim().is_empty()) {
                    logs = format!("Deployment status: {}\nError: {}", status, err_msg);
                }
            }
            // Always provide a diagnostic `detail` so a blank log isn't a dead end — it shows why
            // (readLogs error, where the log lives, which server) directly in the UI.
            let detail = format!(
                "deploymentId={} | logPath={} | serverId={} | readLogsError={} | rawResp={}",
                deployment_id,
                latest["logPath"].as_str().unwrap_or("(none)"),
                latest["serverId"].as_str().unwrap_or("(local)"),
                readlogs_err.as_deref().unwrap_or("none"),
                readlogs_raw.as_deref().unwrap_or("(had-content-or-not-fetched)"),
            );
            Ok(Json(serde_json::json!({
                "status": status,
                "logs": tail_chars(&logs, 8000),
                "detail": detail,
            })))
        }
        other => Err(ApiError::Config(format!("Deployment logs not supported for '{}'.", other))),
    }
}

/// Everything a platform deploy needs, resolved once by `deploy_to_hosting`.
pub(crate) struct DeployContext {
    pub state: AppState,
    pub req: DeployRequest,
    /// Platform base URL, without a trailing slash.
    pub base: String,
    pub api_token: String,
    /// Wizard-pasted tunnel token, else the one saved on the connection.
    pub effective_tunnel_token: Option<String>,
    pub project_name: String,
    pub project_path: std::path::PathBuf,
    pub framework: String,
    pub output_dir: String,
    pub port: u16,
    pub pocketbase_url: Option<String>,
    pub manifest_existed: bool,
    pub manifest: crate::deploy_manifest::DeployManifest,
    pub cloudflare_api_token: Option<String>,
    pub client: reqwest::Client,
}

/// Deploy a project to a connected hosting service: resolve the connection, project, framework,
/// manifest and routing inputs once, then hand off to the platform module.
pub async fn deploy_to_hosting(
    State(state): State<AppState>,
    Json(req): Json<DeployRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Look up the hosting connection
    let conn_row = sqlx::query(
        "SELECT service_type, base_url, api_token, tunnel_token FROM hosting_connections WHERE id = ?"
    )
    .bind(req.connection_id.to_string())
    .fetch_optional(&*state.db)
    .await?;

    let (service_type, base_url, api_token, stored_tunnel_token) = match conn_row {
        Some(r) => {
            let st: String = r.get(0);
            let bu: String = r.get(1);
            let at: String = r.get(2);
            let tt: Option<String> = r.get(3);
            (st, bu, at, tt)
        }
        None => return Err(ApiError::NotFound("Hosting connection not found".into())),
    };

    // Effective tunnel token: a token pasted in the wizard wins; otherwise the one saved on
    // this connection (Settings → Hosting → Tunnel tokens). Each platform server runs its own
    // tunnel, hence per-connection storage.
    let effective_tunnel_token: Option<String> = req
        .cloudflare_tunnel_token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .or_else(|| stored_tunnel_token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()));

    // Look up the project
    let project = ProjectCtx::load(&state, req.project_id).await?;
    let project_name = project.name.clone();

    let project_path = project.dir.clone();
    if !project_path.exists() {
        return Err(ApiError::NotFound(format!("Project directory not found: {:?}", project_path)));
    }

    // Detect framework from package.json
    let (framework, build_cmd, output_dir, default_port) = detect_framework(&project_path);

    // Generate Dockerfile if one doesn't exist
    let dockerfile_path = project_path.join("Dockerfile");
    if !dockerfile_path.exists() {
        let dockerfile = generate_dockerfile(&framework, &build_cmd, &output_dir, default_port);
        std::fs::write(&dockerfile_path, &dockerfile)
            .map_err(|e| ApiError::Internal(format!("Failed to write Dockerfile: {}", e)))?;
    }

    let port = req.port.unwrap_or(default_port);

    // The configured shared Pocketbase URL to inject into the app (build-time + runtime), if the
    // user requested a Pocketbase backend for this deploy.
    let pocketbase_url = resolve_pocketbase_url(&state, &req).await;

    // Deployment identity: the committed manifest (.monastery/deploy.json) travels with the repo
    // so other Monastery instances / collaborators adopt the same platform app instead of
    // creating duplicates. Missing → new identity; corrupt → surface it (don't silently fork).
    let manifest_existed;
    let manifest = match crate::deploy_manifest::load(&project_path) {
        Ok(Some(m)) => { manifest_existed = true; m }
        Ok(None) => { manifest_existed = false; crate::deploy_manifest::DeployManifest::new(&req.app_name) }
        Err(e) => return Err(ApiError::Config(format!("{} — fix or delete the file and retry.", e))),
    };

    // Cloudflare API connection for automated tunnel routing (optional). Explicit id from the
    // wizard wins; else fall back to the newest configured cloudflare connection.
    let cloudflare_api_token: Option<String> = {
        let row = match req.cloudflare_connection_id {
            Some(cid) => sqlx::query(
                "SELECT api_token FROM hosting_connections WHERE id = ? AND service_type = 'cloudflare'",
            )
            .bind(cid.to_string())
            .fetch_optional(&*state.db)
            .await?,
            None => sqlx::query(
                "SELECT api_token FROM hosting_connections WHERE service_type = 'cloudflare' ORDER BY created_at DESC LIMIT 1",
            )
            .fetch_optional(&*state.db)
            .await?,
        };
        row.map(|r| r.get::<String, _>(0))
    };

    // Build and deploy based on service type
    let base = base_url.trim_end_matches('/');
    let client = reqwest::Client::new();

    let cx = DeployContext {
        state,
        req,
        base: base.to_string(),
        api_token,
        effective_tunnel_token,
        project_name,
        project_path,
        framework,
        output_dir,
        port,
        pocketbase_url,
        manifest_existed,
        manifest,
        cloudflare_api_token,
        client,
    };
    match service_type.as_str() {
        "coolify" => coolify::deploy(cx).await,
        "dokploy" => dokploy::deploy(cx).await,
        other => Err(ApiError::Config(format!(
            "Deployment not yet supported for service type '{}'. Supported: coolify, dokploy",
            other
        ))),
    }
}
