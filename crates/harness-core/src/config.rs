//! Configuration management for the harness

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::models::EndpointConfig;

/// Main harness configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarnessConfig {
    /// Port to run the API server on
    pub port: u16,
    
    /// Path to store projects and data
    pub data_dir: PathBuf,
    
    /// Database path (SQLite)
    pub database_path: PathBuf,
    
    /// Configured LLM endpoints
    pub endpoints: Vec<EndpointConfig>,
    
    /// Default endpoint ID
    pub default_endpoint_id: Option<uuid::Uuid>,
    
    /// Enable mDNS discovery
    pub enable_discovery: bool,
    
    /// Log level
    pub log_level: String,
}

impl Default for HarnessConfig {
    fn default() -> Self {
        Self {
            port: 3000,
            data_dir: PathBuf::from("./data"),
            database_path: PathBuf::from("./data/harness.db"),
            endpoints: Vec::new(),
            default_endpoint_id: None,
            enable_discovery: true,
            log_level: String::from("info"),
        }
    }
}

impl HarnessConfig {
    /// Load configuration from environment and config file
    pub fn load() -> Result<Self, crate::Error> {
        let mut config = Self::default();
        
        // Override with environment variables
        if let Ok(port) = std::env::var("PORT") {
            config.port = port.parse().unwrap_or(config.port);
        }
        
        if let Ok(data_dir) = std::env::var("DATA_DIR") {
            config.data_dir = PathBuf::from(data_dir);
            config.database_path = config.data_dir.join("harness.db");
        }
        
        if let Ok(llm_url) = std::env::var("LLM_BASE_URL") {
            let endpoint = EndpointConfig {
                name: String::from("Environment"),
                base_url: llm_url,
                is_local: llm_url.contains("localhost") || llm_url.contains("127.0.0.1"),
                ..Default::default()
            };
            config.endpoints.push(endpoint);
            config.default_endpoint_id = Some(config.endpoints[0].id);
        }
        
        if let Ok(log_level) = std::env::var("LOG_LEVEL") {
            config.log_level = log_level;
        }
        
        if let Ok(disable_discovery) = std::env::var("DISABLE_DISCOVERY") {
            config.enable_discovery = !disable_discovery.eq_ignore_ascii_case("true");
        }
        
        Ok(config)
    }
    
    /// Get the default or first endpoint
    pub fn get_default_endpoint(&self) -> Option<&EndpointConfig> {
        if let Some(id) = self.default_endpoint_id {
            return self.endpoints.iter().find(|e| e.id == id);
        }
        self.endpoints.first()
    }
}
