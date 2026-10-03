//! Git forge connections and per-project git sync (status, commit & push, pull, push, clone).

use super::*;

use harness_core::{
    GitForgeType, GitConnection, ConnectGitForgeRequest,
    GitPushRequest, GitCloneRequest, GitService,
};

/// List all Git forge connections
pub async fn list_git_connections(
    State(state): State<AppState>,
) -> Result<Json<Vec<GitConnection>>, ApiError> {
    use sqlx::Row;

    let rows = sqlx::query(
        "SELECT id, name, forge_type, base_url, api_token, username, email, is_default, created_at, last_synced_at FROM git_connections ORDER BY created_at DESC"
    )
    .fetch_all(&*state.db)
    .await
    .unwrap_or_default();

    let connections: Vec<GitConnection> = rows.iter().map(|row| {
        let id: String = row.get(0);
        let name: String = row.get(1);
        let forge_type: String = row.get(2);
        let base_url: String = row.get(3);
        let api_token: String = row.get(4);
        let username: Option<String> = row.get(5);
        let email: Option<String> = row.get(6);
        let is_default: i64 = row.get(7);
        let created_at: String = row.get(8);
        let last_synced_at: Option<String> = row.get(9);

        GitConnection {
            id: uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4()),
            name,
            forge_type: match forge_type.as_str() {
                "gitlab" => GitForgeType::GitLab,
                "forgejo" => GitForgeType::Forgejo,
                "gitea" => GitForgeType::Gitea,
                _ => GitForgeType::GitHub,
            },
            base_url,
            api_token,
            username,
            email,
            is_default: is_default != 0,
            created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
            last_synced_at: last_synced_at.and_then(|s| {
                chrono::DateTime::parse_from_rfc3339(&s).ok().map(|dt| dt.into())
            }),
        }
    }).collect();

    Ok(Json(connections))
}

/// Connect a new Git forge
pub async fn connect_git_forge(
    State(state): State<AppState>,
    Json(req): Json<ConnectGitForgeRequest>,
) -> Result<Json<GitConnection>, ApiError> {
    // Validate Forgejo/Gitea requires a URL
    if req.forge_type == GitForgeType::Forgejo || req.forge_type == GitForgeType::Gitea {
        match &req.base_url {
            Some(url) if !url.is_empty() => {
                if !url.starts_with("http://") && !url.starts_with("https://") {
                    return Err(ApiError::Config("Forgejo/Gitea URL must start with http:// or https://".into()));
                }
            }
            _ => return Err(ApiError::Config("Forgejo/Gitea requires a base URL (e.g., https://git.yourdomain.com)".into())),
        }
    }

    let base_url = req.base_url
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| req.forge_type.default_api_url().to_string());

    // Test the connection
    let username = GitService::test_connection(
        &req.forge_type, &base_url, &req.api_token,
    ).await
    .map_err(|e| ApiError::Config(format!("Connection test failed: {}", e)))?;

    let id = uuid::Uuid::new_v4();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO git_connections (id, name, forge_type, base_url, api_token, username, email, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id.to_string())
    .bind(&req.name)
    .bind(req.forge_type.to_string())
    .bind(&base_url)
    .bind(&req.api_token)
    .bind(&username)
    .bind(req.email.as_deref())
    .bind(0i64)
    .bind(&now)
    .execute(&*state.db)
    .await?;

    let connection = GitConnection {
        id,
        name: req.name,
        forge_type: req.forge_type,
        base_url,
        api_token: req.api_token,
        username: Some(username),
        email: req.email,
        is_default: false,
        created_at: chrono::Utc::now(),
        last_synced_at: None,
    };

    Ok(Json(connection))
}

