//! Health, LLM endpoints and their models, and LAN discovery.

use super::*;

/// Health check endpoint
pub async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "healthy",
        "service": "homelab-ai-harness"
    }))
}

/// List available models from configured endpoints
#[derive(Debug, Deserialize)]
pub struct ListModelsQuery {
    /// Scope the list to one endpoint (the UI passes the active endpoint) — without it,
    /// models from every configured endpoint are flattened together indistinguishably.
    pub endpoint_id: Option<uuid::Uuid>,
}

pub async fn list_models(
    State(state): State<AppState>,
    Query(query): Query<ListModelsQuery>,
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

    // Scope to the requested endpoint when given
    let endpoint_configs: Vec<_> = match query.endpoint_id {
        Some(eid) => endpoint_configs.into_iter().filter(|e| e.id == eid).collect(),
        None => endpoint_configs,
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

/// Resolve the endpoint a chat turn should use: the given id (database first, then endpoints
/// from the environment config), else the first configured endpoint.
pub(crate) async fn resolve_endpoint(
    state: &AppState,
    endpoint_id: Option<Uuid>,
) -> Result<harness_core::models::EndpointConfig, ApiError> {
    const COLUMNS: &str = "SELECT id, name, base_url, api_key, is_favorite, is_local, max_tokens, temperature, created_at FROM endpoints";
    let to_config = |row: &sqlx::sqlite::SqliteRow| {
        let id: String = row.get(0);
        let max_tokens: Option<i64> = row.get(6);
        let temperature: Option<f64> = row.get(7);
        let created_at: String = row.get(8);
        harness_core::models::EndpointConfig {
            id: Uuid::parse_str(&id).unwrap_or_else(|_| Uuid::new_v4()),
            name: row.get(1),
            base_url: row.get(2),
            api_key: row.get(3),
            is_favorite: row.get::<i64, _>(4) != 0,
            is_local: row.get::<i64, _>(5) != 0,
            max_tokens: max_tokens.map(|v| v as u32),
            temperature: temperature.map(|v| v as f32),
            created_at: chrono::DateTime::parse_from_rfc3339(&created_at)
                .unwrap_or_else(|_| chrono::Utc::now().fixed_offset())
                .into(),
        }
    };
    match endpoint_id {
        Some(id) => {
            let row = sqlx::query(&format!("{} WHERE id = ?", COLUMNS))
                .bind(id.to_string())
                .fetch_optional(&*state.db)
                .await?;
            row.as_ref()
                .map(to_config)
                .or_else(|| state.config.endpoints.iter().find(|e| e.id == id).cloned())
                .ok_or_else(|| ApiError::NotFound(format!("Endpoint {} not found", id)))
        }
        None => sqlx::query(&format!("{} LIMIT 1", COLUMNS))
            .fetch_optional(&*state.db)
            .await?
            .as_ref()
            .map(to_config)
            .ok_or_else(|| ApiError::Config("No LLM endpoint configured. Please add an endpoint in Settings.".into())),
    }
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

/// Discover services on the local network
pub async fn discover_services(
    State(_state): State<AppState>,
) -> Result<Json<Vec<harness_core::models::EndpointConfig>>, ApiError> {
    let discovery = harness_core::ServiceDiscovery::new()?;
    let endpoints = discovery.discover_ollama().await?;
    Ok(Json(endpoints))
}
