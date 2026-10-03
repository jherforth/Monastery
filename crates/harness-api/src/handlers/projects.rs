//! Projects: list, create (optionally from a starter), get, delete.

use super::*;

/// List projects
pub async fn list_projects(
    State(state): State<AppState>,
) -> Result<Json<Vec<ProjectInfo>>, ApiError> {
    use sqlx::Row;

    let rows = sqlx::query(
        "SELECT id, name, description, created_at, updated_at FROM projects ORDER BY updated_at DESC"
    )
    .fetch_all(&*state.db)
    .await?;

    let projects: Vec<ProjectInfo> = rows.iter().map(|row| {
        let id: String = row.get(0);
        let name: String = row.get(1);
        let description: Option<String> = row.get(2);
        let created_at: String = row.get(3);
        let updated_at: String = row.get(4);

        ProjectInfo {
            id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::new_v4()),
            name,
            description,
            created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
            updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at)
                .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
        }
    }).collect();

    Ok(Json(projects))
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub description: Option<String>,
    /// Starter template id (see `starters.rs`); absent or "blank" = empty project.
    #[serde(default)]
    pub starter: Option<String>,
}

/// The project name doubles as its directory under data_dir, so it must be a single, plain
/// path segment — `../x` would otherwise escape the data directory.
pub(crate) fn validate_project_name(name: &str) -> Result<(), ApiError> {
    let ok_chars = name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '));
    if name.trim().is_empty() || name.len() > 100 || !ok_chars || name.starts_with('.') || name.trim() != name {
        return Err(ApiError::Config(
            "Project names may use letters, numbers, spaces, '-', '_' and '.', must not start with '.', and must be at most 100 characters.".into(),
        ));
    }
    Ok(())
}

/// GET /api/starters — the templates New Project can start from.
pub async fn list_starters() -> Json<serde_json::Value> {
    Json(serde_json::json!(crate::starters::STARTERS.iter().map(|s| serde_json::json!({
        "id": s.id,
        "name": s.name,
        "description": s.description,
    })).collect::<Vec<_>>()))
}

/// Create a new project
pub async fn create_project(
    State(state): State<AppState>,
    Json(req): Json<CreateProjectRequest>,
) -> Result<Json<ProjectInfo>, ApiError> {
    validate_project_name(&req.name)?;
    let starter = match req.starter.as_deref() {
        None | Some("") | Some("blank") => None,
        Some(id) => Some(crate::starters::find(id).ok_or_else(|| ApiError::Config(format!("Unknown starter: {}", id)))?),
    };
    // Two projects with one name would share a directory.
    let taken = sqlx::query("SELECT 1 FROM projects WHERE name = ?")
        .bind(&req.name)
        .fetch_optional(&*state.db)
        .await?;
    if taken.is_some() {
        return Err(ApiError::Config(format!("A project named \"{}\" already exists.", req.name)));
    }

    let project_id = Uuid::new_v4();
    let now = chrono::Utc::now();
    let now_str = now.to_rfc3339();

    sqlx::query(
        "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(project_id.to_string())
    .bind(&req.name)
    .bind(req.description.as_deref())
    .bind(&now_str)
    .bind(&now_str)
    .execute(&*state.db)
    .await?;

    // Create the project directory on disk so file writes work immediately
    let project_dir = state.config.data_dir.join(&req.name);
    tokio::fs::create_dir_all(&project_dir).await
        .map_err(|e| ApiError::Internal(format!("Failed to create project directory: {}", e)))?;

    if let Some(starter) = starter {
        // The PocketBase starter points at the configured shared PocketBase, when there is one.
        let pocketbase_url = sqlx::query("SELECT base_url FROM hosting_connections WHERE service_type = 'pocketbase' ORDER BY created_at DESC LIMIT 1")
            .fetch_optional(&*state.db).await.ok().flatten()
            .map(|r| r.get::<String, _>(0).trim_end_matches('/').to_string())
            .unwrap_or_else(|| crate::starters::DEFAULT_POCKETBASE_URL.to_string());
        for (rel, contents) in starter.files {
            let path = project_dir.join(rel);
            // Never clobber files already in a directory that pre-dated the project row.
            if path.exists() {
                continue;
            }
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await
                    .map_err(|e| ApiError::Internal(format!("Failed to create {}: {}", rel, e)))?;
            }
            let body = contents.replace(crate::starters::POCKETBASE_URL_PLACEHOLDER, &pocketbase_url);
            tokio::fs::write(&path, body).await
                .map_err(|e| ApiError::Internal(format!("Failed to write {}: {}", rel, e)))?;
        }
    }

    Ok(Json(ProjectInfo {
        id: project_id,
        name: req.name,
        description: req.description,
        created_at: now,
        updated_at: now,
    }))
}

