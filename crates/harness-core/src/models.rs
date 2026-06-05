//! Model and endpoint configuration types

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Configuration for a single LLM endpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointConfig {
    pub id: Uuid,
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub is_favorite: bool,
    pub is_local: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

impl Default for EndpointConfig {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4(),
            name: String::from("Default"),
            base_url: String::from("http://localhost:11434"),
            api_key: None,
            is_favorite: false,
            is_local: true,
            created_at: chrono::Utc::now(),
        }
    }
}

/// Information about an available model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub owned_by: String,
    pub context_window: Option<u32>,
    pub is_local: bool,
}

/// A model endpoint with its available models
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEndpoint {
    pub config: EndpointConfig,
    pub models: Vec<ModelInfo>,
    pub is_healthy: bool,
    pub last_checked: Option<chrono::DateTime<chrono::Utc>>,
}

impl ModelEndpoint {
    pub fn new(config: EndpointConfig) -> Self {
        Self {
            config,
            models: Vec::new(),
            is_healthy: false,
            last_checked: None,
        }
    }
}
