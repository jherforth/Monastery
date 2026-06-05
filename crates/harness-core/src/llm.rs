//! LLM client with OpenAI-compatible API support

use async_openai::Client;
use async_openai::config::Config as OpenAIConfig;
use async_openai::types::{ChatCompletionRequestMessage, CreateChatCompletionRequest};
use futures::Stream;
use std::pin::Pin;

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
            api_key: self.config.api_key.clone().unwrap_or_default(),
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
    
    /// Test connection to the endpoint
    pub async fn health_check(&self) -> Result<bool> {
        let client = self.create_client();
        
        // Try to list models as a health check
        match client.models().list().await {
            Ok(_) => Ok(true),
            Err(_) => Ok(false), // Return false instead of error for health checks
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
                owned_by: m.owned_by.clone().unwrap_or_default(),
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
    api_key: String,
    base_url: String,
}

impl OpenAIConfig for CustomOpenAIConfig {
    fn api_key(&self) -> &str {
        &self.api_key
    }
    
    fn api_base(&self) -> &str {
        &self.base_url
    }
}
