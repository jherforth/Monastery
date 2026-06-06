//! API route handlers

use axum::{
    extract::{Path, State},
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::AppState;
use harness_core::{
    CreateSnapshotRequest, RestoreSnapshotRequest, SnapshotTrigger,
};

/// Health check endpoint
pub async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "healthy",
        "service": "homelab-ai-harness"
    }))
}

/// List available models from configured endpoints
pub async fn list_models(
    State(state): State<AppState>,
) -> Result<Json<Vec<harness_core::models::ModelInfo>>, ApiError> {
    
    let mut all_models = Vec::new();
    
    // Fetch all endpoints from database
    let endpoints = sqlx::query("SELECT id, name, base_url, api_key, is_favorite, is_local, created_at FROM endpoints")
        .fetch_all(&*state.db)
        .await
        .unwrap_or_default();
    
    // If no endpoints in DB, try in-memory config
    let endpoint_configs: Vec<harness_core::models::EndpointConfig> = if endpoints.is_empty() {
        state.config.endpoints.clone()
    } else {
        endpoints
            .iter()
            .filter_map(|row| {
                let id: String = row.get(0);
                let name: String = row.get(1);
                let base_url: String = row.get(2);
                let api_key: Option<String> = row.get(3);
                let is_favorite: i64 = row.get(4);
                let is_local: i64 = row.get(5);
                let created_at: String = row.get(6);
                
                Some(harness_core::models::EndpointConfig {
                    id: uuid::Uuid::parse_str(&id).ok()?,
                    name,
                    base_url,
                    api_key,
                    is_favorite: is_favorite != 0,
                    is_local: is_local != 0,
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                        .ok()?
                        .into(),
                })
            })
            .collect()
    };
    
    // Fetch models from each endpoint
    for endpoint_config in endpoint_configs {
        let client = harness_core::LLMClient::new(endpoint_config);
        match client.list_models().await {
            Ok(models) => all_models.extend(models),
            Err(e) => tracing::warn!("Failed to fetch models from endpoint: {}", e),
        }
    }
    
    Ok(Json(all_models))
}

/// Stream chat completion
#[axum::debug_handler]
pub async fn chat_stream(
    State(state): State<AppState>,
    Path(model_id): Path<String>,
    Json(request): Json<ChatRequest>,
    axum::extract::Query(params): axum::extract::Query<ChatQueryParams>,
) -> Result<impl IntoResponse, ApiError> {
    use futures::StreamExt;
    
    // Get endpoint from query param or use default
    let endpoint_config = if let Some(endpoint_id) = params.endpoint_id {
        // Try database first
        let db_endpoint = sqlx::query_as::<_, harness_core::models::EndpointConfig>(
            "SELECT id, name, base_url, api_key, is_favorite, is_local, created_at FROM endpoints WHERE id = ?"
        )
        .bind(endpoint_id.to_string())
        .fetch_optional(&*state.db)
        .await
        .ok()
        .flatten();
        
        db_endpoint.or_else(|| {
            state.config.endpoints.iter()
                .find(|e| e.id == endpoint_id)
                .cloned()
        })
        .ok_or_else(|| ApiError::NotFound(format!("Endpoint {} not found", endpoint_id)))?
    } else {
        // Use first available endpoint
        let endpoints = sqlx::query("SELECT id, name, base_url, api_key, is_favorite, is_local, created_at FROM endpoints")
            .fetch_all(&*state.db)
            .await
            .unwrap_or_default();
        
        if !endpoints.is_empty() {
            let row = &endpoints[0];
            let id: String = row.get(0);
            let name: String = row.get(1);
            let base_url: String = row.get(2);
            let api_key: Option<String> = row.get(3);
            let is_favorite: i64 = row.get(4);
            let is_local: i64 = row.get(5);
            let created_at: String = row.get(6);
            
            harness_core::models::EndpointConfig {
                id: uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4()),
                name,
                base_url,
                api_key,
                is_favorite: is_favorite != 0,
                is_local: is_local != 0,
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .unwrap_or_else(|_| chrono::Utc::now().fixed_offset())
                    .into(),
            }
        } else {
            return Err(ApiError::Config("No LLM endpoint configured. Please add an endpoint in Settings.".into()));
        }
    };
    
    let client = harness_core::LLMClient::new(endpoint_config);
    
    // Convert messages to OpenAI format
    let messages: Vec<async_openai::types::ChatCompletionRequestMessage> = request.messages
        .into_iter()
        .map(|msg| {
            match msg.role.as_str() {
                "user" => async_openai::types::ChatCompletionRequestUserMessage {
                    content: async_openai::types::ChatCompletionRequestUserMessageContent::Text(msg.content),
                    name: None,
                }.into(),
                "assistant" => async_openai::types::ChatCompletionRequestAssistantMessage {
                    content: Some(async_openai::types::ChatCompletionRequestAssistantMessageContent::Text(msg.content)),
                    ..Default::default()
                }.into(),
                "system" => async_openai::types::ChatCompletionRequestSystemMessage {
                    content: async_openai::types::ChatCompletionRequestSystemMessageContent::Text(msg.content),
                    name: None,
                }.into(),
                _ => async_openai::types::ChatCompletionRequestUserMessage {
                    content: async_openai::types::ChatCompletionRequestUserMessageContent::Text(msg.content),
                    name: None,
                }.into(),
            }
        })
        .collect();
    
    let stream = client.chat_stream(messages, model_id).await?;
    
    // Create SSE stream
    use axum::response::Sse;
    
    let event_stream = stream.map(|result| {
        match result {
            Ok(content) => Ok(axum::response::sse::Event::default().data(content)),
            Err(e) => Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )),
        }
    });
    
    Ok(Sse::new(event_stream).into_response())
}

