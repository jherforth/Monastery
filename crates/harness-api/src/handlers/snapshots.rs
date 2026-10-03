//! Snapshots: list, create, checkpoint, restore, diff.

use super::*;

/// List snapshots for a project
pub async fn list_snapshots(
    Path(project_id): Path<Uuid>,
    State(state): State<AppState>,
) -> Result<Json<harness_core::SnapshotList>, ApiError> {
    let page = 1;
    let per_page = 50;

    let list = state.snapshot_service
        .list_snapshots(project_id, page, per_page)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(list))
}

/// Create a new snapshot
pub async fn create_snapshot(
    Path(project_id): Path<Uuid>,
    State(state): State<AppState>,
    Json(req): Json<CreateSnapshotBody>,
) -> Result<Json<harness_core::CreateSnapshotResponse>, ApiError> {
    let request = CreateSnapshotRequest {
        project_id,
        name: req.name,
        description: req.description,
        created_by: req.created_by,
        trigger: req.trigger.unwrap_or(SnapshotTrigger::Manual),
        files: req.files,
        parent_snapshot_id: None,
    };

    let response = state.snapshot_service
        .create_snapshot(request)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
pub struct CreateSnapshotBody {
    pub name: Option<String>,
    pub description: Option<String>,
    pub created_by: Option<String>,
    pub trigger: Option<SnapshotTrigger>,
    pub files: Vec<harness_core::snapshot::SnapshotFileInput>,
}

/// Create a safety checkpoint snapshot from the project's CURRENT on-disk state.
/// Unlike create_snapshot (which takes file contents in the request), this reads the
/// project directory server-side — the UI calls it right before applying LLM output so
/// even the very first AI edit in a project can be reverted.
#[derive(Debug, Deserialize)]
pub struct CheckpointBody {
    pub name: Option<String>,
}

pub async fn create_checkpoint_snapshot(
    project: ProjectCtx,
    State(state): State<AppState>,
    Json(req): Json<CheckpointBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_id = project.id;

    let project_path = project.dir.clone();
    let mut files = Vec::new();
    if project_path.exists() {
        read_files_for_snapshot(&project_path, &project_path, &mut files);
    }
    // Nothing on disk yet (brand-new project) — nothing to protect, skip the snapshot.
    if files.is_empty() {
        return Ok(Json(serde_json::json!({ "snapshot_id": null, "file_count": 0 })));
    }

    let file_count = files.len();
    let request = CreateSnapshotRequest {
        project_id,
        name: Some(req.name.unwrap_or_else(|| "Auto: before AI edit".to_string())),
        description: Some("Safety checkpoint taken automatically before applying AI changes".into()),
        created_by: Some("Monastery".into()),
        trigger: SnapshotTrigger::BeforeChange,
        files,
        parent_snapshot_id: None,
    };
    let response = state.snapshot_service
        .create_snapshot(request)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(serde_json::json!({
        "snapshot_id": response.snapshot.id.to_string(),
        "file_count": file_count,
    })))
}

/// Get a specific snapshot with its files
pub async fn get_snapshot(
    Path((project_id, snapshot_id)): Path<(Uuid, Uuid)>,
    State(state): State<AppState>,
) -> Result<Json<SnapshotDetailResponse>, ApiError> {
    let (snapshot, files) = state.snapshot_service
        .get_snapshot(snapshot_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    // Verify project ownership
    if snapshot.project_id != project_id {
        return Err(ApiError::NotFound("Snapshot does not belong to this project".into()));
    }

    Ok(Json(SnapshotDetailResponse {
        snapshot,
        files,
    }))
}

#[derive(Debug, Serialize)]
pub struct SnapshotDetailResponse {
    pub snapshot: harness_core::Snapshot,
    pub files: Vec<harness_core::SnapshotFile>,
}

/// Delete a snapshot
pub async fn delete_snapshot(
    Path((project_id, snapshot_id)): Path<(Uuid, Uuid)>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    // First verify the snapshot belongs to this project
    let (snapshot, _) = state.snapshot_service
        .get_snapshot(snapshot_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    if snapshot.project_id != project_id {
        return Err(ApiError::NotFound("Snapshot does not belong to this project".into()));
    }

    state.snapshot_service
        .delete_snapshot(snapshot_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

/// Restore a project to a previous snapshot
pub async fn restore_snapshot(
    Path((project_id, snapshot_id)): Path<(Uuid, Uuid)>,
    State(state): State<AppState>,
    Json(req): Json<RestoreSnapshotBody>,
) -> Result<Json<harness_core::RestoreSnapshotResponse>, ApiError> {
    let request = RestoreSnapshotRequest {
        snapshot_id,
        dry_run: req.dry_run.unwrap_or(false),
        create_backup: req.create_backup.unwrap_or(true),
    };

    // Get the snapshot with its files
    let (snapshot, files) = state.snapshot_service
        .get_snapshot(snapshot_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    if snapshot.project_id != project_id {
        return Err(ApiError::NotFound("Snapshot does not belong to this project".into()));
    }

    // Look up project directory
    let project = ProjectCtx::load(&state, project_id).await?;
    let project_path = project.dir.clone();

    // If dry_run, just report what would be restored
    if request.dry_run {
        return Ok(Json(harness_core::RestoreSnapshotResponse {
            success: true,
            restored_files: files.len() as u32,
            failed_files: 0,
            backup_snapshot_id: None,
            errors: Vec::new(),
        }));
    }

    // Write snapshot files to disk
    let mut failed = 0u32;
    let mut errors = Vec::new();

    for file in &files {
        if let Some(ref content) = file.content {
            let target = project_path.join(&file.file_path);
            if let Some(parent) = target.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            match tokio::fs::write(&target, content).await {
                Ok(_) => {}
                Err(e) => {
                    failed += 1;
                    errors.push(format!("{}: {}", file.file_path, e));
                }
            }
        }
    }

    // Mark snapshot as active in DB
    let _ = state.snapshot_service
        .restore_snapshot(request)
        .await;

    Ok(Json(harness_core::RestoreSnapshotResponse {
        success: failed == 0,
        restored_files: files.len() as u32 - failed,
        failed_files: failed,
        backup_snapshot_id: None,
        errors,
    }))
}

#[derive(Debug, Deserialize)]
pub struct RestoreSnapshotBody {
    pub dry_run: Option<bool>,
    pub create_backup: Option<bool>,
}

/// Get diff between two snapshots
pub async fn diff_snapshots(
    Path((project_id, snapshot_id)): Path<(Uuid, Uuid)>,
    Query(params): Query<DiffSnapshotsParams>,
    State(state): State<AppState>,
) -> Result<Json<harness_core::SnapshotDiff>, ApiError> {
    // Verify the first snapshot belongs to this project
    let (snapshot, _) = state.snapshot_service
        .get_snapshot(snapshot_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    if snapshot.project_id != project_id {
        return Err(ApiError::NotFound("Snapshot does not belong to this project".into()));
    }

    let target_id = params.target.unwrap_or_else(Uuid::new_v4);

    let diff = state.snapshot_service
        .diff_snapshots(snapshot_id, target_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(diff))
}

#[derive(Debug, Deserialize)]
pub struct DiffSnapshotsParams {
    pub target: Option<Uuid>,
}
