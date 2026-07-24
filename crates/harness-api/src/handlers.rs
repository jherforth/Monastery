//! API route handlers

use axum::{
    extract::{Path, State, Query},
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

/// Make a string safe for an SSE data field. axum's `Event::data` splits `\n` into multiple
/// `data:` lines, but PANICS on `\r` (assertion in sse.rs) — and model output can contain
/// CRLF (e.g. DeepSeek echoing a Windows-authored file from context), which killed the
/// tokio worker mid-stream. Normalize all CR variants to plain `\n`.
fn sse_safe(s: impl AsRef<str>) -> String {
    s.as_ref().replace("\r\n", "\n").replace('\r', "\n")
}

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
    let endpoints = sqlx::query("SELECT id, name, base_url, api_key, is_favorite, is_local, max_tokens, temperature, created_at FROM endpoints")
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
                let max_tokens: Option<i64> = row.get(6);
                let temperature: Option<f64> = row.get(7);
                let created_at: String = row.get(8);
                
                Some(harness_core::models::EndpointConfig {
                    id: uuid::Uuid::parse_str(&id).ok()?,
                    name,
                    base_url,
                    api_key,
                    is_favorite: is_favorite != 0,
                    is_local: is_local != 0,
                    max_tokens: max_tokens.map(|v| v as u32),
                    temperature: temperature.map(|v| v as f32),
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
pub async fn chat_stream(
    State(state): State<AppState>,
    Path(model_id): Path<String>,
    Query(params): Query<ChatQueryParams>,
    Json(request): Json<ChatRequest>,
) -> Response {
    use futures::StreamExt;
    
    // Get endpoint from query param or use default
    let mut endpoint_config = if let Some(endpoint_id) = params.endpoint_id {
        // Try database first
        let db_endpoint = sqlx::query(
            "SELECT id, name, base_url, api_key, is_favorite, is_local, max_tokens, temperature, created_at FROM endpoints WHERE id = ?"
        )
        .bind(endpoint_id.to_string())
        .fetch_optional(&*state.db)
        .await
        .ok()
        .flatten()
        .map(|row| {
            let id: String = row.get(0);
            let name: String = row.get(1);
            let base_url: String = row.get(2);
            let api_key: Option<String> = row.get(3);
            let is_favorite: i64 = row.get(4);
            let is_local: i64 = row.get(5);
            let max_tokens: Option<i64> = row.get(6);
            let temperature: Option<f64> = row.get(7);
            let created_at: String = row.get(8);
            harness_core::models::EndpointConfig {
                id: uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4()),
                name,
                base_url,
                api_key,
                is_favorite: is_favorite != 0,
                is_local: is_local != 0,
                max_tokens: max_tokens.map(|v| v as u32),
                temperature: temperature.map(|v| v as f32),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .unwrap_or_else(|_| chrono::Utc::now().fixed_offset())
                    .into(),
            }
        });
        
        match db_endpoint.or_else(|| {
            state.config.endpoints.iter()
                .find(|e| e.id == endpoint_id)
                .cloned()
        }) {
            Some(config) => config,
            None => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": format!("Endpoint {} not found", endpoint_id)}))).into_response(),
        }
    } else {
        // Use first available endpoint
        let endpoints = sqlx::query("SELECT id, name, base_url, api_key, is_favorite, is_local, max_tokens, temperature, created_at FROM endpoints")
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
            let max_tokens: Option<i64> = row.get(6);
            let temperature: Option<f64> = row.get(7);
            let created_at: String = row.get(8);
            
            harness_core::models::EndpointConfig {
                id: uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4()),
                name,
                base_url,
                api_key,
                is_favorite: is_favorite != 0,
                is_local: is_local != 0,
                max_tokens: max_tokens.map(|v| v as u32),
                temperature: temperature.map(|v| v as f32),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .unwrap_or_else(|_| chrono::Utc::now().fixed_offset())
                    .into(),
            }
        } else {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "No LLM endpoint configured. Please add an endpoint in Settings."}))).into_response();
        }
    };

    // Apply per-request overrides from query params (takes priority over endpoint defaults)
    if let Some(mt) = params.max_tokens {
        endpoint_config.max_tokens = Some(mt);
    }
    if let Some(temp) = params.temperature {
        endpoint_config.temperature = Some(temp);
    }
    
    let base_url = endpoint_config.base_url.clone();
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
    
    let model_for_log = model_id.clone();
    let stream = match client.chat_stream(messages, model_id).await {
        Ok(s) => {
            tracing::info!("Chat stream created for model {} at {}", model_for_log, base_url);
            s
        },
        Err(e) => {
            tracing::error!("Failed to create chat stream: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
    };
    
    // Create SSE stream with keepalive and proper termination
    use axum::response::Sse;
    use std::time::Duration;
    
    let event_stream = stream.map(|result| {
        match result {
            Ok(chunk) => {
                let event = axum::response::sse::Event::default().data(sse_safe(chunk.content));
                match chunk.chunk_type {
                    harness_core::ChunkType::Reasoning => {
                        Ok(event.event("reasoning"))
                    }
                    harness_core::ChunkType::Content => {
                        Ok(event)
                    }
                    harness_core::ChunkType::FinishReason => {
                        Ok(event.event("finish_reason"))
                    }
                    harness_core::ChunkType::Usage => {
                        Ok(event.event("usage"))
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Stream error: {}", e);
                Err(axum::Error::new(e))
            }
        }
    });

    Sse::new(event_stream)
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response()
}

/// List configured endpoints (from database)
pub async fn list_endpoints(
    State(state): State<AppState>,
) -> Result<Json<Vec<harness_core::models::EndpointConfig>>, ApiError> {
    use sqlx::Row;
    
    let endpoints = sqlx::query("SELECT id, name, base_url, api_key, is_favorite, is_local, max_tokens, temperature, created_at FROM endpoints")
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
            let max_tokens: Option<i64> = row.get(6);
            let temperature: Option<f64> = row.get(7);
            let created_at: String = row.get(8);
            
            harness_core::models::EndpointConfig {
                id: uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4()),
                name,
                base_url,
                api_key,
                is_favorite: is_favorite != 0,
                is_local: is_local != 0,
                max_tokens: max_tokens.map(|v| v as u32),
                temperature: temperature.map(|v| v as f32),
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

    // Auto-detect sensible defaults for this provider
    let (max_tokens, temperature) = harness_core::models::EndpointConfig::detect_defaults(&req.base_url);
    
    let endpoint_id = Uuid::new_v4();
    let now = chrono::Utc::now().to_rfc3339();
    
    // Save to database
    sqlx::query(
        "INSERT INTO endpoints (id, name, base_url, api_key, is_favorite, is_local, max_tokens, temperature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(endpoint_id.to_string())
    .bind(&req.name)
    .bind(&req.base_url)
    .bind(req.api_key.as_deref())
    .bind(0i64) // is_favorite = false
    .bind(if is_local { 1i64 } else { 0i64 })
    .bind(max_tokens.map(|v| v as i64))
    .bind(temperature)
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
        max_tokens,
        temperature,
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
    // Try to find in database first (manual row parsing to handle TEXT UUID columns)
    let endpoint_config = sqlx::query(
        "SELECT id, name, base_url, api_key, is_favorite, is_local, max_tokens, temperature, created_at FROM endpoints WHERE id = ?"
    )
    .bind(id.to_string())
    .fetch_optional(&*state.db)
    .await?
    .map(|row| {
        let id_str: String = row.get(0);
        let name: String = row.get(1);
        let base_url: String = row.get(2);
        let api_key: Option<String> = row.get(3);
        let is_favorite: i64 = row.get(4);
        let is_local: i64 = row.get(5);
        let max_tokens: Option<i64> = row.get(6);
        let temperature: Option<f64> = row.get(7);
        let created_at: String = row.get(8);
        harness_core::models::EndpointConfig {
            id: uuid::Uuid::parse_str(&id_str).unwrap_or_else(|_| uuid::Uuid::new_v4()),
            name,
            base_url,
            api_key,
            is_favorite: is_favorite != 0,
            is_local: is_local != 0,
            max_tokens: max_tokens.map(|v| v as u32),
            temperature: temperature.map(|v| v as f32),
            created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                .unwrap_or_else(|_| chrono::Utc::now().fixed_offset())
                .into(),
        }
    });
    
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
    let (is_healthy, message) = match client.health_check().await {
        Ok(true) => (true, "Connection successful".to_string()),
        Ok(false) => (false, "Connection failed".to_string()),
        Err(e) => (false, e.to_string()),
    };
    
    Ok(Json(TestEndpointResponse {
        endpoint_id: id,
        is_healthy,
        message,
    }))
}

#[derive(Debug, Serialize)]
pub struct TestEndpointResponse {
    pub endpoint_id: Uuid,
    pub is_healthy: bool,
    pub message: String,
}

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
}

/// Create a new project
pub async fn create_project(
    State(state): State<AppState>,
    Json(req): Json<CreateProjectRequest>,
) -> Result<Json<ProjectInfo>, ApiError> {
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

// ============================================================
// Session Handlers
// ============================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: Uuid,
    pub project_id: Option<Uuid>,
    pub title: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub message_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionDetail {
    pub id: Uuid,
    pub project_id: Option<Uuid>,
    pub title: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub messages: Vec<SessionMessage>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionMessage {
    pub id: Uuid,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub title: Option<String>,
}

/// List sessions for a project
pub async fn list_sessions(
    Path(project_id): Path<Uuid>,
    State(state): State<AppState>,
) -> Result<Json<Vec<SessionInfo>>, ApiError> {
    use sqlx::Row;
    
    let rows = sqlx::query(
        r#"
        SELECT s.id, s.project_id, s.title, s.created_at, s.updated_at,
               COUNT(m.id) as message_count
        FROM sessions s
        LEFT JOIN session_messages m ON s.id = m.session_id
        WHERE s.project_id = ?
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        "#
    )
    .bind(project_id.to_string())
    .fetch_all(&*state.db)
    .await?;
    
    let sessions: Vec<SessionInfo> = rows.iter().map(|row| {
        let id: String = row.get(0);
        let project_id_str: Option<String> = row.get(1);
        let title: String = row.get(2);
        let created_at: String = row.get(3);
        let updated_at: String = row.get(4);
        let message_count: i64 = row.get(5);
        
        SessionInfo {
            id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::new_v4()),
            project_id: project_id_str.and_then(|s| Uuid::parse_str(&s).ok()),
            title,
            created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
            updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at)
                .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
            message_count,
        }
    }).collect();
    
    Ok(Json(sessions))
}

/// Create a new session
pub async fn create_session(
    Path(project_id): Path<Uuid>,
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> Result<Json<SessionDetail>, ApiError> {
    let session_id = Uuid::new_v4();
    let now = chrono::Utc::now();
    let now_str = now.to_rfc3339();
    let title = req.title.unwrap_or_else(|| format!("Chat {}", now.format("%Y-%m-%d %H:%M")));
    
    sqlx::query(
        "INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(session_id.to_string())
    .bind(project_id.to_string())
    .bind(&title)
    .bind(&now_str)
    .bind(&now_str)
    .execute(&*state.db)
    .await?;
    
    Ok(Json(SessionDetail {
        id: session_id,
        project_id: Some(project_id),
        title,
        created_at: now,
        updated_at: now,
        messages: Vec::new(),
    }))
}

/// Get a session with its messages
pub async fn get_session(
    Path((_project_id, session_id)): Path<(Uuid, Uuid)>,
    State(state): State<AppState>,
) -> Result<Json<SessionDetail>, ApiError> {
    use sqlx::Row;
    
    // Get session metadata
    let session_row = sqlx::query(
        "SELECT id, project_id, title, created_at, updated_at FROM sessions WHERE id = ?"
    )
    .bind(session_id.to_string())
    .fetch_optional(&*state.db)
    .await?;
    
    let session_row = match session_row {
        Some(r) => r,
        None => return Err(ApiError::NotFound(format!("Session {} not found", session_id))),
    };
    
    let id: String = session_row.get(0);
    let project_id_str: Option<String> = session_row.get(1);
    let title: String = session_row.get(2);
    let created_at: String = session_row.get(3);
    let updated_at: String = session_row.get(4);
    
    // Get messages
    let message_rows = sqlx::query(
        "SELECT id, role, content, model, created_at FROM session_messages WHERE session_id = ? ORDER BY created_at ASC"
    )
    .bind(session_id.to_string())
    .fetch_all(&*state.db)
    .await?;
    
    let messages: Vec<SessionMessage> = message_rows.iter().map(|row| {
        let msg_id: String = row.get(0);
        let role: String = row.get(1);
        let content: String = row.get(2);
        let model: Option<String> = row.get(3);
        let msg_created_at: String = row.get(4);
        
        SessionMessage {
            id: Uuid::parse_str(&msg_id).unwrap_or_else(|_| Uuid::new_v4()),
            role,
            content,
            model,
            created_at: chrono::DateTime::parse_from_rfc3339(&msg_created_at)
                .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
        }
    }).collect();
    
    Ok(Json(SessionDetail {
        id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::new_v4()),
        project_id: project_id_str.and_then(|s| Uuid::parse_str(&s).ok()),
        title,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
            .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_at)
            .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
        messages,
    }))
}

/// Update session title
pub async fn update_session(
    Path((_project_id, session_id)): Path<(Uuid, Uuid)>,
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> Result<Json<SessionDetail>, ApiError> {
    let now = chrono::Utc::now().to_rfc3339();
    
    if let Some(title) = &req.title {
        sqlx::query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
            .bind(title)
            .bind(&now)
            .bind(session_id.to_string())
            .execute(&*state.db)
            .await?;
    }
    
    // Return updated session (reuse get_session logic)
    get_session(Path((_project_id, session_id)), State(state)).await
}

/// Delete a session and its messages (CASCADE)
pub async fn delete_session(
    Path((_project_id, session_id)): Path<(Uuid, Uuid)>,
    State(state): State<AppState>,
) -> Result<StatusCode, ApiError> {
    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(session_id.to_string())
        .execute(&*state.db)
        .await?;
    
    Ok(StatusCode::NO_CONTENT)
}

/// Add a message to a session
#[derive(Debug, Deserialize)]
pub struct AddMessageRequest {
    pub role: String,
    pub content: String,
    pub model: Option<String>,
}

pub async fn add_session_message(
    Path((_project_id, session_id)): Path<(Uuid, Uuid)>,
    State(state): State<AppState>,
    Json(req): Json<AddMessageRequest>,
) -> Result<Json<SessionMessage>, ApiError> {
    let msg_id = Uuid::new_v4();
    let now = chrono::Utc::now().to_rfc3339();
    
    sqlx::query(
        "INSERT INTO session_messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(msg_id.to_string())
    .bind(session_id.to_string())
    .bind(&req.role)
    .bind(&req.content)
    .bind(req.model.as_deref())
    .bind(&now)
    .execute(&*state.db)
    .await?;
    
    // Update session's updated_at
    sqlx::query("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(session_id.to_string())
        .execute(&*state.db)
        .await?;
    
    Ok(Json(SessionMessage {
        id: msg_id,
        role: req.role,
        content: req.content,
        model: req.model,
        created_at: chrono::DateTime::parse_from_rfc3339(&now)
            .unwrap_or_else(|_| chrono::Utc::now().fixed_offset()).into(),
    }))
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
    Path(project_id): Path<Uuid>,
    State(state): State<AppState>,
    Json(req): Json<CheckpointBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;
    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
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
    use sqlx::Row;
    
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
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;
    let project_name: String = match row {
        Some(r) => r.get(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };
    let project_path = state.config.data_dir.join(&project_name);
    
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
    /// Per-request override for max output tokens.
    /// Overrides the endpoint's auto-detected default.
    pub max_tokens: Option<u32>,
    /// Per-request override for sampling temperature.
    /// Overrides the endpoint's auto-detected default.
    pub temperature: Option<f32>,
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

// ============================================================
// Git Forge Handlers
// ============================================================

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
fn build_git_connection(row: &sqlx::sqlite::SqliteRow) -> GitConnection {
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
        use sqlx::Row;
        let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
            .bind(project_id)
            .fetch_optional(&*state.db)
            .await?;
        match row {
            Some(r) => {
                let name: String = r.get(0);
                state.config.data_dir.join(&name)
            }
            None => return Err(ApiError::NotFound("Project not found".into())),
        }
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
    
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id_str)
        .fetch_optional(&*state.db)
        .await?;
    
    let project_name: String = match row {
        Some(r) => r.get(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };
    
    let project_path = state.config.data_dir.join(&project_name);
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
    use sqlx::Row;
    let project_id_str = params.get("project_id")
        .ok_or_else(|| ApiError::Config("Missing project_id".into()))?;
    let project_id = uuid::Uuid::parse_str(project_id_str)
        .map_err(|_| ApiError::Config("Invalid project_id".into()))?;

    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id_str)
        .fetch_optional(&*state.db)
        .await?;
    let project_name: String = match row {
        Some(r) => r.get(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };
    let project_path = state.config.data_dir.join(&project_name);

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

/// Helper: recursively read files for snapshot creation
fn read_files_for_snapshot(
    base: &std::path::Path,
    current: &std::path::Path,
    files: &mut Vec<harness_core::snapshot::SnapshotFileInput>,
) {
    if let Ok(read_dir) = std::fs::read_dir(current) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if name == ".git" || name == "node_modules" || name == "target" { continue; }
            
            let rel_path = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();
            
            if path.is_dir() {
                read_files_for_snapshot(base, &path, files);
            } else if let Ok(content) = std::fs::read_to_string(&path) {
                files.push(harness_core::snapshot::SnapshotFileInput {
                    file_path: rel_path,
                    content: Some(content),
                });
            }
        }
    }
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
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;
    let project_name: String = match row {
        Some(r) => r.get(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };
    let project_dir = state.config.data_dir.join(&project_name);
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

/// Delete a project: removes its database records (sessions, messages, snapshots) AND
/// wipes its directory from the data dir. This is what lets a user abandon a broken
/// state entirely and re-clone a git repo/branch fresh — a clone into an existing
/// directory fails, so the local copy must be removable.
pub async fn delete_project(
    Path(project_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;
    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    // Wipe the project directory. Guard against path escape: the resolved dir must live
    // directly inside data_dir (project names are single path segments).
    let project_path = state.config.data_dir.join(&project_name);
    if project_path.exists() {
        let canonical = project_path.canonicalize()
            .map_err(|e| ApiError::Internal(format!("Failed to resolve project dir: {}", e)))?;
        let canonical_base = state.config.data_dir.canonicalize()
            .map_err(|e| ApiError::Internal(format!("Failed to resolve data dir: {}", e)))?;
        if canonical.parent() != Some(canonical_base.as_path()) {
            return Err(ApiError::Config("Refusing to delete: project dir is not directly inside the data dir".into()));
        }
        tokio::fs::remove_dir_all(&canonical).await
            .map_err(|e| ApiError::Internal(format!("Failed to delete project directory: {}", e)))?;
    }

    // Delete DB records explicitly (SQLite FK cascades only fire with foreign_keys pragma on).
    let pid = project_id.to_string();
    sqlx::query("DELETE FROM snapshot_files WHERE snapshot_id IN (SELECT id FROM snapshots WHERE project_id = ?)")
        .bind(&pid).execute(&*state.db).await?;
    sqlx::query("DELETE FROM snapshot_tags WHERE snapshot_id IN (SELECT id FROM snapshots WHERE project_id = ?)")
        .bind(&pid).execute(&*state.db).await?;
    sqlx::query("DELETE FROM snapshots WHERE project_id = ?")
        .bind(&pid).execute(&*state.db).await?;
    sqlx::query("DELETE FROM session_messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)")
        .bind(&pid).execute(&*state.db).await?;
    sqlx::query("DELETE FROM sessions WHERE project_id = ?")
        .bind(&pid).execute(&*state.db).await?;
    sqlx::query("DELETE FROM project_files WHERE project_id = ?")
        .bind(&pid).execute(&*state.db).await?;
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(&pid).execute(&*state.db).await?;

    Ok(Json(serde_json::json!({ "success": true, "deleted": project_name })))
}

/// List files in a project directory
pub async fn list_project_files(
    Path(project_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    // Look up the project to get its name
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
    if !project_path.exists() {
        return Ok(Json(Vec::new()));
    }

    let files = walk_directory(&project_path, &project_path);
    Ok(Json(files))
}

/// Read a single file from a project
pub async fn read_project_file(
    Path(project_id): Path<uuid::Uuid>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let file_path = params.get("path").ok_or_else(|| ApiError::Config("Missing path parameter".into()))?;
    let full_path = state.config.data_dir.join(&project_name).join(file_path);

    // Security: ensure the resolved path is within the project directory
    let canonical_base = state.config.data_dir.join(&project_name).canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;
    let canonical_file = full_path.canonicalize()
        .map_err(|_| ApiError::NotFound("File not found".into()))?;
    if !canonical_file.starts_with(&canonical_base) {
        return Err(ApiError::Config("Path traversal not allowed".into()));
    }

    let content = std::fs::read_to_string(&canonical_file)
        .map_err(|e| ApiError::Internal(format!("Failed to read file: {}", e)))?;

    Ok(Json(serde_json::json!({ "content": content, "path": file_path })))
}

/// Write content to a file in a project
#[derive(Debug, Deserialize)]
pub struct WriteFileRequest {
    pub path: String,
    pub content: String,
    /// "base64" = content is base64-encoded binary (e.g. an uploaded image) and must be
    /// decoded to raw bytes before writing. Absent/other = plain text.
    #[serde(default)]
    pub encoding: Option<String>,
    /// When true (AI-generated writes), refuse to replace an existing non-trivial file whose
    /// new content is merely a contiguous slice of the old — the "model emitted a section as a
    /// whole-file block, wiping the rest" failure. Manual saves/uploads leave this false.
    #[serde(default)]
    pub guard_partial_overwrite: bool,
}

pub async fn write_project_file(
    Path(project_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
    Json(req): Json<WriteFileRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let full_path = state.config.data_dir.join(&project_name).join(&req.path);

    // Security: ensure the resolved path is within the project directory
    let canonical_base = state.config.data_dir.join(&project_name).canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;
    
    // Create parent directories if needed
    if let Some(parent) = full_path.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| ApiError::Internal(format!("Failed to create directories: {}", e)))?;
    }
    
    // Security check: after creating dirs, canonicalize the path to verify it's within the project
    // For new files, canonicalize will fail, so we check the parent
    let resolved = if full_path.exists() {
        full_path.canonicalize()
            .map_err(|_| ApiError::Internal("Failed to resolve file path".into()))?
    } else {
        // For new files, check the parent directory is within the project
        let parent = full_path.parent().unwrap_or(&full_path);
        let canonical_parent = parent.canonicalize()
            .map_err(|_| ApiError::Internal("Failed to resolve parent path".into()))?;
        if !canonical_parent.starts_with(&canonical_base) {
            return Err(ApiError::Config("Path traversal not allowed".into()));
        }
        // Use the full_path directly for writing (it's validated)
        full_path.clone()
    };
    
    // Final security check for existing files
    if full_path.exists() && !resolved.starts_with(&canonical_base) {
        return Err(ApiError::Config("Path traversal not allowed".into()));
    }

    if req.encoding.as_deref() == Some("base64") {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(req.content.trim())
            .map_err(|e| ApiError::Config(format!("Invalid base64 content: {}", e)))?;
        std::fs::write(&full_path, bytes)
            .map_err(|e| ApiError::Internal(format!("Failed to write file: {}", e)))?;
    } else {
        // Guardrail against the "section clobbered the whole file" bug: if the model sends a
        // whole-file write whose content is literally a contiguous slice of the existing file,
        // it's almost certainly a partial edit mis-formatted as a full file. Refuse it and tell
        // the model to use a SEARCH/REPLACE edit block. (Low false-positive: a genuine rewrite
        // essentially never reproduces itself as an exact substring of the original.)
        if req.guard_partial_overwrite && full_path.exists() {
            if let Ok(existing) = std::fs::read_to_string(&full_path) {
                let new_trim = req.content.trim();
                let old_trim = existing.trim();
                if old_trim.len() > 400
                    && new_trim.len() < old_trim.len()
                    && old_trim.contains(new_trim)
                {
                    return Err(ApiError::Config(format!(
                        "Refusing to overwrite {}: the new content is just a section of the existing file (the rest would be lost). Re-send this change as a SEARCH/REPLACE edit block instead of a whole-file block.",
                        req.path
                    )));
                }
            }
        }
        std::fs::write(&full_path, &req.content)
            .map_err(|e| ApiError::Internal(format!("Failed to write file: {}", e)))?;
    }

    Ok(Json(serde_json::json!({ "success": true, "path": req.path })))
}

/// Apply targeted SEARCH/REPLACE edits to an existing file — a real modify-in-place, so the
/// model can change one section without re-emitting (and risking truncating) the whole file.
/// Each edit's `search` text is located in the current on-disk file and swapped for `replace`.
#[derive(Debug, Deserialize)]
pub struct EditFileRequest {
    pub path: String,
    pub edits: Vec<SearchReplace>,
}

#[derive(Debug, Deserialize)]
pub struct SearchReplace {
    pub search: String,
    pub replace: String,
}

/// Find `needle` in `hay` and return the (start, end) byte range of the first match. Tiers, from
/// strict to loose, so a model that slightly misquotes a section still lands the edit:
///   1. exact substring
///   2. line-by-line, ignoring TRAILING whitespace
///   3. line-by-line, ignoring LEADING+TRAILING whitespace (indentation drift — the common case
///      where the model reflows/re-indents the SEARCH block relative to the real file)
///   4. as (3) but ignoring blank lines on both sides (stray blank line in the SEARCH block)
fn find_match_range(hay: &str, needle: &str, loose: bool) -> Option<(usize, usize)> {
    if needle.trim().is_empty() {
        return None;
    }
    // Tier 1: exact.
    if let Some(pos) = hay.find(needle) {
        return Some((pos, pos + needle.len()));
    }

    let hay_lines: Vec<&str> = hay.lines().collect();
    // Byte offset of the start of each line (for reconstructing the match range).
    let mut line_starts = Vec::with_capacity(hay_lines.len() + 1);
    let mut off = 0usize;
    for l in &hay_lines {
        line_starts.push(off);
        off += l.len();
        // account for the '\n' that `lines()` stripped (assumes LF; CRLF is normalized on write)
        if off < hay.len() {
            off += 1;
        }
    }
    line_starts.push(hay.len());

    // Reconstruct the byte range spanning hay lines [first, last].
    let byte_range = |first: usize, last: usize| -> (usize, usize) {
        let start_byte = line_starts[first];
        let end_byte = if last + 1 < hay_lines.len() {
            line_starts[last + 1].saturating_sub(1)
        } else {
            hay.len()
        };
        (start_byte, end_byte)
    };

    // Contiguous line match with a given per-line normalizer (tiers 2 & 3).
    fn norm_line(l: &str, trim_both: bool) -> &str {
        if trim_both { l.trim() } else { l.trim_end() }
    }
    let windowed = |trim_both: bool| -> Option<(usize, usize)> {
        let needle_norm: Vec<&str> = needle.lines().map(|l| norm_line(l, trim_both)).collect();
        if needle_norm.is_empty() || hay_lines.len() < needle_norm.len() {
            return None;
        }
        for start in 0..=(hay_lines.len() - needle_norm.len()) {
            if needle_norm.iter().enumerate().all(|(i, nl)| norm_line(hay_lines[start + i], trim_both) == *nl) {
                return Some(byte_range(start, start + needle_norm.len() - 1));
            }
        }
        None
    };

    if let Some(r) = windowed(false) { return Some(r); }
    if let Some(r) = windowed(true) { return Some(r); }

    // Tier 4: match the non-blank lines only (blank lines ignored on both sides), fully trimmed.
    let needle_ne: Vec<&str> = needle.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if needle_ne.is_empty() {
        return None;
    }
    let hay_ne: Vec<(usize, &str)> = hay_lines.iter().enumerate()
        .map(|(i, l)| (i, l.trim()))
        .filter(|(_, l)| !l.is_empty())
        .collect();
    if hay_ne.len() < needle_ne.len() {
        return None;
    }
    for start in 0..=(hay_ne.len() - needle_ne.len()) {
        if (0..needle_ne.len()).all(|k| hay_ne[start + k].1 == needle_ne[k]) {
            let first_line = hay_ne[start].0;
            let last_line = hay_ne[start + needle_ne.len() - 1].0;
            return Some(byte_range(first_line, last_line));
        }
    }

    // Tier 5: fuzzy — the model got most of the block right but misquoted a line or two. Slide a
    // window and score by positional line similarity (fully trimmed). `loose` (an escalated retry)
    // lowers the bar: strict = >=4 lines, >=80% match, SOLE best window; loose = >=3 lines, >=60%
    // match, first-best on a tie. The pre-edit snapshot backstops the residual wrong-region risk.
    let needle_t: Vec<&str> = needle.lines().map(|l| l.trim()).collect();
    let n = needle_t.len();
    let (min_lines, ratio_num, ratio_den, require_unique) =
        if loose { (3usize, 3usize, 5usize, false) } else { (4usize, 4usize, 5usize, true) };
    if n >= min_lines && hay_lines.len() >= n {
        let hay_t: Vec<&str> = hay_lines.iter().map(|l| l.trim()).collect();
        let score = |start: usize| -> usize {
            (0..n).filter(|&i| hay_t[start + i] == needle_t[i]).count()
        };
        let last_start = hay_t.len() - n;
        let mut best_start = 0usize;
        let mut best_count = 0usize;
        for start in 0..=last_start {
            let c = score(start);
            if c > best_count { best_count = c; best_start = start; }
        }
        let unique = !require_unique
            || (0..=last_start).filter(|&s| score(s) == best_count).count() == 1;
        // best_count/n >= ratio_num/ratio_den, integer-safe.
        if best_count * ratio_den >= n * ratio_num && unique {
            return Some(byte_range(best_start, best_start + n - 1));
        }
    }

    None
}

pub async fn edit_project_file(
    Path(project_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    Json(req): Json<EditFileRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // `loose=true` (an escalated retry, "digging deeper") lowers the fuzzy matcher's bar.
    let loose = params.get("loose").map(|v| v == "true").unwrap_or(false);

    let project_dir = resolve_project_dir(&state, project_id).await?;
    let full_path = project_dir.join(&req.path);

    let canonical_base = project_dir.canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;
    let resolved = full_path.canonicalize()
        .map_err(|_| ApiError::NotFound(format!("File not found: {}", req.path)))?;
    if !resolved.starts_with(&canonical_base) {
        return Err(ApiError::Config("Path traversal not allowed".into()));
    }

    let mut content = tokio::fs::read_to_string(&resolved).await
        .map_err(|e| ApiError::Internal(format!("Failed to read file: {}", e)))?;

    let mut applied = 0usize;
    // Failed hunks returned in FULL (search+replace) so the frontend's escalating retry can
    // re-attempt exactly those without re-applying the ones that already landed.
    let mut failed: Vec<serde_json::Value> = Vec::new();
    for edit in &req.edits {
        match find_match_range(&content, &edit.search, loose) {
            Some((s, e)) => {
                content.replace_range(s..e, &edit.replace);
                applied += 1;
            }
            None => {
                failed.push(serde_json::json!({ "search": edit.search, "replace": edit.replace }));
            }
        }
    }

    // Only persist if something actually applied — never write a no-op that could truncate.
    if applied > 0 {
        std::fs::write(&resolved, &content)
            .map_err(|e| ApiError::Internal(format!("Failed to write file: {}", e)))?;
    }

    Ok(Json(serde_json::json!({
        "success": applied > 0,
        "path": req.path,
        "applied": applied,
        "failed": failed,
        "content": content,
    })))
}

/// Serve a project file for preview (static file serving)
pub async fn project_preview(
    Path((project_id, path)): Path<(uuid::Uuid, String)>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let file_path = state.config.data_dir.join(&project_name).join(&path);

    // Security: prevent directory traversal. The base must be canonicalized too —
    // comparing a canonicalized file path against a raw base fails whenever data_dir
    // is relative or crosses a symlink (common with Docker volumes), which used to
    // surface as a bogus 400 for perfectly valid files.
    let base = state.config.data_dir.join(&project_name);
    let base = base.canonicalize().unwrap_or(base);
    match file_path.canonicalize() {
        Ok(resolved) if resolved.starts_with(&base) => {
            match tokio::fs::read(&resolved).await {
                Ok(mut content) => {
                    let lower = path.to_lowercase();
                    let mime = if lower.ends_with(".html") || lower.ends_with(".htm") {
                        "text/html"
                    } else if lower.ends_with(".css") {
                        "text/css"
                    } else if lower.ends_with(".js") {
                        "application/javascript"
                    } else if lower.ends_with(".json") {
                        "application/json"
                    } else if lower.ends_with(".svg") {
                        "image/svg+xml"
                    } else if lower.ends_with(".png") {
                        "image/png"
                    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
                        "image/jpeg"
                    } else if lower.ends_with(".gif") {
                        "image/gif"
                    } else if lower.ends_with(".webp") {
                        "image/webp"
                    } else if lower.ends_with(".ico") {
                        "image/x-icon"
                    } else if lower.ends_with(".bmp") {
                        "image/bmp"
                    } else if lower.ends_with(".avif") {
                        "image/avif"
                    } else if lower.ends_with(".woff2") {
                        "font/woff2"
                    } else if lower.ends_with(".woff") {
                        "font/woff"
                    } else {
                        "text/plain"
                    };
                    // Self-heal binary files uploaded before base64 decoding existed: they were
                    // stored as the literal data-URL text ("data:image/png;base64,...."). Decode
                    // to real bytes and persist so the file is fixed for good, not just this GET.
                    if mime.starts_with("image/") && content.starts_with(b"data:") {
                        if let Some(idx) = content.iter().position(|&b| b == b',') {
                            use base64::Engine as _;
                            let payload = &content[idx + 1..];
                            if let Ok(decoded) = base64::engine::general_purpose::STANDARD
                                .decode(payload.strip_suffix(b"\n").unwrap_or(payload))
                            {
                                let _ = tokio::fs::write(&resolved, &decoded).await;
                                content = decoded;
                            }
                        }
                    }
                    Ok((
                        [(axum::http::header::CONTENT_TYPE, mime)],
                        content,
                    ))
                }
                Err(_) => Err(ApiError::NotFound("File not found".into())),
            }
        }
        Ok(_) => Err(ApiError::Config("Path traversal not allowed".into())),
        // canonicalize() fails when the file simply doesn't exist — that's a 404, not a
        // traversal attempt. For the default preview entry point, serve a friendly
        // placeholder instead: the preview pane is open by default, and an empty or
        // just-created project shouldn't greet the user with an error.
        Err(_) => {
            if path == "index.html" {
                let placeholder = format!(
                    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Preview</title></head>\
                     <body style=\"margin:0;display:flex;align-items:center;justify-content:center;\
                     min-height:100vh;font-family:system-ui,sans-serif;background:#F5F0E8;color:#57534e\">\
                     <div style=\"text-align:center;max-width:24rem;padding:2rem\">\
                     <div style=\"font-size:2.5rem\">🏛️</div>\
                     <h1 style=\"font-size:1.1rem;margin:0.75rem 0 0.25rem\">Nothing to preview yet</h1>\
                     <p style=\"font-size:0.9rem;line-height:1.5\">Ask the assistant to build something — \
                     when <code>index.html</code> lands in \"{}\", it appears here automatically.</p>\
                     </div></body></html>",
                    project_name
                );
                return Ok((
                    [(axum::http::header::CONTENT_TYPE, "text/html")],
                    placeholder.into_bytes(),
                ));
            }
            Err(ApiError::NotFound("File not found".into()))
        }
    }
}

/// Execute a shell command in a project directory
#[derive(Debug, Deserialize)]
pub struct ShellRequest {
    pub command: String,
}

pub async fn project_shell(
    Path(project_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
    Json(req): Json<ShellRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
    
    // Security: only allow safe commands
    let safe_prefixes = ["npm", "npx", "node", "pnpm", "yarn", "git", "ls", "cat", "echo", "mkdir", "touch", "rm", "cp", "mv"];
    let cmd_lower = req.command.trim().to_lowercase();
    let is_safe = safe_prefixes.iter().any(|prefix| cmd_lower.starts_with(prefix));
    
    if !is_safe {
        return Ok(Json(serde_json::json!({
            "success": false,
            "error": "Command not allowed for security reasons. Allowed: npm, git, ls, cat, echo, mkdir, touch, etc."
        })));
    }
    
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(&req.command)
        .current_dir(&project_path)
        .output()
        .map_err(|e| ApiError::Internal(format!("Failed to execute command: {}", e)))?;
    
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    
    Ok(Json(serde_json::json!({
        "success": output.status.success(),
        "output": stdout,
        "stderr": stderr,
        "exit_code": output.status.code().unwrap_or(-1),
    })))
}

// ---------------------------------------------------------------------------
// Staged coding workflow — local task store under <project>/.monastery/tasks/
// A task is the SAW-style "system of record": a human-readable spec.md (goal + acceptance criteria
// + definition of done + affected files) plus task.json (stage + exit-state chain) plus an
// evidence/ folder. Kept as plain files in the repo so it's transparent and version-controlled.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct ExitState {
    pub stage: String,        // plan | implement | verify | review
    pub status: String,       // complete | failed | in_progress
    pub exit_state: String,   // human marker, e.g. "Ready for Verify"
    #[serde(default)]
    pub evidence: Option<String>,
    pub at: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TaskMeta {
    pub id: String,
    pub title: String,
    pub stage: String,        // plan | implement | verify | review | done
    #[serde(default)]
    pub affected_files: Vec<String>,
    #[serde(default)]
    pub exit_states: Vec<ExitState>,
    #[serde(default)]
    pub verify_command: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Resolve a project's on-disk directory (data_dir/<name>) from its id.
async fn resolve_project_dir(state: &AppState, project_id: uuid::Uuid) -> Result<std::path::PathBuf, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db).await?;
    match row {
        Some(r) => Ok(state.config.data_dir.join(r.get::<String, _>(0))),
        None => Err(ApiError::NotFound("Project not found".into())),
    }
}

fn tasks_dir(project_dir: &std::path::Path) -> std::path::PathBuf {
    project_dir.join(".monastery").join("tasks")
}

fn read_task_meta(task_dir: &std::path::Path) -> Option<TaskMeta> {
    serde_json::from_str(&std::fs::read_to_string(task_dir.join("task.json")).ok()?).ok()
}

fn write_task_meta(task_dir: &std::path::Path, meta: &TaskMeta) -> Result<(), ApiError> {
    let s = serde_json::to_string_pretty(meta).map_err(|e| ApiError::Internal(e.to_string()))?;
    std::fs::write(task_dir.join("task.json"), s)
        .map_err(|e| ApiError::Internal(format!("write task.json: {}", e)))
}

/// GET /api/projects/:id/tasks — list task summaries (newest first).
pub async fn list_tasks(
    Path(project_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
) -> Result<Json<Vec<TaskMeta>>, ApiError> {
    let dir = tasks_dir(&resolve_project_dir(&state, project_id).await?);
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.path().is_dir() {
                if let Some(meta) = read_task_meta(&e.path()) {
                    out.push(meta);
                }
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Optional pre-rendered spec.md (from a task template); falls back to a generic skeleton.
    #[serde(default)]
    pub spec: Option<String>,
}

/// POST /api/projects/:id/tasks — create a task (dir + task.json + spec.md template).
pub async fn create_task(
    Path(project_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
    Json(req): Json<CreateTaskRequest>,
) -> Result<Json<TaskMeta>, ApiError> {
    let dir = tasks_dir(&resolve_project_dir(&state, project_id).await?);
    let id = uuid::Uuid::new_v4().to_string();
    let task_dir = dir.join(&id);
    std::fs::create_dir_all(task_dir.join("evidence"))
        .map_err(|e| ApiError::Internal(format!("create task dir: {}", e)))?;
    let now = chrono::Utc::now().to_rfc3339();
    let meta = TaskMeta {
        id: id.clone(),
        title: req.title.clone(),
        stage: "plan".into(),
        affected_files: vec![],
        exit_states: vec![],
        verify_command: None,
        session_id: req.session_id,
        created_at: now.clone(),
        updated_at: now,
    };
    write_task_meta(&task_dir, &meta)?;
    let spec_template = req.spec.unwrap_or_else(|| format!(
        "# {}\n\n## Goal\n\n_What are we building and why?_\n\n## Acceptance Criteria\n\n- [ ] \n\n## Definition of Done\n\n- [ ] Build/tests pass\n\n## Affected Files\n\n- \n\n## Approach\n\n_Plan the implementation here._\n",
        req.title
    ));
    std::fs::write(task_dir.join("spec.md"), spec_template)
        .map_err(|e| ApiError::Internal(format!("write spec.md: {}", e)))?;
    Ok(Json(meta))
}

/// GET /api/projects/:id/tasks/:taskId — task meta + spec.md content.
pub async fn get_task(
    Path((project_id, task_id)): Path<(uuid::Uuid, String)>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let task_dir = tasks_dir(&resolve_project_dir(&state, project_id).await?).join(&task_id);
    let meta = read_task_meta(&task_dir).ok_or_else(|| ApiError::NotFound("Task not found".into()))?;
    let spec = std::fs::read_to_string(task_dir.join("spec.md")).unwrap_or_default();
    Ok(Json(serde_json::json!({ "meta": meta, "spec": spec })))
}

#[derive(Deserialize)]
pub struct UpdateTaskRequest {
    #[serde(default)] pub title: Option<String>,
    #[serde(default)] pub stage: Option<String>,
    #[serde(default)] pub spec: Option<String>,
    #[serde(default)] pub affected_files: Option<Vec<String>>,
    #[serde(default)] pub verify_command: Option<String>,
    /// Append an exit state to the chain of custody.
    #[serde(default)] pub exit_state: Option<ExitState>,
}

/// PATCH /api/projects/:id/tasks/:taskId — update meta fields and/or spec.md.
pub async fn update_task(
    Path((project_id, task_id)): Path<(uuid::Uuid, String)>,
    State(state): State<AppState>,
    Json(req): Json<UpdateTaskRequest>,
) -> Result<Json<TaskMeta>, ApiError> {
    let task_dir = tasks_dir(&resolve_project_dir(&state, project_id).await?).join(&task_id);
    let mut meta = read_task_meta(&task_dir).ok_or_else(|| ApiError::NotFound("Task not found".into()))?;
    if let Some(t) = req.title { meta.title = t; }
    if let Some(s) = req.stage { meta.stage = s; }
    if let Some(f) = req.affected_files { meta.affected_files = f; }
    if let Some(v) = req.verify_command { meta.verify_command = Some(v); }
    if let Some(es) = req.exit_state { meta.exit_states.push(es); }
    meta.updated_at = chrono::Utc::now().to_rfc3339();
    write_task_meta(&task_dir, &meta)?;
    if let Some(spec) = req.spec {
        std::fs::write(task_dir.join("spec.md"), spec)
            .map_err(|e| ApiError::Internal(format!("write spec.md: {}", e)))?;
    }
    Ok(Json(meta))
}

#[derive(Deserialize)]
pub struct VerifyRequest {
    /// Defaults to the task's verify_command, else "npm run build".
    #[serde(default)] pub command: Option<String>,
}

/// POST /api/projects/:id/tasks/:taskId/verify — run the verify command in the project, capture
/// the output as evidence, and record a verify exit state. This is the "evidence-based handoff".
pub async fn verify_task(
    Path((project_id, task_id)): Path<(uuid::Uuid, String)>,
    State(state): State<AppState>,
    Json(req): Json<VerifyRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_dir = resolve_project_dir(&state, project_id).await?;
    let task_dir = tasks_dir(&project_dir).join(&task_id);
    let mut meta = read_task_meta(&task_dir).ok_or_else(|| ApiError::NotFound("Task not found".into()))?;
    let command = req.command.or_else(|| meta.verify_command.clone())
        .unwrap_or_else(|| "npm run build".to_string());
    // Safety allowlist (broader than project_shell — build/test tooling only).
    let safe = ["npm", "npx", "node", "pnpm", "yarn", "cargo", "python", "python3", "pytest", "go", "make", "tsc", "jest", "vitest"];
    let cl = command.trim().to_lowercase();
    if !safe.iter().any(|p| cl.starts_with(p)) {
        return Err(ApiError::Config(format!(
            "Verify command not allowed: '{}'. Allowed prefixes: {}", command, safe.join(", ")
        )));
    }
    let output = std::process::Command::new("sh")
        .arg("-c").arg(&command)
        .current_dir(&project_dir)
        .output()
        .map_err(|e| ApiError::Internal(format!("verify exec failed: {}", e)))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let code = output.status.code().unwrap_or(-1);
    let passed = output.status.success();
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S").to_string();
    let log_name = format!("verify-{}.log", ts);
    let log_body = format!(
        "$ {}\nexit code: {}\n\n=== stdout ===\n{}\n=== stderr ===\n{}\n",
        command, code, stdout, stderr
    );
    let _ = std::fs::write(task_dir.join("evidence").join(&log_name), &log_body);
    meta.exit_states.push(ExitState {
        stage: "verify".into(),
        status: if passed { "complete".into() } else { "failed".into() },
        exit_state: if passed { "Verified".into() } else { "Verify failed — back to Implement".into() },
        evidence: Some(format!("evidence/{}", log_name)),
        at: chrono::Utc::now().to_rfc3339(),
    });
    meta.updated_at = chrono::Utc::now().to_rfc3339();
    write_task_meta(&task_dir, &meta)?;
    Ok(Json(serde_json::json!({
        "passed": passed,
        "exit_code": code,
        "command": command,
        "evidence": format!("evidence/{}", log_name),
        "log": tail_chars(&log_body, 8000),
    })))
}

#[derive(Deserialize)]
pub struct ProjectSearchParams {
    pub q: String,
    #[serde(default)] pub max: Option<usize>,
}

/// GET /api/projects/:id/search?q=... — pattern discovery ("Search First, Reuse Always"). Uses
/// ripgrep when available, else a lightweight recursive walk. Feeds the Implement stage existing
/// code to reuse instead of regenerating it.
pub async fn search_project(
    Path(project_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
    Query(params): Query<ProjectSearchParams>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_dir = resolve_project_dir(&state, project_id).await?;
    let q = params.q.trim().to_string();
    if q.is_empty() {
        return Err(ApiError::Config("Missing search query 'q'".into()));
    }
    let max = params.max.unwrap_or(40);
    let mut matches: Vec<serde_json::Value> = Vec::new();

    let rg = std::process::Command::new("rg")
        .args(["--line-number", "--no-heading", "--color", "never", "--max-count", "5", "-i", &q])
        .current_dir(&project_dir)
        .output();
    let used_rg = match rg {
        Ok(out) if !out.stdout.is_empty() => {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines().take(max) {
                // path:line:content
                let mut parts = line.splitn(3, ':');
                if let (Some(path), Some(lineno), Some(content)) = (parts.next(), parts.next(), parts.next()) {
                    matches.push(serde_json::json!({
                        "path": path.replace('\\', "/"),
                        "line": lineno.parse::<u64>().unwrap_or(0),
                        "text": content.trim(),
                    }));
                }
            }
            true
        }
        _ => false,
    };

    if !used_rg {
        fn walk(dir: &std::path::Path, base: &std::path::Path, ql: &str, max: usize, out: &mut Vec<serde_json::Value>) {
            if out.len() >= max { return; }
            let skip = ["node_modules", ".git", "target", "dist", "build", ".monastery"];
            if let Ok(entries) = std::fs::read_dir(dir) {
                for e in entries.flatten() {
                    if out.len() >= max { return; }
                    let p = e.path();
                    let name = e.file_name().to_string_lossy().to_string();
                    if p.is_dir() {
                        if !skip.contains(&name.as_str()) { walk(&p, base, ql, max, out); }
                    } else if let Ok(content) = std::fs::read_to_string(&p) {
                        for (i, line) in content.lines().enumerate() {
                            if line.to_lowercase().contains(ql) {
                                let rel = p.strip_prefix(base).unwrap_or(p.as_path()).to_string_lossy().replace('\\', "/");
                                out.push(serde_json::json!({ "path": rel, "line": i as u64 + 1, "text": line.trim() }));
                                break; // one hit per file in the fallback
                            }
                        }
                    }
                }
            }
        }
        walk(&project_dir, &project_dir, &q.to_lowercase(), max, &mut matches);
    }

    Ok(Json(serde_json::json!({ "query": q, "matches": matches })))
}

/// Read all project files and return their contents
pub async fn read_all_project_files(
    Path(project_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
    if !project_path.exists() {
        return Ok(Json(serde_json::json!({ "files": {} })));
    }

    let mut files = serde_json::Map::new();
    read_files_recursive(&project_path, &project_path, &mut files, 0);
    
    Ok(Json(serde_json::json!({ "files": files })))
}

fn read_files_recursive(
    base: &std::path::Path,
    current: &std::path::Path,
    files: &mut serde_json::Map<String, serde_json::Value>,
    depth: usize,
) {
    if depth > 10 { return; } // Safety limit
    if let Ok(read_dir) = std::fs::read_dir(current) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if name == ".git" || name == "node_modules" || name == "target" { continue; }
            
            let rel_path = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();
            
            if path.is_dir() {
                read_files_recursive(base, &path, files, depth + 1);
            } else {
                // Skip images/fonts outright: real binaries would fail read_to_string anyway,
                // but files uploaded before base64 decoding existed are data-URL *text* and
                // would dump megabytes of base64 into the LLM context.
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "bmp" | "avif" | "woff" | "woff2" | "ttf" | "otf" | "eot" | "pdf" | "zip" | "gz" | "tar" | "mp3" | "mp4" | "wav" | "ogg" | "webm") {
                    continue;
                }
                // Read text files only (skip binaries)
                if let Ok(content) = std::fs::read_to_string(&path) {
                    // Limit file size to ~200KB per file (most source files are under this)
                    let truncated: String = if content.len() > 200_000 {
                        format!("{}... [truncated at 200KB]", &content[..200_000])
                    } else {
                        content
                    };
                    files.insert(rel_path, serde_json::Value::String(truncated));
                }
            }
        }
    }
}

/// Recursively walk a directory and return a FileNode tree
fn walk_directory(base: &std::path::Path, current: &std::path::Path) -> Vec<serde_json::Value> {
    let mut entries = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(current) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            // Skip .git directory
            if name == ".git" {
                continue;
            }
            let rel_path = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();
            let is_dir = path.is_dir();
            let children: Vec<serde_json::Value> = if is_dir {
                walk_directory(base, &path)
            } else {
                Vec::new()
            };
            entries.push(serde_json::json!({
                "name": name,
                "path": rel_path,
                "type": if is_dir { "directory" } else { "file" },
                "children": children,
            }));
        }
    }
    entries.sort_by(|a, b| {
        let a_dir = a["type"].as_str() == Some("directory");
        let b_dir = b["type"].as_str() == Some("directory");
        b_dir.cmp(&a_dir).then(a["name"].as_str().cmp(&b["name"].as_str()))
    });
    entries
}

// ============================================================
// Hosting Service Connection Handlers (Self-Host Wizard)
// ============================================================

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
        "SELECT id, name, service_type, base_url, api_token, username, email, is_default, created_at, last_synced_at FROM hosting_connections ORDER BY created_at DESC"
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
        })
    }).collect();

    Ok(Json(connections))
}

/// Connect a new hosting service
pub async fn connect_hosting_service(
    State(state): State<AppState>,
    Json(req): Json<ConnectHostingRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Validate service type
    if !["dokploy", "coolify", "pocketbase"].contains(&req.service_type.as_str()) {
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

// ============================================================
// Self-Host Deployment Handler
// ============================================================

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
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(req.project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
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

    Ok(Json(serde_json::json!({
        "framework": framework,
        "build_command": build_cmd,
        "output_dir": output_dir,
        "default_port": default_port,
        "port": port,
        "app_name": app_name,
        "files": files,
    })))
}

/// Git info needed to deploy a project from its forge repository.
struct GitDeployInfo {
    remote_url: String,
    branch: String,
    token: String,
}

/// Extract the host (and optional port) from a URL string without pulling in a URL crate.
fn url_host(url: &str) -> Option<String> {
    let after_scheme = url.split("://").nth(1)?;
    // Strip any userinfo (user:pass@) then take up to the first '/'.
    let authority = after_scheme.splitn(2, '/').next()?;
    let host = authority.rsplitn(2, '@').next()?; // part after '@' if present, else whole
    Some(host.to_string())
}

/// Build an authenticated clone URL using the forge token, for the in-Dockerfile `git clone`.
/// Uses the `oauth2:<token>@` form Forgejo/Gitea/GitLab accept, for both https and http (some
/// all-local forges are HTTP-only). Leaves SSH or already-credentialed URLs untouched.
fn build_authed_clone_url(remote_url: &str, token: &str) -> String {
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
async fn resolve_project_git(
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
async fn lookup_deployment(
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
async fn save_deployment(
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

/// POST a Dokploy tRPC mutation (`{ "json": input }`) and return the parsed response, mapping a
/// non-2xx tRPC error into a readable `ApiError` (so failures like a missing source provider surface
/// clearly instead of only showing up later in Dokploy's build logs).
async fn dokploy_mutation(
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
async fn resolve_pocketbase_url(state: &AppState, req: &DeployRequest) -> Option<String> {
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
fn coolify_logs_to_text(v: &serde_json::Value) -> String {
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
fn tail_chars(s: &str, max: usize) -> String {
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

/// Deploy a project to a connected hosting service
pub async fn deploy_to_hosting(
    State(state): State<AppState>,
    Json(req): Json<DeployRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Look up the hosting connection
    let conn_row = sqlx::query(
        "SELECT service_type, base_url, api_token FROM hosting_connections WHERE id = ?"
    )
    .bind(req.connection_id.to_string())
    .fetch_optional(&*state.db)
    .await?;

    let (service_type, base_url, api_token) = match conn_row {
        Some(r) => {
            let st: String = r.get(0);
            let bu: String = r.get(1);
            let at: String = r.get(2);
            (st, bu, at)
        }
        None => return Err(ApiError::NotFound("Hosting connection not found".into())),
    };

    // Look up the project
    let proj_row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(req.project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match proj_row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
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

    // Build and deploy based on service type
    let base = base_url.trim_end_matches('/');
    let client = reqwest::Client::new();

    match service_type.as_str() {
        "coolify" => {
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
            // allocated". Pick a stable high port per app (deterministic so redeploys keep the
            // same port); the Cloudflare tunnel, when used, also points at this port.
            let host_port: u16 = {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                req.app_name.hash(&mut h);
                20000 + (h.finish() % 10000) as u16
            };

            // If already deployed for this (project, connection), redeploy the SAME app with a
            // forced (no-cache) rebuild so the in-Dockerfile clone re-fetches the latest commit.
            // If the app was deleted in Coolify (404), drop the stale mapping and fall through to
            // create a fresh one — so a user who wipes the app in Coolify can just redeploy.
            if let Some(existing_uuid) = lookup_deployment(&state, req.project_id, req.connection_id).await? {
                // Refresh the app's stored Dockerfile FIRST. A Coolify redeploy rebuilds from the
                // Dockerfile it saved at create time; because that Dockerfile was byte-identical
                // every redeploy, the `git clone` layer stayed cached and the app kept serving the
                // code from its first build. Re-sending a freshly-generated Dockerfile (new
                // embedded cachebust) changes the clone layer's cache key so `force=true` actually
                // re-clones the latest commit. Best-effort: if the update fails we still trigger the
                // forced rebuild below (no worse than before).
                let dockerfile_b64 = base64::engine::general_purpose::STANDARD.encode(clone_dockerfile.as_bytes());
                let patch_url = format!("{}/api/v1/applications/{}", base, existing_uuid);
                match client
                    .patch(&patch_url)
                    .header("Authorization", format!("Bearer {}", api_token))
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({ "dockerfile": dockerfile_b64 }))
                    .send()
                    .await
                {
                    Ok(r) if r.status().is_success() => {
                        tracing::info!("Refreshed Coolify Dockerfile for app {} before redeploy", existing_uuid);
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
                        return Ok(Json(serde_json::json!({
                            "success": true,
                            "platform": "coolify",
                            "app_uuid": existing_uuid,
                            "app_name": req.app_name,
                            "deploy_triggered": true,
                            "redeployed": true,
                            "dashboard_url": format!("{}/projects", base.trim_end_matches("/api/v1")),
                            "framework": framework,
                            "port": port,
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
                "description": format!("Deployed from Monastery — project: {}", project_name),
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
                match req.cloudflare_tunnel_token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
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
                        tunnel_error = Some("Cloudflare tunnel was requested but no token was provided.".into());
                    }
                }
            }

            Ok(Json(serde_json::json!({
                "success": true,
                "platform": "coolify",
                "app_uuid": app_uuid,
                "app_name": req.app_name,
                "deploy_triggered": deploy_success,
                "redeployed": false,
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
                // The exact "Service" URL to set for the Public Hostname in the Cloudflare dashboard.
                // Use 127.0.0.1 (not "localhost"): cloudflared resolves "localhost" to IPv6 ::1,
                // but the published host port binds on IPv4 — so localhost gives "connection refused".
                "tunnel_service_url": if req.include_cloudflare_tunnel { Some(format!("http://127.0.0.1:{}", host_port)) } else { None },
                "pocketbase_url": pocketbase_url,
            })))
        }
        "dokploy" => {
            // Dokploy clones a git source and builds its Dockerfile — it does NOT accept an inline
            // Dockerfile. So we point Dokploy at the project's repo (custom git, token-in-URL) and
            // ensure a Dockerfile is committed there. Dokploy's custom-git provider is permissive
            // (no host validation), so it works with a local IP/.local Forgejo.
            //
            // tRPC note: query procedures use GET, mutations POST `{ "json": input }`; the list
            // endpoints are `server.all` / `project.all` (no `*.list`); `project.all` returns each
            // project with its nested (auto-created "production") environments.
            let git = resolve_project_git(&state, &project_path).await?;
            // Ensure the generated Dockerfile (written above if missing) and any local changes are
            // committed and pushed so Dokploy's clone includes them.
            if let Err(e) = harness_core::GitService::git_push(
                &project_path, &git.remote_url, &git.token, &git.branch,
                "Add/update Dockerfile for Dokploy deployment (Monastery)",
            ) {
                tracing::warn!("Could not push before Dokploy deploy (continuing; remote may be current): {}", e);
            }
            let git_repository = build_authed_clone_url(&git.remote_url, &git.token);

            // Redeploy the SAME app if we've deployed this (project, connection) before. On 404
            // (app deleted in Dokploy) drop the stale mapping and fall through to recreate.
            if let Some(existing_app_id) = lookup_deployment(&state, req.project_id, req.connection_id).await? {
                let deploy_url = format!("{}/api/trpc/application.deploy", base);
                match client.post(&deploy_url)
                    .header("x-api-key", &api_token).header("Content-Type", "application/json")
                    .json(&serde_json::json!({ "json": { "applicationId": existing_app_id } }))
                    .send().await
                {
                    Ok(r) if r.status().is_success() => {
                        return Ok(Json(serde_json::json!({
                            "success": true,
                            "platform": "dokploy",
                            "app_id": existing_app_id,
                            "app_name": req.app_name,
                            "deploy_triggered": true,
                            "redeployed": true,
                            "dashboard_url": format!("{}/dashboard/home", base.trim_end_matches("/api")),
                            "framework": framework,
                            "port": port,
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
                "description": format!("Deployed from Monastery — project: {}", project_name),
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

            // Stable host port for tunnel / LAN access (derived from the app name).
            let host_port: u16 = {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                req.app_name.hash(&mut h);
                20000 + (h.finish() % 10000) as u16
            };
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

            // If a tunnel is requested, publish the app's port on the host BEFORE deploying —
            // Swarm applies port mappings at deploy time, so adding it afterwards never takes effect.
            if req.include_cloudflare_tunnel {
                if let Err(e) = dokploy_mutation(&client, base, &api_token, "port.create", serde_json::json!({
                    "applicationId": app_id,
                    "publishedPort": host_port,
                    "targetPort": container_port,
                    "publishMode": "host",
                    "protocol": "tcp",
                })).await {
                    tunnel_error = Some(format!("port publish failed: {:?}", e));
                }
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
                match req.cloudflare_tunnel_token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
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
                    None => { tunnel_error = Some("Cloudflare tunnel was requested but no token was provided.".into()); }
                }
            }

            Ok(Json(serde_json::json!({
                "success": true,
                "platform": "dokploy",
                "app_id": app_id,
                "app_name": req.app_name,
                "deploy_triggered": deploy_success,
                "redeployed": false,
                "dashboard_url": format!("{}/dashboard/home", base.trim_end_matches("/api")),
                "framework": framework,
                "port": port,
                "host_port": host_port,
                "access_url": if req.include_cloudflare_tunnel { server_ip.as_ref().map(|ip| format!("http://{}:{}", ip, host_port)) } else { None },
                "tunnel_requested": req.include_cloudflare_tunnel,
                "tunnel_deployed": tunnel_deployed,
                "tunnel_error": tunnel_error,
                // Use 127.0.0.1 (not "localhost"): cloudflared resolves "localhost" to IPv6 ::1,
                // but the published host port binds on IPv4 — so localhost gives "connection refused".
                "tunnel_service_url": if req.include_cloudflare_tunnel { Some(format!("http://127.0.0.1:{}", host_port)) } else { None },
                "pocketbase_url": pocketbase_url,
            })))
        }
        other => Err(ApiError::Config(format!(
            "Deployment not yet supported for service type '{}'. Supported: coolify, dokploy",
            other
        ))),
    }
}

/// Detect the project framework from package.json
fn detect_framework(project_path: &std::path::Path) -> (String, String, String, u16) {
    let pkg_path = project_path.join("package.json");
    if !pkg_path.exists() {
        return ("static".into(), "echo 'No build needed'".into(), ".".into(), 3000);
    }

    let content = match std::fs::read_to_string(&pkg_path) {
        Ok(c) => c,
        Err(_) => return ("unknown".into(), "npm run build".into(), "dist".into(), 3000),
    };

    let pkg: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return ("unknown".into(), "npm run build".into(), "dist".into(), 3000),
    };

    let deps = pkg["dependencies"].as_object();
    let dev_deps = pkg["devDependencies"].as_object();
    let scripts = pkg["scripts"].as_object();

    let has_dep = |name: &str| -> bool {
        deps.map(|d| d.contains_key(name)).unwrap_or(false)
            || dev_deps.map(|d| d.contains_key(name)).unwrap_or(false)
    };

    if has_dep("next") {
        return ("nextjs".into(), "npm run build".into(), ".next".into(), 3000);
    }
    if has_dep("react") && has_dep("vite") {
        return ("vite-react".into(), "npm run build".into(), "dist".into(), 5173);
    }
    if has_dep("vue") || has_dep("@vue/cli-service") {
        return ("vue".into(), "npm run build".into(), "dist".into(), 8080);
    }
    if has_dep("react") {
        // Check for CRA
        if has_dep("react-scripts") {
            return ("react".into(), "npm run build".into(), "build".into(), 3000);
        }
        return ("react".into(), "npm run build".into(), "dist".into(), 3000);
    }
    if has_dep("express") {
        return ("express".into(), "echo 'No build step'".into(), ".".into(), 3000);
    }
    if has_dep("fastify") {
        return ("fastify".into(), "echo 'No build step'".into(), ".".into(), 3000);
    }

    // Check scripts for build commands
    if let Some(scripts) = scripts {
        if scripts.contains_key("build") {
            return ("node".into(), "npm run build".into(), "dist".into(), 3000);
        }
    }

    ("node".into(), "echo 'No build step'".into(), ".".into(), 3000)
}

/// Generate a Dockerfile for the detected framework
/// Generate a Dockerfile that clones the project repo at build time (instead of relying on a
/// build context). Returns the Dockerfile plus the port the resulting container actually
/// listens on. The clone disables TLS verification to tolerate self-signed homelab certs and
/// uses the token-bearing URL, so it works for forges on IPs/.local that Coolify itself can't
/// clone. `CACHEBUST` changes each generation so a fresh create rebuilds; redeploys pass
/// `force=true` for a no-cache rebuild.
fn generate_clone_dockerfile(
    framework: &str,
    output_dir: &str,
    build_port: u16,
    clone_url: &str,
    branch: &str,
) -> (String, u16) {
    let cachebust = chrono::Utc::now().timestamp();
    // The cachebust is embedded DIRECTLY in the clone RUN command (not just as an `ARG`) so the
    // layer's cache key changes every time the Dockerfile is regenerated — forcing Docker to
    // re-run `git clone` and fetch the latest commit. An `ARG` alone does NOT work: Docker only
    // busts cache at a build-arg's first *usage*, and the old Dockerfile never referenced it, so
    // the clone layer was cached and redeploys kept shipping the code from the first build.
    let node_clone = format!(
        "RUN apk add --no-cache git && echo \"monastery-cachebust {cb}\" && git -c http.sslVerify=false clone --depth 1 --single-branch --branch {b} \"{u}\" . && rm -rf .git",
        cb = cachebust, b = branch, u = clone_url
    );
    // Clone step for the prebuilt alpine/git image (git already present).
    let git_clone = format!(
        "RUN echo \"monastery-cachebust {cb}\" && git -c http.sslVerify=false clone --depth 1 --single-branch --branch {b} \"{u}\" . && rm -rf .git",
        cb = cachebust, b = branch, u = clone_url
    );

    match framework {
        "nextjs" => (format!(
            "FROM node:18-alpine AS builder\nWORKDIR /app\nARG CACHEBUST={cb}\n{clone}\nRUN npm install && npm run build\n\nFROM node:18-alpine AS runner\nWORKDIR /app\nENV NODE_ENV=production\nCOPY --from=builder /app/package*.json ./\nCOPY --from=builder /app/{out} ./{out}\nCOPY --from=builder /app/node_modules ./node_modules\nEXPOSE {p}\nCMD [\"npm\", \"start\"]\n",
            cb = cachebust, clone = node_clone, out = output_dir, p = build_port
        ), build_port),
        "vite-react" | "vue" | "react" => (format!(
            "FROM node:18-alpine AS builder\nWORKDIR /app\nARG CACHEBUST={cb}\n{clone}\nRUN npm install && npm run build\n\nFROM nginx:alpine\nCOPY --from=builder /app/{out} /usr/share/nginx/html\nEXPOSE 80\n",
            cb = cachebust, clone = node_clone, out = output_dir
        ), 80),
        "express" | "fastify" | "node" => (format!(
            "FROM node:18-alpine\nWORKDIR /app\nARG CACHEBUST={cb}\n{clone}\nRUN npm install --production\nEXPOSE {p}\nCMD [\"node\", \"index.js\"]\n",
            cb = cachebust, clone = node_clone, p = build_port
        ), build_port),
        // static / unknown: clone the repo and serve it as static files via nginx (port 80).
        _ => (format!(
            "FROM alpine/git AS source\nWORKDIR /src\nARG CACHEBUST={cb}\n{clone}\n\nFROM nginx:alpine\nCOPY --from=source /src /usr/share/nginx/html\nEXPOSE 80\n",
            cb = cachebust, clone = git_clone
        ), 80),
    }
}

fn generate_dockerfile(framework: &str, _build_cmd: &str, output_dir: &str, port: u16) -> String {
    match framework {
        "nextjs" => format!(
            r#"FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/{} ./{}
COPY --from=builder /app/node_modules ./node_modules
EXPOSE {}
CMD ["npm", "start"]
"#,
            output_dir, output_dir, port
        ),
        "vite-react" | "vue" | "react" => format!(
            r#"FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/{} /usr/share/nginx/html
EXPOSE {}
CMD ["nginx", "-g", "daemon off;"]
"#,
            output_dir, port
        ),
        "express" | "fastify" | "node" => format!(
            r#"FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE {}
CMD ["node", "index.js"]
"#,
            port
        ),
        _ => format!(
            r#"FROM node:18-alpine
WORKDIR /app
COPY . .
EXPOSE {}
CMD ["npx", "serve", "-l", "{}"]
"#,
            port, port
        ),
    }
}

/// Generate a docker-compose.yml that includes Pocketbase
fn generate_docker_compose(app_name: &str, port: u16, include_pocketbase: bool, include_tunnel: bool) -> String {
    let mut services = format!(
        r#"version: "3.8"

services:
  {app}:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "{port}:{port}"
"#,
        app = app_name,
        port = port,
    );

    if include_pocketbase {
        services.push_str(&format!(
            r#"    environment:
      - POCKETBASE_URL=http://pocketbase:8090
    depends_on:
      - pocketbase
    restart: unless-stopped

  pocketbase:
    image: ghcr.io/muchobien/pocketbase:latest
    ports:
      - "8090:8090"
    volumes:
      - ./pb_data:/pb_data
    environment:
      - PB_ENCRYPTION_KEY=change-me-in-production
    restart: unless-stopped
"#
        ));
    } else {
        services.push_str("    restart: unless-stopped\n");
    }

    if include_tunnel {
        services.push_str(&format!(
            r#"
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run --token ${{CF_TUNNEL_TOKEN}}
    environment:
      - CF_TUNNEL_TOKEN=${{CF_TUNNEL_TOKEN}}
    restart: unless-stopped
    network_mode: "service:{app}"
    depends_on:
      - {app}
"#,
            app = app_name,
        ));
    }

    services
}

// ============================================================
// Agent Run Handler
// ============================================================

#[derive(Debug, Deserialize)]
pub(crate) struct RunAgentRequest {
    pub system_prompt: String,
    pub task: String,
    pub project_id: uuid::Uuid,
}

/// Run a built-in agent with a custom system prompt, streaming the result via SSE
pub async fn run_agent(
    State(state): State<AppState>,
    Json(req): Json<RunAgentRequest>,
) -> Response {
    use futures::StreamExt;

    // Look up the project
    let proj_row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(req.project_id.to_string())
        .fetch_optional(&*state.db)
        .await;

    let project_name = match proj_row {
        Ok(Some(r)) => r.get::<String, _>(0),
        _ => String::new(),
    };

    let project_path = state.config.data_dir.join(&project_name);

    // Build project context from files
    let mut project_context = String::new();
    if project_path.exists() {
        let mut files = Vec::new();
        collect_files_for_context(&project_path, &project_path, &mut files);
        // Cap at ~200KB for agent context
        for (path, content) in files.iter().take(50) {
            let ext = std::path::Path::new(path).extension()
                .and_then(|e| e.to_str()).unwrap_or("");
            project_context.push_str(&format!("### {}\n```{}\n{}\n```\n\n", path, ext, content));
            if project_context.len() > 200_000 {
                project_context.push_str("\n... [additional files truncated]\n");
                break;
            }
        }
    }

    let full_system_prompt = format!(
        "{}\n\n## Project Context\nProject: {}\n\n{}",
        req.system_prompt, project_name, project_context
    );

    // Get the first available endpoint
    let endpoint_row = sqlx::query(
        "SELECT id, name, base_url, api_key, is_favorite, is_local, max_tokens, temperature, created_at FROM endpoints LIMIT 1"
    )
    .fetch_optional(&*state.db)
    .await
    .ok()
    .flatten();

    let endpoint_config = match endpoint_row {
        Some(row) => {
            let id: String = row.get(0);
            let name: String = row.get(1);
            let base_url: String = row.get(2);
            let api_key: Option<String> = row.get(3);
            let is_favorite: i64 = row.get(4);
            let is_local: i64 = row.get(5);
            let max_tokens: Option<i64> = row.get(6);
            let temperature: Option<f64> = row.get(7);
            let created_at: String = row.get(8);
            harness_core::models::EndpointConfig {
                id: uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4()),
                name,
                base_url,
                api_key,
                is_favorite: is_favorite != 0,
                is_local: is_local != 0,
                max_tokens: max_tokens.map(|v| v as u32),
                temperature: temperature.map(|v| v as f32),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                    .unwrap_or_else(|_| chrono::Utc::now().fixed_offset())
                    .into(),
            }
        }
        None => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "error": "No LLM endpoint configured. Add an endpoint in Settings."
            }))).into_response();
        }
    };

    let client = harness_core::LLMClient::new(endpoint_config);

    // Build messages
    let messages: Vec<async_openai::types::ChatCompletionRequestMessage> = vec![
        async_openai::types::ChatCompletionRequestSystemMessage {
            content: async_openai::types::ChatCompletionRequestSystemMessageContent::Text(full_system_prompt),
            name: None,
        }.into(),
        async_openai::types::ChatCompletionRequestUserMessage {
            content: async_openai::types::ChatCompletionRequestUserMessageContent::Text(req.task),
            name: None,
        }.into(),
    ];

    let model_id = "deepseek-chat".to_string();
    let stream = match client.chat_stream(messages, model_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("Agent stream failed: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": e.to_string()
            }))).into_response();
        }
    };

    // Stream as SSE
    use axum::response::Sse;
    use std::time::Duration;

    let event_stream = stream.map(|result| {
        match result {
            Ok(chunk) => {
                let event = axum::response::sse::Event::default().data(sse_safe(chunk.content));
                match chunk.chunk_type {
                    harness_core::ChunkType::Reasoning => Ok(event.event("reasoning")),
                    harness_core::ChunkType::Content => Ok(event),
                    harness_core::ChunkType::FinishReason => Ok(event.event("finish_reason")),
                    harness_core::ChunkType::Usage => Ok(event.event("usage")),
                }
            }
            Err(e) => {
                tracing::warn!("Agent stream error: {}", e);
                Err(axum::Error::new(e))
            }
        }
    });

    Sse::new(event_stream)
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive")
        )
        .into_response()
}

/// Collect files for agent context (recursive)
fn collect_files_for_context(
    base: &std::path::Path,
    current: &std::path::Path,
    files: &mut Vec<(String, String)>,
) {
    if let Ok(read_dir) = std::fs::read_dir(current) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name == ".git" || name == "node_modules" || name == "target" || name == ".next" || name == "dist" || name == "build" {
                continue;
            }
            let rel_path = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();
            if path.is_dir() {
                collect_files_for_context(base, &path, files);
            } else if let Ok(content) = std::fs::read_to_string(&path) {
                if content.len() < 100_000 {
                    files.push((rel_path, content));
                }
            }
        }
    }
}

// ============================================================
// File Operations Handlers (user-initiated, no LLM needed)
// ============================================================

/// Query param for file/directory path operations
#[derive(Debug, Deserialize)]
pub struct FilePathQuery {
    pub path: String,
}

/// Delete a file from a project
pub async fn delete_project_file(
    Path(project_id): Path<uuid::Uuid>,
    Query(query): Query<FilePathQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
    let canonical_base = project_path.canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;

    let full_path = project_path.join(&query.path);

    // Security: canonicalize and verify within project
    let resolved = full_path.canonicalize()
        .map_err(|_| ApiError::NotFound(format!("File not found: {}", query.path)))?;
    if !resolved.starts_with(&canonical_base) {
        return Err(ApiError::Config("Path traversal not allowed".into()));
    }
    if !resolved.is_file() {
        return Err(ApiError::Config("Path is not a file".into()));
    }

    std::fs::remove_file(&resolved)
        .map_err(|e| ApiError::Internal(format!("Failed to delete file: {}", e)))?;

    tracing::info!("Deleted file: {}", query.path);
    Ok(Json(serde_json::json!({ "success": true, "path": query.path })))
}

/// Create a new directory in a project
pub async fn create_project_directory(
    Path(project_id): Path<uuid::Uuid>,
    Query(query): Query<FilePathQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
    let canonical_base = project_path.canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;

    let full_path = project_path.join(&query.path);

    // Security: check the parent directory is within the project
    // The directory itself may not exist yet, so check its parent
    if let Some(parent) = full_path.parent() {
        if parent.exists() {
            let canonical_parent = parent.canonicalize()
                .map_err(|_| ApiError::Internal("Failed to resolve parent path".into()))?;
            if !canonical_parent.starts_with(&canonical_base) {
                return Err(ApiError::Config("Path traversal not allowed".into()));
            }
        }
    }

    if full_path.exists() {
        return Err(ApiError::Config(format!("Directory already exists: {}", query.path)));
    }

    std::fs::create_dir_all(&full_path)
        .map_err(|e| ApiError::Internal(format!("Failed to create directory: {}", e)))?;

    tracing::info!("Created directory: {}", query.path);
    Ok(Json(serde_json::json!({ "success": true, "path": query.path })))
}

/// Delete a directory and all its contents from a project
pub async fn delete_project_directory(
    Path(project_id): Path<uuid::Uuid>,
    Query(query): Query<FilePathQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
    let canonical_base = project_path.canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;

    let full_path = project_path.join(&query.path);

    // Security: canonicalize and verify within project
    let resolved = full_path.canonicalize()
        .map_err(|_| ApiError::NotFound(format!("Directory not found: {}", query.path)))?;
    if !resolved.starts_with(&canonical_base) {
        return Err(ApiError::Config("Path traversal not allowed".into()));
    }
    if !resolved.is_dir() {
        return Err(ApiError::Config("Path is not a directory".into()));
    }
    // Prevent deleting the project root itself
    if resolved == canonical_base {
        return Err(ApiError::Config("Cannot delete project root directory".into()));
    }

    std::fs::remove_dir_all(&resolved)
        .map_err(|e| ApiError::Internal(format!("Failed to delete directory: {}", e)))?;

    tracing::info!("Deleted directory: {}", query.path);
    Ok(Json(serde_json::json!({ "success": true, "path": query.path })))
}

/// Upload a file to a project (accepts raw binary bytes)
pub async fn upload_project_file(
    Path(project_id): Path<uuid::Uuid>,
    Query(query): Query<FilePathQuery>,
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
    let canonical_base = project_path.canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;

    let full_path = project_path.join(&query.path);

    // Create parent directories if needed
    if let Some(parent) = full_path.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| ApiError::Internal(format!("Failed to create directories: {}", e)))?;
    }

    // Security: check parent is within project
    if let Some(parent) = full_path.parent() {
        if parent.exists() {
            let canonical_parent = parent.canonicalize()
                .map_err(|_| ApiError::Internal("Failed to resolve parent path".into()))?;
            if !canonical_parent.starts_with(&canonical_base) {
                return Err(ApiError::Config("Path traversal not allowed".into()));
            }
        }
    }

    std::fs::write(&full_path, &body)
        .map_err(|e| ApiError::Internal(format!("Failed to write file: {}", e)))?;

    tracing::info!("Uploaded file: {} ({} bytes)", query.path, body.len());
    Ok(Json(serde_json::json!({ "success": true, "path": query.path, "size": body.len() })))
}

/// Move/rename a file or directory within a project
#[derive(Debug, Deserialize)]
pub struct MoveFileRequest {
    pub source: String,
    pub destination: String,
}

pub async fn move_project_file(
    Path(project_id): Path<uuid::Uuid>,
    State(state): State<AppState>,
    Json(req): Json<MoveFileRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    use sqlx::Row;
    let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
        .bind(project_id.to_string())
        .fetch_optional(&*state.db)
        .await?;

    let project_name = match row {
        Some(r) => r.get::<String, _>(0),
        None => return Err(ApiError::NotFound("Project not found".into())),
    };

    let project_path = state.config.data_dir.join(&project_name);
    let canonical_base = project_path.canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;

    let source_path = project_path.join(&req.source);
    let dest_path = project_path.join(&req.destination);

    // Verify source exists and is within project
    let canonical_source = source_path.canonicalize()
        .map_err(|_| ApiError::NotFound(format!("Source not found: {}", req.source)))?;
    if !canonical_source.starts_with(&canonical_base) {
        return Err(ApiError::Config("Source path traversal not allowed".into()));
    }

    // Verify destination parent is within project
    if let Some(parent) = dest_path.parent() {
        // Create parent dirs if needed
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| ApiError::Internal(format!("Failed to create target directories: {}", e)))?;
        let canonical_parent = parent.canonicalize()
            .map_err(|_| ApiError::Internal("Failed to resolve target parent path".into()))?;
        if !canonical_parent.starts_with(&canonical_base) {
            return Err(ApiError::Config("Destination path traversal not allowed".into()));
        }
    }

    // Prevent moving into self (source is a prefix of destination = moving into own subtree)
    if dest_path.starts_with(&canonical_source) {
        return Err(ApiError::Config("Cannot move a directory into itself".into()));
    }

    if dest_path.exists() {
        return Err(ApiError::Config(format!("Destination already exists: {}", req.destination)));
    }

    std::fs::rename(&canonical_source, &dest_path)
        .map_err(|e| ApiError::Internal(format!("Failed to move: {}", e)))?;

    tracing::info!("Moved {} -> {}", req.source, req.destination);
    Ok(Json(serde_json::json!({ "success": true, "source": req.source, "destination": req.destination })))
}

// ============================================================
// Hermes Agent Integration
// ============================================================

/// Request to create or update a Hermes connection
#[derive(Debug, Deserialize)]
pub struct HermesConnectionRequest {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
}

/// List all Hermes agent connections
pub async fn list_hermes_connections(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, name, base_url, api_key, is_default, created_at, last_used_at FROM hermes_connections ORDER BY created_at DESC"
    )
    .fetch_all(&*state.db)
    .await?;

    let connections: Vec<serde_json::Value> = rows.iter().map(|r| {
        let is_default: i64 = r.get(4);
        let last_used: Option<String> = r.get(6);
        serde_json::json!({
            "id": r.get::<String, _>(0),
            "name": r.get::<String, _>(1),
            "base_url": r.get::<String, _>(2),
            "api_key": r.get::<String, _>(3),
            "is_default": is_default != 0,
            "created_at": r.get::<String, _>(5),
            "last_used_at": last_used,
        })
    }).collect();

    Ok(Json(serde_json::json!({ "connections": connections })))
}

/// Create a new Hermes agent connection
pub async fn create_hermes_connection(
    State(state): State<AppState>,
    Json(req): Json<HermesConnectionRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    // If this is the first connection, make it default
    let existing_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM hermes_connections")
        .fetch_one(&*state.db)
        .await?;
    let is_default = if existing_count.0 == 0 { 1 } else { 0 };

    sqlx::query(
        "INSERT INTO hermes_connections (id, name, base_url, api_key, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(&id)
    .bind(&req.name)
    .bind(&req.base_url)
    .bind(&req.api_key)
    .bind(is_default)
    .bind(&now)
    .execute(&*state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "id": id,
        "name": req.name,
        "base_url": req.base_url,
        "is_default": is_default != 0,
        "created_at": now,
    })))
}

/// Delete a Hermes connection
pub async fn delete_hermes_connection(
    Path(connection_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let result = sqlx::query("DELETE FROM hermes_connections WHERE id = ?")
        .bind(&connection_id)
        .execute(&*state.db)
        .await?;

    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound("Connection not found".into()));
    }

    Ok(Json(serde_json::json!({ "success": true })))
}

/// Test a Hermes connection by calling its /v1/health or /v1/models endpoint
pub async fn test_hermes_connection(
    Path(connection_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let row = sqlx::query("SELECT base_url, api_key FROM hermes_connections WHERE id = ?")
        .bind(&connection_id)
        .fetch_optional(&*state.db)
        .await?;

    let (base_url, api_key) = match row {
        Some(r) => (
            r.get::<String, _>(0),
            r.get::<String, _>(1),
        ),
        None => return Err(ApiError::NotFound("Connection not found".into())),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| ApiError::Internal(format!("Failed to create HTTP client: {}", e)))?;

    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            // Update last_used_at
            let now = chrono::Utc::now().to_rfc3339();
            let _ = sqlx::query("UPDATE hermes_connections SET last_used_at = ? WHERE id = ?")
                .bind(&now)
                .bind(&connection_id)
                .execute(&*state.db)
                .await;

            Ok(Json(serde_json::json!({ "success": true, "status": r.status().as_u16() })))
        }
        Ok(r) => {
            let status = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            Ok(Json(serde_json::json!({ "success": false, "status": status, "error": body })))
        }
        Err(e) => {
            Ok(Json(serde_json::json!({ "success": false, "status": 0, "error": e.to_string() })))
        }
    }
}

/// Set a Hermes connection as the default
pub async fn set_default_hermes_connection(
    Path(connection_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Verify connection exists
    let exists = sqlx::query("SELECT 1 FROM hermes_connections WHERE id = ?")
        .bind(&connection_id)
        .fetch_optional(&*state.db)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("Connection not found".into()));
    }

    // Clear existing default
    sqlx::query("UPDATE hermes_connections SET is_default = 0")
        .execute(&*state.db)
        .await?;

    // Set new default
    sqlx::query("UPDATE hermes_connections SET is_default = 1 WHERE id = ?")
        .bind(&connection_id)
        .execute(&*state.db)
        .await?;

    Ok(Json(serde_json::json!({ "success": true })))
}

/// Request body for Hermes agent run
#[derive(Debug, Deserialize)]
pub struct HermesRunRequest {
    /// Full conversation to forward (preferred). Includes the system context the
    /// frontend builds (project file tree + contents) plus chat history.
    #[serde(default)]
    pub messages: Option<Vec<ChatMessage>>,
    /// Legacy single-task input. Used only when `messages` is absent.
    #[serde(default)]
    pub task: Option<String>,
    pub project_path: Option<String>,
    pub model: Option<String>,
}

/// Proxy a task to Hermes agent via SSE streaming
/// Uses the default Hermes connection to POST /v1/chat/completions
pub async fn hermes_agent_run(
    State(state): State<AppState>,
    Json(req): Json<HermesRunRequest>,
) -> Result<Response, ApiError> {
    use axum::response::sse::{Event, Sse};

    let row = sqlx::query(
        "SELECT base_url, api_key FROM hermes_connections WHERE is_default = 1 LIMIT 1"
    )
    .fetch_optional(&*state.db)
    .await?;

    let (base_url, api_key) = match row {
        Some(r) => (r.get::<String, _>(0), r.get::<String, _>(1)),
        None => {
            return Err(ApiError::Config(
                "No default Hermes connection configured. Add one in Settings → Hermes.".into(),
            ));
        }
    };

    // Build the chat completion request for Hermes /v1/chat/completions.
    // Prefer the full conversation (system context + history) when provided; otherwise
    // fall back to the legacy single-task shape with a built-in system prompt.
    let messages: Vec<serde_json::Value> = match req.messages.as_ref() {
        Some(msgs) if !msgs.is_empty() => msgs
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect(),
        _ => vec![
            serde_json::json!({
                "role": "system",
                "content": "You are a coding assistant. Write clean, working code. When creating files, output them as code blocks with the filename as a heading."
            }),
            serde_json::json!({
                "role": "user",
                "content": req.task.clone().unwrap_or_default(),
            }),
        ],
    };

    let mut body = serde_json::json!({
        "messages": messages,
        "stream": true,
    });

    if let Some(ref model) = req.model {
        body["model"] = serde_json::json!(model);
    }

    let client = reqwest::Client::new();
    let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError::Internal(format!("Hermes API request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(ApiError::Internal(format!("Hermes API error {}: {}", status, text)));
    }

    // Update last_used_at on the default connection
    let now = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query("UPDATE hermes_connections SET last_used_at = ? WHERE is_default = 1")
        .bind(&now)
        .execute(&*state.db)
        .await;

    // Stream the response back as SSE
    let stream = resp.bytes_stream();
    let sse_stream = async_stream::stream! {
        use futures::StreamExt;

        let mut buffer = Vec::new();
        tokio::pin!(stream);

        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buffer.extend_from_slice(&bytes);
                    // Emit complete lines
                    while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                        let line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
                        // strip trailing newline
                        let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
                        // Extract the SSE data payload (Hermes speaks OpenAI streaming format).
                        let payload = if let Some(rest) = line.strip_prefix("data: ") {
                            rest
                        } else if let Some(rest) = line.strip_prefix("data:") {
                            rest
                        } else {
                            continue;
                        };
                        let payload = payload.trim();
                        if payload.is_empty() || payload == "[DONE]" {
                            continue;
                        }
                        // Parse the OpenAI-style delta and emit clean events, matching the
                        // normal /chat path so the frontend handles both streams identically.
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) {
                            let delta = &json["choices"][0]["delta"];
                            if let Some(r) = delta["reasoning_content"].as_str().or_else(|| delta["reasoning"].as_str()) {
                                if !r.is_empty() {
                                    yield Ok::<_, std::convert::Infallible>(Event::default().event("reasoning").data(sse_safe(r)));
                                }
                            }
                            if let Some(c) = delta["content"].as_str() {
                                if !c.is_empty() {
                                    yield Ok(Event::default().data(sse_safe(c)));
                                }
                            }
                            // Hermes is an autonomous agent: it may emit tool calls rather than
                            // (or alongside) text. We can't drive its tool loop, but we surface the
                            // tool's name as a visible step so the response degrades gracefully
                            // instead of looking empty/broken. The name appears on the first delta
                            // of each tool call; later deltas carry only argument fragments.
                            if let Some(tool_calls) = delta["tool_calls"].as_array() {
                                for tc in tool_calls {
                                    if let Some(name) = tc["function"]["name"].as_str() {
                                        if !name.is_empty() {
                                            yield Ok(Event::default().data(format!("\n> 🔧 Hermes is running tool `{}`…\n", name)));
                                        }
                                    }
                                }
                            }
                            if let Some(reason) = json["choices"][0]["finish_reason"].as_str() {
                                if !reason.is_empty() {
                                    yield Ok(Event::default().event("finish_reason").data(reason.to_string()));
                                }
                            }
                            // Forward token usage if Hermes' upstream includes it (final chunk).
                            if let Some(usage) = json.get("usage") {
                                if usage.is_object() {
                                    yield Ok(Event::default().event("usage").data(usage.to_string()));
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    // Surface the interruption inline (as content) so the user keeps whatever
                    // streamed so far plus a clear note, instead of the whole turn erroring out.
                    yield Ok(Event::default().data(sse_safe(format!("\n\n⚠️ Hermes stream interrupted: {}", e))));
                    break;
                }
            }
        }
        // Signal done
        yield Ok(Event::default().data("[DONE]"));
    };

    // Keep-alive is critical on THIS route: Hermes can go silent for minutes while it runs
    // tools on a slow machine, and an idle connection gets killed by intermediaries (the
    // Cloudflare tunnel drops idle requests at ~100s → "network error" in the UI). The
    // other chat SSE routes already ping; this one was missing it.
    Ok(Sse::new(sse_stream)
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(std::time::Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response())
}
