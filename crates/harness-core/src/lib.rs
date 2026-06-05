//! HomeLab AI Harness - Core Library
//! 
//! Provides core functionality for LLM connectivity, model management,
//! and service discovery.

pub mod llm;
pub mod models;
pub mod config;
pub mod discovery;
pub mod error;

pub use error::{Error, Result};
pub use config::HarnessConfig;
pub use models::{ModelInfo, ModelEndpoint, EndpointConfig};
pub use llm::LLMClient;
pub use discovery::ServiceDiscovery;