/// Delete a Git forge connection
pub async fn delete_git_connection(
    Path(id): Path<uuid::Uuid>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    sqlx::query("DELETE FROM git_connections WHERE id = ?")
        .bind(id.to_string())
        .execute(&*state.db)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Test a Git forge connection
pub async fn test_git_connection(
    Path(id): Path<uuid::Uuid>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;

    let row = sqlx::query(
        "SELECT forge_type, base_url, api_token FROM git_connections WHERE id = ?"
    )
    .bind(id.to_string())
    .fetch_optional(&*state.db)
    .await?;

    let (forge_type, base_url, api_token) = match row {
        Some(r) => {
            let ft: String = r.get(0);
            let bu: String = r.get(1);
            let at: String = r.get(2);
            let ft = match ft.as_str() {
                "gitlab" => GitForgeType::GitLab,
                "forgejo" => GitForgeType::Forgejo,
                "gitea" => GitForgeType::Gitea,
                _ => GitForgeType::GitHub,
            };
            (ft, bu, at)
        }
        None => return Err(ApiError::NotFound("Connection not found".into())),
    };

    match GitService::test_connection(&forge_type, &base_url, &api_token).await {
        Ok(username) => Ok(Json(serde_json::json!({
            "healthy": true,
            "username": username,
            "message": "Connection successful"
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "healthy": false,
            "message": e.to_string()
        }))),
    }
}

/// List repos for a Git forge connection
pub async fn list_git_repos(
    Path(connection_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
) -> Result<Json<Vec<harness_core::GitRepo>>, ApiError> {
    use sqlx::Row;

    let row = sqlx::query(
        "SELECT id, name, forge_type, base_url, api_token, username, email, is_default, created_at, last_synced_at FROM git_connections WHERE id = ?"
    )
    .bind(connection_id.to_string())
    .fetch_optional(&*state.db)
    .await?;

    let connection = match row {
        Some(r) => {
            let id: String = r.get(0);
            let name: String = r.get(1);
            let forge_type: String = r.get(2);
            let base_url: String = r.get(3);
            let api_token: String = r.get(4);
            let username: Option<String> = r.get(5);
            let email: Option<String> = r.get(6);
            let is_default: i64 = r.get(7);
            let created_at: String = r.get(8);
            let last_synced_at: Option<String> = r.get(9);

            GitConnection {
                id: uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4()),
                name,
                forge_type: match forge_type.as_str() {
                    "gitlab" => GitForgeType::GitLab,
                    "forgejo" => GitForgeType::Forgejo,
                    "gitea" => GitForgeType::Gitea,
                    _ => GitForgeType::GitHub,
                },
                base_url,
                api_token,
                username,
                email,
                is_default: is_default != 0,
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
                last_synced_at: last_synced_at.and_then(|s| {
                    chrono::DateTime::parse_from_rfc3339(&s).ok().map(|dt| dt.into())
                }),
            }
        }
        None => return Err(ApiError::NotFound("Connection not found".into())),
    };

    let repos = GitService::list_repos(&connection).await
        .map_err(|e| ApiError::Core(e))?;

    Ok(Json(repos))
}

/// List branches for a repo on a Git forge connection
pub async fn list_git_branches(
    Path(connection_id): Path<uuid::Uuid>,
    Query(params): Query<harness_core::models::ListBranchesQuery>,
    State(state): State<AppState>,
) -> Result<Json<Vec<harness_core::models::GitBranch>>, ApiError> {
    let row = sqlx::query(
        "SELECT id, name, forge_type, base_url, api_token, username, email, is_default, created_at, last_synced_at FROM git_connections WHERE id = ?"
    )
    .bind(connection_id.to_string())
    .fetch_optional(&*state.db)
    .await?;

    let connection = match row {
        Some(r) => build_git_connection(&r),
        None => return Err(ApiError::NotFound("Connection not found".into())),
    };

    let branches = GitService::list_branches(&connection, &params.repo_full_name).await
        .map_err(|e| ApiError::Core(e))?;

    Ok(Json(branches))
}

/// Helper: build a GitConnection from a database row
pub(crate) fn build_git_connection(row: &sqlx::sqlite::SqliteRow) -> GitConnection {
    use sqlx::Row;
    let id: String = row.get(0);
    let name: String = row.get(1);
    let forge_type: String = row.get(2);
    let base_url: String = row.get(3);
    let api_token: String = row.get(4);
    let username: Option<String> = row.get(5);
    let email: Option<String> = row.get(6);
    let is_default: i64 = row.get(7);
    let created_at: String = row.get(8);
    let last_synced_at: Option<String> = row.get(9);

    GitConnection {
        id: uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4()),
        name,
        forge_type: match forge_type.as_str() {
            "gitlab" => GitForgeType::GitLab,
            "forgejo" => GitForgeType::Forgejo,
            "gitea" => GitForgeType::Gitea,
            _ => GitForgeType::GitHub,
        },
        base_url,
        api_token,
        username,
        email,
        is_default: is_default != 0,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
            .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
        last_synced_at: last_synced_at.and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(&s).ok().map(|dt| dt.into())
        }),
    }
}

