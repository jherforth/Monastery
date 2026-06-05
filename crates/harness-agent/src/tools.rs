//! Tool definitions for agentic operations

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A tool that can be invoked by the agent
#[derive(Debug, Clone)]
pub struct Tool {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub handler: Box<dyn ToolHandler + Send + Sync>,
}

/// Result of a tool invocation
#[derive(Debug, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
}

/// Trait for tool handlers
#[async_trait::async_trait]
pub trait ToolHandler {
    async fn execute(&self, input: serde_json::Value) -> ToolResult;
}

/// Registry of available tools
pub struct ToolRegistry {
    tools: Vec<Tool>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self { tools: Vec::new() }
    }
    
    pub fn register(&mut self, tool: Tool) {
        self.tools.push(tool);
    }
    
    pub fn get(&self, name: &str) -> Option<&Tool> {
        self.tools.iter().find(|t| t.name == name)
    }
    
    pub fn list(&self) -> Vec<&Tool> {
        self.tools.iter().collect()
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}
