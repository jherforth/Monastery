//! LLM client with OpenAI-compatible API support

use async_openai::Client;
use async_openai::config::Config as OpenAIConfig;
use async_openai::types::ChatCompletionRequestMessage;
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
    
    /// Send a chat completion request and stream the response.
    /// Uses a direct reqwest call for better control and error visibility.
    pub async fn chat_stream(
        &self,
        messages: Vec<ChatCompletionRequestMessage>,
        model: String,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<String>> + Send>>> {
        let base = self.config.base_url.trim_end_matches('/');
        let url = format!("{}/chat/completions", base);
        
        tracing::info!("Calling chat API at {}", url);
        
        let api_key = self.config.api_key.clone().unwrap_or_default();
        
        let body = serde_json::json!({
            "model": model,
            "messages": messages.iter().map(|m| {
                match m {
                    ChatCompletionRequestMessage::User(msg) => {
                        serde_json::json!({
                            "role": "user",
                            "content": match &msg.content {
                                async_openai::types::ChatCompletionRequestUserMessageContent::Text(t) => t,
                                _ => "",
                            }
                        })
                    }
                    ChatCompletionRequestMessage::Assistant(msg) => {
                        serde_json::json!({
                            "role": "assistant",
                            "content": match &msg.content {
                                Some(async_openai::types::ChatCompletionRequestAssistantMessageContent::Text(t)) => t,
                                _ => "",
                            }
                        })
                    }
                    ChatCompletionRequestMessage::System(msg) => {
                        serde_json::json!({
                            "role": "system",
                            "content": match &msg.content {
                                async_openai::types::ChatCompletionRequestSystemMessageContent::Text(t) => t,
                                _ => "",
                            }
                        })
                    }
                    _ => serde_json::json!({"role": "user", "content": ""})
                }
            }).collect::<Vec<_>>(),
            "stream": true,
        });
        
        let http_client = reqwest::Client::new();
        let resp = http_client
            .post(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::OpenAIWithMessage(format!("Chat request failed: {}", e)))?;
        
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            tracing::error!("Chat API error: HTTP {} - {}", status.as_u16(), body);
            return Err(Error::OpenAIWithMessage(format!(
                "Chat API returned HTTP {}: {}",
                status.as_u16(),
                if body.len() > 200 { format!("{}...", &body[..200]) } else { body }
            )));
        }
        
        use futures::stream::StreamExt;
        
        // Buffer across chunks to handle split SSE events
        let mut buffer = String::new();

        let stream = resp.bytes_stream().map(move |item| {
            match item {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));

                    // Extract complete SSE events (terminated by \n\n)
                    let mut content = String::new();
                    while let Some(pos) = buffer.find("\n\n") {
                        let event = buffer[..pos].to_string();
                        buffer = buffer[pos + 2..].to_string();

                        // Parse "data:" lines from the event
                        for line in event.lines() {
                            let data = if let Some(d) = line.strip_prefix("data: ") {
                                d
                            } else if let Some(d) = line.strip_prefix("data:") {
                                d.trim_start()
                            } else {
                                continue;
                            };

                            if data == "[DONE]" {
                                continue;
                            }
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(text) = json["choices"][0]["delta"]["content"].as_str() {
                                    content.push_str(text);
                                }
                            }
                        }
                    }
                    
                    Ok(content)
                }
                Err(e) => Err(Error::OpenAIWithMessage(format!("Stream read error: {}", e))),
            }
        });
        
        Ok(Box::pin(stream))
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