/// Get git status for the current project
pub async fn get_git_status(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<harness_core::GitStatus>, ApiError> {
    // If project_id is provided, look up the project directory
    let project_path = if let Some(project_id) = params.get("project_id") {
        let id = Uuid::parse_str(project_id).map_err(|_| ApiError::Config("Invalid project_id".into()))?;
        ProjectCtx::load(&state, id).await?.dir
    } else {
        state.config.data_dir.clone()
    };

    // With ?fetch=true, refresh the remote-tracking ref first so ahead/behind reflects reality.
    // Without it (the frequent poll), status stays a fast local-only read. The tracking ref only
    // updates on fetch/pull, so the "behind" badge is otherwise frozen at clone time.
    if params.get("fetch").map(|v| v == "true").unwrap_or(false) {
        if let Ok(status) = GitService::git_status(&project_path) {
            if status.has_remote {
                let token = resolve_project_git(&state, &project_path).await.ok().map(|g| g.token);
                let _ = GitService::git_fetch(&project_path, token.as_deref(), &status.branch);
            }
        }
    }

    let status = GitService::git_status(&project_path)
        .map_err(|e| ApiError::Core(e))?;
    Ok(Json(status))
}

/// Commit and push changes for a project to its remote
#[derive(Debug, Deserialize)]
pub struct CommitPushRequest {
    pub message: Option<String>,
}

pub async fn git_commit_push(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    Json(req): Json<CommitPushRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;

    let project_id_str = params.get("project_id")
        .ok_or_else(|| ApiError::Config("Missing project_id".into()))?;
    let project_id = uuid::Uuid::parse_str(project_id_str)
        .map_err(|_| ApiError::Config("Invalid project_id".into()))?;

    let project = ProjectCtx::load(&state, project_id).await?;

    let project_path = project.dir.clone();
    let message = req.message.unwrap_or_else(|| "Update from Monastery".to_string());

    // --- Create a snapshot before committing ---
    let _snapshot_id = Uuid::new_v4();
    let snapshot_result: Option<String> = {
        let mut files = Vec::new();
        read_files_for_snapshot(&project_path, &project_path, &mut files);

        if !files.is_empty() {
            let snapshot_req = CreateSnapshotRequest {
                project_id,
                name: Some(format!("Pre-commit: {}", message)),
                description: Some(message.clone()),
                created_by: Some("Monastery AI".into()),
                trigger: SnapshotTrigger::BeforeChange,
                files,
                parent_snapshot_id: None,
            };

            match state.snapshot_service.create_snapshot(snapshot_req).await {
                Ok(resp) => Some(resp.snapshot.id.to_string()),
                Err(e) => {
                    tracing::warn!("Failed to create pre-commit snapshot: {}", e);
                    None
                }
            }
        } else {
            None
        }
    };

    // Look up git connection for author identity
    let author = sqlx::query(
        "SELECT username, email FROM git_connections ORDER BY created_at DESC LIMIT 1"
    )
    .fetch_optional(&*state.db)
    .await?;

    let (author_name, author_email) = match author {
        Some(r) => {
            let name: Option<String> = r.get(0);
            let email: Option<String> = r.get(1);
            (name, email)
        }
        None => (None, None),
    };

    // Best-effort forge token so the pre-push fetch/rebase can authenticate. If the project has
    // no remote or no matching connection, we push without it (origin's stored creds), as before.
    let token = resolve_project_git(&state, &project_path).await.ok().map(|g| g.token);

    let result = GitService::git_commit_and_push(
        &project_path, &message,
        author_name.as_deref(),
        author_email.as_deref(),
        token.as_deref(),
    )
        .map_err(|e| ApiError::Core(e))?;

    // Update git_connections last_synced_at
    let now = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query("UPDATE git_connections SET last_synced_at = ?")
        .bind(&now)
        .execute(&*state.db)
        .await;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": result,
        "snapshot_id": snapshot_result,
    })))
}

