//! Deployment targets and configurations

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Supported deployment targets
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DeploymentTarget {
    /// Docker Compose stack
    DockerCompose,
    
    /// Coolify platform
    Coolify,
    
    /// Proxmox LXC/VM
    Proxmox,
    
    /// Kubernetes cluster
    Kubernetes,
    
    /// PocketBase backend
    PocketBase,
}

/// Deployment configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentConfig {
    pub id: Uuid,
    pub name: String,
    pub target: DeploymentTarget,
    pub destination: String,
    pub environment: Vec<EnvVar>,
    pub resources: ResourceLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
    pub is_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ResourceLimits {
    pub memory_mb: Option<u64>,
    pub cpu_cores: Option<f32>,
    pub disk_gb: Option<u64>,
}

impl DeploymentConfig {
    pub fn new(name: String, target: DeploymentTarget, destination: String) -> Self {
        Self {
            id: Uuid::new_v4(),
            name,
            target,
            destination,
            environment: Vec::new(),
            resources: ResourceLimits::default(),
        }
    }
}

/// Generate Docker Compose configuration
pub fn generate_docker_compose(config: &DeploymentConfig, app_name: &str) -> String {
    format!(
        r#"version: '3.8'
services:
  {app_name}:
    image: {app_name}:latest
    ports:
      - "3000:3000"
    environment:
{env_vars}
    deploy:
      resources:
        limits:
{resources}
"#,
        app_name = app_name,
        env_vars = config.environment.iter()
            .map(|e| format!("      - {}={}", e.key, if e.is_secret { "***" } else { &e.value }))
            .collect::<Vec<_>>()
            .join("\n"),
        resources = if let Some(mem) = config.resources.memory_mb {
            format!("          memory: {}M", mem)
        } else {
            String::new()
        },
    )
}
