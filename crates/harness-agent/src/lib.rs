//! HomeLab AI Harness - Agent Services
//! 
//! Provides agentic capabilities for code generation, tool calling,
//! and homelab integrations.

pub mod tools;
pub mod sandbox;
pub mod deployment;

pub use tools::{Tool, ToolResult, ToolRegistry};
pub use sandbox::{Sandbox, SandboxConfig};
pub use deployment::{DeploymentTarget, DeploymentConfig};