/// Pull remote changes into a project's local working copy (rebasing local edits on top).
/// This is what lets Monastery adopt commits pushed by other contributors — the local copy
/// was previously write-only to the remote.
pub async fn git_pull(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_id_str = params.get("project_id")
        .ok_or_else(|| ApiError::Config("Missing project_id".into()))?;
    let project_id = uuid::Uuid::parse_str(project_id_str)
        .map_err(|_| ApiError::Config("Invalid project_id".into()))?;

    let project = ProjectCtx::load(&state, project_id).await?;
    let project_path = project.dir.clone();

    // Snapshot the current on-disk state first, so a pull that brings in surprising changes is
    // revertible from the chat's snapshot list.
    let snapshot_id: Option<String> = {
        let mut files = Vec::new();
        read_files_for_snapshot(&project_path, &project_path, &mut files);
        if files.is_empty() { None } else {
            let req = CreateSnapshotRequest {
                project_id,
                name: Some("Before pull".into()),
                description: Some("Snapshot taken before pulling remote changes".into()),
                created_by: Some("Monastery".into()),
                trigger: SnapshotTrigger::BeforeChange,
                files,
                parent_snapshot_id: None,
            };
            state.snapshot_service.create_snapshot(req).await.ok().map(|r| r.snapshot.id.to_string())
        }
    };

    let token = resolve_project_git(&state, &project_path).await.ok().map(|g| g.token);
    let message = GitService::git_pull(&project_path, token.as_deref())
        .map_err(|e| ApiError::Core(e))?;

    let now = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query("UPDATE git_connections SET last_synced_at = ?")
        .bind(&now).execute(&*state.db).await;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": message,
        "snapshot_id": snapshot_id,
    })))
}

/// Push project to a Git forge repository
pub async fn git_push(
    State(state): State<AppState>,
    Json(req): Json<GitPushRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;

    let row = sqlx::query(
        "SELECT forge_type, base_url, api_token FROM git_connections WHERE id = ?"
    )
    .bind(req.connection_id.to_string())
    .fetch_optional(&*state.db)
    .await?;

    let (forge_type, base_url, api_token) = match row {
        Some(r) => {
            let ft: String = r.get(0);
            let bu: String = r.get(1);
            let at: String = r.get(2);
            let ft = match ft.as_str() {
                "gitlab" => GitForgeType::GitLab,
                "forgejo" => GitForgeType::Forgejo,
                "gitea" => GitForgeType::Gitea,
                _ => GitForgeType::GitHub,
            };
            (ft, bu, at)
        }
        None => return Err(ApiError::NotFound("Connection not found".into())),
    };

    let connection = GitConnection {
        id: req.connection_id,
        name: String::new(),
        forge_type,
        base_url,
        api_token,
        username: None,
        email: None,
        is_default: false,
        created_at: chrono::Utc::now(),
        last_synced_at: None,
    };

    // Resolve the project directory — the push targets ONE project, never the whole
    // data_dir (the old behavior git-inited the root and pushed every project at once).
    let project_id = req.project_id.ok_or_else(|| {
        ApiError::Config("project_id is required — select a project to push".into())
    })?;
    let project = ProjectCtx::load(&state, project_id).await?;
    let project_name = project.name.clone();
    let project_dir = project.dir.clone();
    if !project_dir.is_dir() {
        return Err(ApiError::NotFound(format!("Project directory not found: {}", project_name)));
    }

    // Init git if needed
    GitService::git_init(&project_dir)
        .map_err(|e| ApiError::Core(e))?;

    // Create the repo on the forge
    let repo = GitService::create_repo(
        &connection,
        &req.repo_name,
        req.repo_description.as_deref(),
        req.private,
    ).await
    .map_err(|e| ApiError::Core(e))?;

    // Push to the repo
    let branch = req.branch.unwrap_or_else(|| repo.default_branch.clone());
    let commit_msg = req.commit_message.unwrap_or_else(|| "Initial commit from Monastery".to_string());

    GitService::git_push(
        &project_dir,
        &repo.clone_url,
        &connection.api_token,
        &branch,
        &commit_msg,
    ).map_err(|e| ApiError::Core(e))?;

    // Update last_synced_at
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE git_connections SET last_synced_at = ? WHERE id = ?")
        .bind(&now)
        .bind(req.connection_id.to_string())
        .execute(&*state.db)
        .await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "repo_url": repo.html_url,
        "clone_url": repo.clone_url,
        "branch": branch,
    })))
}

