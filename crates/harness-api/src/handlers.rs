//! API route handlers

use axum::{
    extract::{Path, State},
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
    body::Body,
};
use serde::{Deserialize, Serialize};
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
    let config = &state.config;
    let mut all_models = Vec::new();
    
    // Get the default or first endpoint
    if let Some(endpoint_config) = config.get_default_endpoint() {
        let client = harness_core::LLMClient::new(endpoint_config.clone());
        match client.list_models().await {
            Ok(models) => all_models.extend(models),
            Err(e) => tracing::warn!("Failed to fetch models: {}", e),
        }
    }
    
    Ok(Json(all_models))
}

/// Stream chat completion
pub async fn chat_stream(
    State(state): State<AppState>,
    Path(model_id): Path<String>,
    Json(request): Json<ChatRequest>,
) -> Result<Response, ApiError> {
    use async_openai::types::ChatCompletionRequestMessage;
    use futures::StreamExt;
    
    let config = &state.config;
    let endpoint_config = config.get_default_endpoint()
        .ok_or_else(|| ApiError::Config("No LLM endpoint configured".into()))?;
    
    let client = harness_core::LLMClient::new(endpoint_config.clone());
    
    // Convert messages to OpenAI format
    let messages: Vec<ChatCompletionRequestMessage> = request.messages
        .into_iter()
        .map(|m| {
            match m.role.as_str() {
                "user" => ChatCompletionRequestMessage::User(
                    async_openai::types::ChatCompletionRequestUserMessage {
                        content: async_openai::types::ChatCompletionRequestUserMessageContent::Text(m.content),
                    }.into()
                ),
                "assistant" => ChatCompletionRequestMessage::Assistant(
                    async_openai::types::ChatCompletionRequestAssistantMessage {
                        content: Some(m.content),
                        ..Default::default()
                    }.into()
                ),
                "system" => ChatCompletionRequestMessage::System(
                    async_openai::types::ChatCompletionRequestSystemMessage {
                        content: async_openai::types::ChatCompletionRequestSystemMessageContent::Text(m.content),
                    }.into()
                ),
                _ => ChatCompletionRequestMessage::User(
                    async_openai::types::ChatCompletionRequestUserMessage {
                        content: async_openai::types::ChatCompletionRequestUserMessageContent::Text(m.content),
                    }.into()
                ),
            }
        })
        .collect();
    
    let stream = client.chat_stream(messages, model_id).await?;
    
    // Create SSE stream
    use axum::response::Sse;
    use futures::stream::Stream;
    
    let event_stream = stream.map(|result| {
        match result {
            Ok(content) => Ok(axum::response::sse::Event::default().data(content)),
            Err(e) => Err(axum::response::sse::SseError::from(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))),
        }
    });
    
    Ok(Sse::new(event_stream).into_response())
}

/// List configured endpoints
pub async fn list_endpoints(
    State(state): State<AppState>,
) -> Json<Vec<harness_core::models::EndpointConfig>> {
    Json(state.config.endpoints.clone())
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
    
    let endpoint = harness_core::models::EndpointConfig {
        id: Uuid::new_v4(),
        name: req.name,
        base_url: req.base_url,
        api_key: req.api_key,
        is_favorite: false,
        is_local,
        created_at: chrono::Utc::now(),
    };
    
    // In a real implementation, save to database
    // For now, just return the created endpoint
    
    Ok(Json(endpoint))
}

/// Delete an endpoint
pub async fn delete_endpoint(
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    // In a real implementation, delete from database
    Ok(StatusCode::NO_CONTENT)
}

/// Test endpoint connectivity
pub async fn test_endpoint(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> Result<Json<TestEndpointResponse>, ApiError> {
    // Find the endpoint
    let endpoint_config = state.config.endpoints.iter()
        .find(|e| e.id == id)
        .ok_or_else(|| ApiError::NotFound(format!("Endpoint {} not found", id)))?;
    
    let client = harness_core::LLMClient::new(endpoint_config.clone());
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
    State(state): State<AppState>,
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
    pub files: Vec<harness_core::SnapshotFileInput>,
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
    Query(params): Query<DiffSnapshotsParams>,
    State(state): State<AppState>,
) -> Result<Json<harness_core::SnapshotDiff>, ApiError> {
    use axum::extract::Query;
    
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
    InternalServer,
    Internal(String),
    Core(harness_core::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            ApiError::Config(msg) => (StatusCode::BAD_REQUEST, msg),
            ApiError::InternalServer => (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".into()),
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
        ApiError::InternalServer
    }
}
