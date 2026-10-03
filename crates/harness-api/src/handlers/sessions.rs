//! Chat sessions and their persisted messages.

use super::*;

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
