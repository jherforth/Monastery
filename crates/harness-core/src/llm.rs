//! LLM client with OpenAI-compatible API support

use async_openai::Client;
use async_openai::config::Config as OpenAIConfig;
use async_openai::types::{ChatCompletionRequestMessage, CreateChatCompletionRequest};
use futures::Stream;
use std::pin::Pin;
use secrecy::SecretBox;
use http::header::HeaderMap;

use crate::models::EndpointConfig;
use crate::error::{Error, Result};

/// Unified LLM client supporting multiple endpoints
pub struct LLMClient {
    config: EndpointConfig,
}

impl LLMClient {
    pub fn new(config: EndpointConfig) -> Self {
        Self { config }
    }
    
    /// Get the endpoint configuration
    pub fn config(&self) -> &EndpointConfig {
        &self.config
    }
    
    /// Create an OpenAI-compatible client for this endpoint
    fn create_client(&self) -> Client<CustomOpenAIConfig> {
        let custom_config = CustomOpenAIConfig {
            api_key: SecretBox::new(self.config.api_key.clone().unwrap_or_default().into_boxed_str()),
            base_url: self.config.base_url.clone(),
        };
        Client::with_config(custom_config)
    }
    
    /// Send a chat completion request and stream the response
    pub async fn chat_stream(
        &self,
        messages: Vec<ChatCompletionRequestMessage>,
        model: String,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<String>> + Send>>> {
        let client = self.create_client();
        
        let request = CreateChatCompletionRequest {
            model,
            messages,
            stream: Some(true),
            ..Default::default()
        };
        
        let stream = client.chat().create_stream(request).await?;
        
        use futures::stream::StreamExt;
        
        let mapped = stream.map(|item| {
            match item {
                Ok(response) => {
                    if let Some(choice) = response.choices.first() {
                        if let Some(ref delta) = choice.delta.content {
                            Ok(delta.clone())
                        } else {
                            Ok(String::new())
                        }
                    } else {
                        Ok(String::new())
                    }
                }
                Err(e) => Err(Error::OpenAI(e)),
            }
        });
        
        Ok(Box::pin(mapped))
    }
    
    /// Test connection to the endpoint using a direct HTTP request.
    /// Tries the /models endpoint first; falls back to reporting the raw response.
    pub async fn health_check(&self) -> Result<bool> {
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| Error::OpenAIWithMessage(format!("Failed to build HTTP client: {}", e)))?;
        
        let base = self.config.base_url.trim_end_matches('/');
        let url = format!("{}/models", base);
        
        let mut req = http_client.get(&url);
        if let Some(ref api_key) = self.config.api_key {
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {}", api_key));
            }
        }
        
        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                
                if status.is_success() {
                    // Check if the body is valid JSON (models list)
                    if body.trim().is_empty() {
                        return Err(Error::OpenAIWithMessage(format!(
                            "Health check warning: {} returned HTTP {} with empty body. \
                             The endpoint may not support model listing, but the connection is reachable. \
                             Try sending a chat message to verify.",
                            url, status.as_u16()
                        )));
                    }
                    Ok(true)
                } else {
                    let truncated: String = if body.len() > 300 {
                        format!("{}...", &body[..300])
                    } else {
                        body
                    };
                    Err(Error::OpenAIWithMessage(format!(
                        "HTTP {} from {}: {}",
                        status.as_u16(), url, truncated
                    )))
                }
            }
            Err(e) => {
                Err(Error::OpenAIWithMessage(format!(
                    "Connection to {} failed: {}",
                    base,
                    if e.is_timeout() {
                        "request timed out after 10s".to_string()
                    } else if e.is_connect() {
                        format!("could not connect — check the URL and network (detail: {})", e)
                    } else {
                        e.to_string()
                    }
                )))
            }
        }
    }
    
    /// Fetch available models from the endpoint
    pub async fn list_models(&self) -> Result<Vec<crate::models::ModelInfo>> {
        let client = self.create_client();
        let response = client.models().list().await?;
        
        let models = response.data.iter().map(|m| {
            crate::models::ModelInfo {
                id: m.id.clone(),
                name: m.id.clone(), // Use ID as name if no separate name
                owned_by: m.owned_by.clone(),
                context_window: None, // Would need additional API call or config
                is_local: self.config.is_local,
            }
        }).collect();
        
        Ok(models)
    }
}

/// Custom OpenAI config that allows arbitrary base URLs
#[derive(Clone)]
struct CustomOpenAIConfig {
    api_key: SecretBox<str>,
    base_url: String,
}

impl OpenAIConfig for CustomOpenAIConfig {
    fn api_key(&self) -> &SecretBox<str> {
        &self.api_key
    }
    
    fn api_base(&self) -> &str {
        &self.base_url
    }
    
    fn headers(&self) -> HeaderMap {
        HeaderMap::new()
    }
    
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }
    
    fn query(&self) -> Vec<(&str, &str)> {
        Vec::new()
    }
}