/// List configured endpoints (from database)
pub async fn list_endpoints(
    State(state): State<AppState>,
) -> Result<Json<Vec<harness_core::models::EndpointConfig>>, ApiError> {
    use sqlx::Row;
    
    let endpoints = sqlx::query("SELECT id, name, base_url, api_key, is_favorite, is_local, created_at FROM endpoints")
        .fetch_all(&*state.db)
        .await
        .unwrap_or_default();
    
    let configs: Vec<harness_core::models::EndpointConfig> = endpoints
        .iter()
        .map(|row| {
            let id: String = row.get(0);
            let name: String = row.get(1);
            let base_url: String = row.get(2);
            let api_key: Option<String> = row.get(3);
            let is_favorite: i64 = row.get(4);
            let is_local: i64 = row.get(5);
            let created_at: String = row.get(6);
            
            harness_core::models::EndpointConfig {
                id: uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4()),
                name,
                base_url,
                api_key,
                is_favorite: is_favorite != 0,
                is_local: is_local != 0,
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .unwrap_or_else(|_| chrono::Utc::now().fixed_offset())
                    .into(),
            }
        })
        .collect();
    
    Ok(Json(configs))
}

#[derive(Debug, Deserialize)]
pub struct AddEndpointRequest {
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
}

/// Add a new endpoint
pub async fn add_endpoint(
    State(state): State<AppState>,
    Json(req): Json<AddEndpointRequest>,
) -> Result<Json<harness_core::models::EndpointConfig>, ApiError> {
    
    let is_local = req.base_url.contains("localhost") 
        || req.base_url.contains("127.0.0.1")
        || req.base_url.contains("192.168.")
        || req.base_url.contains("10.");
    
    let endpoint_id = Uuid::new_v4();
    let now = chrono::Utc::now().to_rfc3339();
    
    // Save to database
    sqlx::query(
        "INSERT INTO endpoints (id, name, base_url, api_key, is_favorite, is_local, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(endpoint_id.to_string())
    .bind(&req.name)
    .bind(&req.base_url)
    .bind(req.api_key.as_deref())
    .bind(0i64) // is_favorite = false
    .bind(if is_local { 1i64 } else { 0i64 })
    .bind(&now)
    .execute(&*state.db)
    .await?;
    
    let endpoint = harness_core::models::EndpointConfig {
        id: endpoint_id,
        name: req.name,
        base_url: req.base_url,
        api_key: req.api_key,
        is_favorite: false,
        is_local,
        created_at: chrono::Utc::now(),
    };
    
    Ok(Json(endpoint))
}

/// Delete an endpoint
pub async fn delete_endpoint(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    sqlx::query("DELETE FROM endpoints WHERE id = ?")
        .bind(id.to_string())
        .execute(&*state.db)
        .await?;
    
    Ok(StatusCode::NO_CONTENT)
}

/// Test endpoint connectivity
pub async fn test_endpoint(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> Result<Json<TestEndpointResponse>, ApiError> {
    // Try to find in database first
    let endpoint_config = sqlx::query_as::<_, harness_core::models::EndpointConfig>(
        "SELECT id, name, base_url, api_key, is_favorite, is_local, created_at FROM endpoints WHERE id = ?"
    )
    .bind(id.to_string())
    .fetch_optional(&*state.db)
    .await?;
    
    let endpoint_config = match endpoint_config {
        Some(config) => config,
        None => {
            // Fallback to config in memory (for env-configured endpoints)
            state.config.endpoints.iter()
                .find(|e| e.id == id)
                .cloned()
                .ok_or_else(|| ApiError::NotFound(format!("Endpoint {} not found", id)))?
        }
    };
    
    let client = harness_core::LLMClient::new(endpoint_config);
    let is_healthy = client.health_check().await.unwrap_or(false);
    
    Ok(Json(TestEndpointResponse {
        endpoint_id: id,
        is_healthy,
        message: if is_healthy { "Connection successful".into() } else { "Connection failed".into() },
    }))
}

#[derive(Debug, Serialize)]
struct TestEndpointResponse {
    endpoint_id: Uuid,
    is_healthy: bool,
    message: String,
}

/// List projects
pub async fn list_projects(
    State(_state): State<AppState>,
) -> Json<Vec<ProjectInfo>> {
    // Placeholder - would query database
    Json(Vec::new())
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub description: Option<String>,
}

/// Create a new project
pub async fn create_project(
    State(_state): State<AppState>,
    Json(req): Json<CreateProjectRequest>,
) -> Result<Json<ProjectInfo>, ApiError> {
    let project = ProjectInfo {
        id: Uuid::new_v4(),
        name: req.name,
        description: req.description,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    };
    
    // In a real implementation, save to database
    
    Ok(Json(project))
}

/// Get a specific project
pub async fn get_project(
    Path(id): Path<Uuid>,
) -> Result<Json<ProjectInfo>, ApiError> {
    // Placeholder - would query database
    Err(ApiError::NotFound(format!("Project {} not found", id)))
}

/// Discover services on the local network
pub async fn discover_services(
    State(_state): State<AppState>,
) -> Result<Json<Vec<harness_core::models::EndpointConfig>>, ApiError> {
    let discovery = harness_core::ServiceDiscovery::new()?;
    let endpoints = discovery.discover_ollama().await?;
    Ok(Json(endpoints))
}

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

#[derive(Debug, Deserialize)]
pub struct CreateSnapshotQuery {
    pub name: Option<String>,
    pub description: Option<String>,
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
    
    // First verify the snapshot belongs to this project
    let (snapshot, _) = state.snapshot_service
        .get_snapshot(snapshot_id)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    
    if snapshot.project_id != project_id {
        return Err(ApiError::NotFound("Snapshot does not belong to this project".into()));
    }
    
    let response = state.snapshot_service
        .restore_snapshot(request)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    
    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
pub struct RestoreSnapshotBody {
    pub dry_run: Option<bool>,
    pub create_backup: Option<bool>,
}

/// Get diff between two snapshots
pub async fn diff_snapshots(
    Path((project_id, snapshot_id)): Path<(Uuid, Uuid)>,
    axum::extract::Query(params): axum::extract::Query<DiffSnapshotsParams>,
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

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Deserialize)]
pub struct ChatQueryParams {
    pub endpoint_id: Option<uuid::Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Database error types
#[derive(Debug)]
pub enum DbError {
    NotFound(String),
    Sqlx(sqlx::Error),
    Json(serde_json::Error),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::NotFound(msg) => write!(f, "Not found: {}", msg),
            DbError::Sqlx(e) => write!(f, "Database error: {}", e),
            DbError::Json(e) => write!(f, "JSON error: {}", e),
        }
    }
}

impl From<sqlx::Error> for DbError {
    fn from(e: sqlx::Error) -> Self {
        DbError::Sqlx(e)
    }
}

impl From<serde_json::Error> for DbError {
    fn from(e: serde_json::Error) -> Self {
        DbError::Json(e)
    }
}

/// API error types
#[derive(Debug)]
pub enum ApiError {
    NotFound(String),
    Config(String),
    Internal(String),
    Core(harness_core::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            ApiError::Config(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
            ApiError::Core(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

impl From<harness_core::Error> for ApiError {
    fn from(e: harness_core::Error) -> Self {
        ApiError::Core(e)
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!("Database error: {}", e);
        ApiError::Internal(e.to_string())
    }
}