/// Get a specific project
pub async fn get_project(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> Result<Json<ProjectInfo>, ApiError> {
    use sqlx::Row;

    let row = sqlx::query(
        "SELECT id, name, description, created_at, updated_at FROM projects WHERE id = ?"
    )
    .bind(id.to_string())
    .fetch_optional(&*state.db)
    .await?;

    match row {
        Some(row) => {
            let id_str: String = row.get(0);
            let name: String = row.get(1);
            let description: Option<String> = row.get(2);
            let created_at: String = row.get(3);
            let updated_at: String = row.get(4);

            Ok(Json(ProjectInfo {
                id: Uuid::parse_str(&id_str).unwrap_or_else(|_| Uuid::new_v4()),
                name,
                description,
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
                updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at)
                    .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
            }))
        }
        None => Err(ApiError::NotFound(format!("Project {} not found", id))),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// Delete a project: removes its database records (sessions, messages, snapshots) AND
/// wipes its directory from the data dir. This is what lets a user abandon a broken
/// state entirely and re-clone a git repo/branch fresh — a clone into an existing
/// directory fails, so the local copy must be removable.
pub async fn delete_project(
    project: ProjectCtx,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_id = project.id;

    let project_name = project.name.clone();

    // Path-escape guard up front: the resolved dir must live directly inside data_dir
    // (project names are single path segments). Checked BEFORE any destructive work.
    let project_path = project.dir.clone();
    let canonical_dir: Option<std::path::PathBuf> = if project_path.exists() {
        let canonical = project_path.canonicalize()
            .map_err(|e| ApiError::Internal(format!("Failed to resolve project dir: {}", e)))?;
        let canonical_base = state.config.data_dir.canonicalize()
            .map_err(|e| ApiError::Internal(format!("Failed to resolve data dir: {}", e)))?;
        if canonical.parent() != Some(canonical_base.as_path()) {
            return Err(ApiError::Config("Refusing to delete: project dir is not directly inside the data dir".into()));
        }
        Some(canonical)
    } else {
        None
    };

    // Delete DB records first, atomically (SQLite FK cascades only fire with the foreign_keys
    // pragma on, so children are removed explicitly). The directory wipe comes AFTER: the old
    // order deleted files first, so any DB failure — like the deployments FK rows this list
    // once forgot — left a half-deleted project (files gone, still listed).
    let pid = project_id.to_string();
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM snapshot_files WHERE snapshot_id IN (SELECT id FROM snapshots WHERE project_id = ?)")
        .bind(&pid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM snapshot_tags WHERE snapshot_id IN (SELECT id FROM snapshots WHERE project_id = ?)")
        .bind(&pid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM snapshots WHERE project_id = ?")
        .bind(&pid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM session_messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)")
        .bind(&pid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM sessions WHERE project_id = ?")
        .bind(&pid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM project_files WHERE project_id = ?")
        .bind(&pid).execute(&mut *tx).await?;
    // Deployment tracking rows FK-reference projects — the missing delete that made every
    // previously-deployed project undeletable (SQLITE_CONSTRAINT_FOREIGNKEY, code 787).
    sqlx::query("DELETE FROM deployments WHERE project_id = ?")
        .bind(&pid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(&pid).execute(&mut *tx).await?;
    tx.commit().await?;

    // Now wipe the directory. If this fails the app state is still consistent (project fully
    // gone from the DB) — surface the orphaned dir instead of pretending nothing happened.
    if let Some(dir) = canonical_dir {
        if let Err(e) = tokio::fs::remove_dir_all(&dir).await {
            return Err(ApiError::Internal(format!(
                "Project records were deleted, but removing the directory failed: {}. Remove {} manually.",
                e, dir.display()
            )));
        }
    }

    Ok(Json(serde_json::json!({ "success": true, "deleted": project_name })))
}
