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
pub async fn chat_stream(
    State(state): State<AppState>,
    Path(model_id): Path<String>,
    Query(params): Query<ChatQueryParams>,
    Json(request): Json<ChatRequest>,
) -> Response {
    use futures::StreamExt;
    
    // Get endpoint from query param or use default
    let endpoint_config = if let Some(endpoint_id) = params.endpoint_id {
        // Try database first (manual row parsing to handle TEXT UUID columns)
        let db_endpoint = sqlx::query(
            "SELECT id, name, base_url, api_key, is_favorite, is_local, created_at FROM endpoints WHERE id = ?"
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
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "No LLM endpoint configured. Please add an endpoint in Settings."}))).into_response();
        }
    };
    
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
                let event = axum::response::sse::Event::default().data(chunk.content);
                match chunk.chunk_type {
                    harness_core::ChunkType::Reasoning => {
                        Ok(event.event("reasoning"))
                    }
                    harness_core::ChunkType::Content => {
                        Ok(event)
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
    // Try to find in database first (manual row parsing to handle TEXT UUID columns)
    let endpoint_config = sqlx::query(
        "SELECT id, name, base_url, api_key, is_favorite, is_local, created_at FROM endpoints WHERE id = ?"
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
        let created_at: String = row.get(6);
        harness_core::models::EndpointConfig {
            id: uuid::Uuid::parse_str(&id_str).unwrap_or_else(|_| uuid::Uuid::new_v4()),
            name,
            base_url,
            api_key,
            is_favorite: is_favorite != 0,
            is_local: is_local != 0,
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
    
    let result = GitService::git_commit_and_push(
        &project_path, &message,
        author_name.as_deref(),
        author_email.as_deref(),
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

    // Init git if needed
    GitService::git_init(&state.config.data_dir)
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
        &state.config.data_dir,
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

    std::fs::write(&full_path, &req.content)
        .map_err(|e| ApiError::Internal(format!("Failed to write file: {}", e)))?;

    Ok(Json(serde_json::json!({ "success": true, "path": req.path })))
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
    
    // Security: prevent directory traversal
    let base = state.config.data_dir.join(&project_name);
    match file_path.canonicalize() {
        Ok(resolved) if resolved.starts_with(&base) => {
            match tokio::fs::read(&resolved).await {
                Ok(content) => {
                    let mime = if path.ends_with(".html") || path.ends_with(".htm") {
                        "text/html"
                    } else if path.ends_with(".css") {
                        "text/css"
                    } else if path.ends_with(".js") {
                        "application/javascript"
                    } else if path.ends_with(".json") {
                        "application/json"
                    } else if path.ends_with(".svg") {
                        "image/svg+xml"
                    } else if path.ends_with(".png") {
                        "image/png"
                    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
                        "image/jpeg"
                    } else {
                        "text/plain"
                    };
                    Ok((
                        [(axum::http::header::CONTENT_TYPE, mime)],
                        content,
                    ))
                }
                Err(_) => Err(ApiError::NotFound("File not found".into())),
            }
        }
        _ => Err(ApiError::Config("Path traversal not allowed".into())),
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

// ============================================================
// Self-Host Deployment Handler
// ============================================================

#[derive(Debug, Deserialize)]
pub(crate) struct DeployRequest {
    pub connection_id: uuid::Uuid,
    pub project_id: uuid::Uuid,
    pub app_name: String,
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

    // Build and deploy based on service type
    let base = base_url.trim_end_matches('/');
    let client = reqwest::Client::new();

    match service_type.as_str() {
        "coolify" => {
            // Create a Dockerfile-based application on Coolify
            let create_url = format!("{}/api/v1/applications/dockerfile", base);
            
            let payload = serde_json::json!({
                "name": req.app_name,
                "description": format!("Deployed from Monastery — project: {}", project_name),
                "ports_exposes": port.to_string(),
                "base_directory": "/",
                "dockerfile": std::fs::read_to_string(&dockerfile_path)
                    .unwrap_or_else(|_| format!("FROM node:18-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE {}\nCMD [\"npm\", \"start\"]", port)),
            });

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

            // Trigger deployment
            let deploy_url = format!("{}/api/v1/applications/{}/deploy", base, app_uuid);
            let deploy_resp = client
                .post(&deploy_url)
                .header("Authorization", format!("Bearer {}", api_token))
                .send()
                .await
                .map_err(|e| ApiError::Internal(format!("Deploy trigger failed: {}", e)))?;

            let deploy_success = deploy_resp.status().is_success();

            Ok(Json(serde_json::json!({
                "success": true,
                "platform": "coolify",
                "app_uuid": app_uuid,
                "app_name": req.app_name,
                "deploy_triggered": deploy_success,
                "dashboard_url": format!("{}/applications/{}", base.trim_end_matches("/api/v1"), app_uuid),
                "framework": framework,
                "port": port,
            })))
        }
        "dokploy" => {
            // Dokploy: create an application
            let create_url = format!("{}/api/application", base);
            
            let payload = serde_json::json!({
                "name": req.app_name,
                "description": format!("Deployed from Monastery — project: {}", project_name),
                "type": "dockerfile",
                "port": port,
                "dockerfile": std::fs::read_to_string(&dockerfile_path)
                    .unwrap_or_else(|_| format!("FROM node:18-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE {}\nCMD [\"npm\", \"start\"]", port)),
            });

            let resp = client
                .post(&create_url)
                .header("x-api-key", &api_token)
                .header("Content-Type", "application/json")
                .json(&payload)
                .send()
                .await
                .map_err(|e| ApiError::Internal(format!("Dokploy API request failed: {}", e)))?;

            let dokploy_status = resp.status();
            if !dokploy_status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Err(ApiError::Internal(format!(
                    "Dokploy returned HTTP {}: {}",
                    dokploy_status.as_u16(),
                    if body.len() > 300 { format!("{}...", &body[..300]) } else { body }
                )));
            }

            let app: serde_json::Value = resp.json().await
                .map_err(|e| ApiError::Internal(format!("Failed to parse Dokploy response: {}", e)))?;

            let app_id = app["applicationId"].as_str()
                .or_else(|| app["id"].as_str())
                .unwrap_or("unknown");

            // Trigger deploy
            let deploy_url = format!("{}/api/application/{}/deploy", base, app_id);
            let deploy_resp = client
                .post(&deploy_url)
                .header("x-api-key", &api_token)
                .send()
                .await
                .map_err(|e| ApiError::Internal(format!("Deploy trigger failed: {}", e)))?;

            let deploy_success = deploy_resp.status().is_success();

            Ok(Json(serde_json::json!({
                "success": true,
                "platform": "dokploy",
                "app_id": app_id,
                "app_name": req.app_name,
                "deploy_triggered": deploy_success,
                "dashboard_url": format!("{}/dashboard/applications/{}", base.trim_end_matches("/api"), app_id),
                "framework": framework,
                "port": port,
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
fn generate_dockerfile(framework: &str, _build_cmd: &str, output_dir: &str, port: u16) -> String {
    match framework {
        "nextjs" => format!(
            r#"FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
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
RUN npm ci
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
RUN npm ci --production
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
        "SELECT id, name, base_url, api_key, is_favorite, is_local, created_at FROM endpoints LIMIT 1"
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
                let event = axum::response::sse::Event::default().data(chunk.content);
                match chunk.chunk_type {
                    harness_core::ChunkType::Reasoning => Ok(event.event("reasoning")),
                    harness_core::ChunkType::Content => Ok(event),
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