/// Clone a repo from a Git forge as a new project
pub async fn git_clone(
    State(state): State<AppState>,
    Json(req): Json<GitCloneRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;

    let row = sqlx::query(
        "SELECT forge_type, base_url, api_token FROM git_connections WHERE id = ?"
    )
    .bind(req.connection_id.to_string())
    .fetch_optional(&*state.db)
    .await?;

    let (forge_type, base_url, api_token) = match row {
        Some(r) => {
            let ft: String = r.get(0);
            let bu: String = r.get(1);
            let at: String = r.get(2);
            let ft = match ft.as_str() {
                "gitlab" => GitForgeType::GitLab,
                "forgejo" => GitForgeType::Forgejo,
                "gitea" => GitForgeType::Gitea,
                _ => GitForgeType::GitHub,
            };
            (ft, bu, at)
        }
        None => return Err(ApiError::NotFound("Connection not found".into())),
    };

    // Construct clone URL based on forge type
    let clone_url = match forge_type {
        GitForgeType::GitHub => format!("https://github.com/{}.git", req.repo_full_name),
        GitForgeType::GitLab => {
            if base_url == "https://gitlab.com/api/v4" {
                format!("https://gitlab.com/{}.git", req.repo_full_name)
            } else {
                // Self-hosted GitLab
                let domain = base_url.trim_end_matches("/api/v4");
                format!("{}/{}.git", domain, req.repo_full_name)
            }
        }
        GitForgeType::Forgejo | GitForgeType::Gitea => {
            format!("{}/{}.git", base_url.trim_end_matches("/api/v1"), req.repo_full_name)
        }
    };

    let repo_name = req.repo_full_name.split('/').last().unwrap_or("project").to_string();
    let project_name = req.project_name.unwrap_or_else(|| {
        // Append branch name to project dir so different branches don't conflict
        if let Some(ref branch) = req.branch {
            format!("{}-{}", repo_name, branch)
        } else {
            repo_name.clone()
        }
    });
    let target_path = state.config.data_dir.join(&project_name);

    // A non-empty target means this repo/branch was already cloned — git would fail with a
    // cryptic error. Tell the user the actual fix (delete the existing project to start fresh).
    if target_path.exists() && std::fs::read_dir(&target_path).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(ApiError::Config(format!(
            "Project '{}' already exists locally. Delete that project (project menu → trash icon) to wipe the local copy, then clone again.",
            project_name
        )));
    }

    tokio::fs::create_dir_all(&target_path).await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    GitService::git_clone(&clone_url, &target_path, Some(&api_token), req.branch.as_deref())
        .map_err(|e| ApiError::Core(e))?;

    // Update last_synced_at
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE git_connections SET last_synced_at = ? WHERE id = ?")
        .bind(&now)
        .bind(req.connection_id.to_string())
        .execute(&*state.db)
        .await?;

    // Create a project record in the database
    let project_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(project_id.to_string())
    .bind(&project_name)
    .bind(format!("Cloned from {}", req.repo_full_name))
    .bind(&now)
    .bind(&now)
    .execute(&*state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "success": true,
        "project_id": project_id.to_string(),
        "project_name": project_name,
        "project_path": target_path.to_str(),
    })))
}
