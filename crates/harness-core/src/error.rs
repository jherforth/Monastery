//! Error types for the harness core

use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("LLM connection failed: {0}")]
    LLMConnection(String),

    #[error("Model not found: {0}")]
    ModelNotFound(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Discovery failed: {0}")]
    Discovery(String),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Network error: {0}")]
    Network(String),

    #[error("OpenAI API error: {0}")]
    OpenAI(#[from] async_openai::error::OpenAIError),

    #[error("{0}")]
    OpenAIWithMessage(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Unknown error: {0}")]
    Unknown(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<String> for Error {
    fn from(s: String) -> Self {
        Error::Unknown(s)
    }
}
