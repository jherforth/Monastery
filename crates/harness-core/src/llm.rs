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

/// A chunk from the streaming response, tagged with its type.
#[derive(Debug, Clone)]
pub struct StreamChunk {
    pub chunk_type: ChunkType,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChunkType {
    Reasoning,
    Content,
    /// Carries the finish_reason string ("stop", "length", etc.)
    /// Emitted once at the end of a streaming response.
    FinishReason,
    /// Carries the token-usage object as a JSON string
    /// (`{prompt_tokens, completion_tokens, total_tokens}`). Emitted once at the end when the
    /// endpoint reports usage (requested via stream_options.include_usage).
    Usage,
}

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
    /// Emits `StreamChunk` values tagged as Reasoning or Content.
    pub async fn chat_stream(
        &self,
        messages: Vec<ChatCompletionRequestMessage>,
        model: String,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamChunk>> + Send>>> {
        let base = self.config.base_url.trim_end_matches('/');
        let url = format!("{}/chat/completions", base);
        
        tracing::info!("Calling chat API at {}", url);
        
        let api_key = self.config.api_key.clone().unwrap_or_default();
        
        let body = {
            let mut body = serde_json::json!({
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
                // Ask OpenAI-compatible endpoints to include a final usage chunk in the stream.
                // Unknown fields are ignored by providers that don't support it, so this is safe.
                "stream_options": { "include_usage": true },
            });

            // Determine effective max_tokens:
            // - If explicitly configured on the endpoint, use that.
            // - For local endpoints (Ollama, etc.) with no explicit limit, use a high default
            //   because Ollama's built-in default (num_predict) is often only 2048, which
            //   cuts off long code generation responses far too early.
            // - For remote endpoints with no explicit limit, omit the field and let the
            //   provider use its own defaults.
            let effective_max_tokens = match self.config.max_tokens {
                Some(mt) if mt > 0 => Some(mt),
                None if self.config.is_local => Some(32768),
                _ => None,
            };
            if let Some(mt) = effective_max_tokens {
                body["max_tokens"] = serde_json::json!(mt);
            }
            // Only include temperature if explicitly set.
            if let Some(temp) = self.config.temperature {
                body["temperature"] = serde_json::json!(temp);
            }

            body
        };
        
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
                    let mut chunks: Vec<StreamChunk> = Vec::new();
                    while let Some(pos) = buffer.find("\n\n") {
                        let event = buffer[..pos].to_string();
                        buffer = buffer[pos + 2..].to_string();

                        // Parse "data:" lines from the event
                        for line in event.lines() {
                            let data = if let Some(d) = line.strip_prefix("data: ") {
                                d
                            } else if let Some(d) = line.strip_prefix("data:") {
                                d.strip_prefix(' ').unwrap_or(d)
                            } else {
                                continue;
                            };

                            if data == "[DONE]" {
                                continue;
                            }
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                let delta = &json["choices"][0]["delta"];
                                // Check for reasoning_content first (DeepSeek, o1, etc.)
                                if let Some(reasoning) = delta["reasoning_content"].as_str() {
                                    if !reasoning.is_empty() {
                                        chunks.push(StreamChunk {
                                            chunk_type: ChunkType::Reasoning,
                                            content: reasoning.to_string(),
                                        });
                                    }
                                }
                                // Also check for reasoning (alternative field name)
                                if let Some(reasoning) = delta["reasoning"].as_str() {
                                    if !reasoning.is_empty() {
                                        chunks.push(StreamChunk {
                                            chunk_type: ChunkType::Reasoning,
                                            content: reasoning.to_string(),
                                        });
                                    }
                                }
                                // Regular content
                                if let Some(text) = delta["content"].as_str() {
                                    if !text.is_empty() {
                                        chunks.push(StreamChunk {
                                            chunk_type: ChunkType::Content,
                                            content: text.to_string(),
                                        });
                                    }
                                }
                                // finish_reason is present on the final chunk ("stop", "length", etc.)
                                // We emit it so the frontend can detect truncation and auto-continue.
                                if let Some(reason) = json["choices"][0]["finish_reason"].as_str() {
                                    if !reason.is_empty() {
                                        chunks.push(StreamChunk {
                                            chunk_type: ChunkType::FinishReason,
                                            content: reason.to_string(),
                                        });
                                    }
                                }
                                // Usage arrives on a final chunk (with empty choices) when
                                // stream_options.include_usage is set. Guard with is_object so a
                                // null usage on intermediate chunks is ignored.
                                if let Some(usage) = json.get("usage") {
                                    if usage.is_object() {
                                        chunks.push(StreamChunk {
                                            chunk_type: ChunkType::Usage,
                                            content: usage.to_string(),
                                        });
                                    }
                                }
                            }
                        }
                    }

                    Ok(chunks)
                }
                Err(e) => Err(Error::OpenAIWithMessage(format!("Stream read error: {}", e))),
            }
        })
        // Flatten Vec<StreamChunk> into individual chunks
        .flat_map(|result| {
            let items: Vec<Result<StreamChunk>> = match result {
                Ok(chunks) => chunks.into_iter().map(Ok).collect(),
                Err(e) => vec![Err(e)],
            };
            futures::stream::iter(items)
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
    
    /// Fetch available models from the endpoint.
    ///
    /// Raw GET + lenient parsing on purpose: the typed async-openai client hard-fails when a
    /// provider omits an OpenAI field (DeepSeek's /models entries have no `created`), which
    /// produced the classic "Validate passes but no models appear" — Validate does a raw GET
    /// to the same URL and succeeded while this call choked on deserialization. Only `id` is
    /// required here; everything else is optional. Also tolerates non-OpenAI shapes: a bare
    /// array, or Ollama's native `{"models":[{"name": …}]}`.
    pub async fn list_models(&self) -> Result<Vec<crate::models::ModelInfo>> {
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

        let resp = req.send().await.map_err(|e| {
            Error::OpenAIWithMessage(format!("Model list request to {} failed: {}", url, e))
        })?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            let truncated: String = body.chars().take(300).collect();
            return Err(Error::OpenAIWithMessage(format!(
                "HTTP {} from {}: {}", status.as_u16(), url, truncated
            )));
        }

        let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
            Error::OpenAIWithMessage(format!("Invalid JSON from {}: {}", url, e))
        })?;
        let items = json.get("data").and_then(|d| d.as_array())
            .or_else(|| json.as_array())
            .or_else(|| json.get("models").and_then(|d| d.as_array()))
            .cloned()
            .unwrap_or_default();

        let models = items.iter().filter_map(|m| {
            let id = m.get("id").and_then(|v| v.as_str())
                .or_else(|| m.get("name").and_then(|v| v.as_str()))?;
            Some(crate::models::ModelInfo {
                id: id.to_string(),
                name: id.to_string(),
                owned_by: m.get("owned_by").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                context_window: None,
                is_local: self.config.is_local,
            })
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
