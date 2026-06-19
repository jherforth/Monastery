//! Model and endpoint configuration types

use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// Configuration for a single LLM endpoint
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct EndpointConfig {
    pub id: Uuid,
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub is_favorite: bool,
    pub is_local: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Max output tokens. None = omit from API request (provider default).
    /// Auto-detected on endpoint creation; override via ?max_tokens=N query param.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Sampling temperature 0.0–2.0. None = omit from API request.
    /// Auto-detected on endpoint creation; override via ?temperature=T query param.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

impl EndpointConfig {
    /// Detect sensible defaults for an endpoint based on its URL.
    /// Local endpoints get no limits (None). Known cloud providers get
    /// provider-specific values. Unknown remotes get a safe universal default.
    pub fn detect_defaults(base_url: &str) -> (Option<u32>, Option<f32>) {
        let url_lower = base_url.to_lowercase();

        // Local — no limits needed, let the provider decide
        if url_lower.contains("localhost")
            || url_lower.contains("127.0.0.1")
            || url_lower.contains("host.docker.internal")
            || url_lower.contains("192.168.")
            || url_lower.contains("10.")
            || url_lower.ends_with(".local")
        {
            return (None, None);
        }

        // Known cloud providers
        if url_lower.contains("api.deepseek.com") {
            return (Some(8192), Some(0.3));
        }
        if url_lower.contains("api.openai.com") {
            return (Some(16384), Some(0.3));
        }
        if url_lower.contains("api.anthropic.com") {
            return (Some(8192), Some(0.3));
        }
        if url_lower.contains("openrouter.ai") {
            return (Some(8192), Some(0.3));
        }
        if url_lower.contains("api.groq.com") {
            return (Some(8192), Some(0.3));
        }
        if url_lower.contains("generativelanguage.googleapis.com") {
            return (Some(8192), Some(0.3));
        }
        if url_lower.contains("api.mistral.ai") {
            return (Some(8192), Some(0.3));
        }

        // Unknown remote — let the provider use its own defaults rather than
        // imposing a low cap that would cut off long code generation responses.
        (None, None)
    }
}

impl Default for EndpointConfig {
    fn default() -> Self {
        Self {
            id: Uuid::new_v4(),
            name: String::from("Default"),
            base_url: String::from("http://localhost:11434"),
            api_key: None,
            is_favorite: false,
            is_local: true,
            created_at: chrono::Utc::now(),
            max_tokens: None,
            temperature: None,
        }
    }
}

/// Information about an available model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub owned_by: String,
    pub context_window: Option<u32>,
    pub is_local: bool,
}

/// A model endpoint with its available models
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEndpoint {
    pub config: EndpointConfig,
    pub models: Vec<ModelInfo>,
    pub is_healthy: bool,
    pub last_checked: Option<chrono::DateTime<chrono::Utc>>,
}

impl ModelEndpoint {
    pub fn new(config: EndpointConfig) -> Self {
        Self {
            config,
            models: Vec::new(),
            is_healthy: false,
            last_checked: None,
        }
    }
}

// ============================================================
// Git Forge Integration Types
// ============================================================

/// Supported Git forge types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GitForgeType {
    GitHub,
    GitLab,
    Forgejo,
    Gitea,
}

impl std::fmt::Display for GitForgeType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitForgeType::GitHub => write!(f, "github"),
            GitForgeType::GitLab => write!(f, "gitlab"),
            GitForgeType::Forgejo => write!(f, "forgejo"),
            GitForgeType::Gitea => write!(f, "gitea"),
        }
    }
}

impl GitForgeType {
    /// Default API base URL for each forge type
    pub fn default_api_url(&self) -> &str {
        match self {
            GitForgeType::GitHub => "https://api.github.com",
            GitForgeType::GitLab => "https://gitlab.com/api/v4",
            GitForgeType::Forgejo => "", // User must provide their instance URL
            GitForgeType::Gitea => "",   // User must provide their instance URL
        }
    }

    /// URL path for listing user repos
    pub fn repos_endpoint(&self) -> &str {
        match self {
            GitForgeType::GitHub => "/user/repos?per_page=100",
            GitForgeType::GitLab => "/projects?membership=true&per_page=100",
            GitForgeType::Forgejo => "/api/v1/user/repos?limit=100",
            GitForgeType::Gitea => "/api/v1/user/repos?limit=100",
        }
    }

    /// URL path for creating a repo
    pub fn create_repo_endpoint(&self) -> &str {
        match self {
            GitForgeType::GitHub => "/user/repos",
            GitForgeType::GitLab => "/projects",
            GitForgeType::Forgejo => "/api/v1/user/repos",
            GitForgeType::Gitea => "/api/v1/user/repos",
        }
    }

    /// URL path for listing branches of a repo (needs owner/repo interpolation)
    pub fn branches_endpoint(&self, owner: &str, repo: &str) -> String {
        match self {
            GitForgeType::GitHub => format!("/repos/{}/{}/branches", owner, repo),
            GitForgeType::GitLab => format!("/projects/{}%2F{}/repository/branches", owner, repo),
            GitForgeType::Forgejo => format!("/api/v1/repos/{}/{}/branches", owner, repo),
            GitForgeType::Gitea => format!("/api/v1/repos/{}/{}/branches", owner, repo),
        }
    }
}

/// A configured Git forge connection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitConnection {
    pub id: Uuid,
    pub name: String,
    pub forge_type: GitForgeType,
    pub base_url: String,
    pub api_token: String,
    pub username: Option<String>,
    pub email: Option<String>,
    pub is_default: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_synced_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Request to connect a new Git forge
#[derive(Debug, Deserialize)]
pub struct ConnectGitForgeRequest {
    pub name: String,
    pub forge_type: GitForgeType,
    #[serde(default)]
    pub base_url: Option<String>,
    pub api_token: String,
    #[serde(default)]
    pub email: Option<String>,
}

/// A repository from a connected forge
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRepo {
    pub id: i64,
    pub name: String,
    pub full_name: String,
    pub clone_url: String,
    pub html_url: String,
    pub description: Option<String>,
    pub private: bool,
    pub default_branch: String,
}

/// Git status for the current project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub is_clean: bool,
    pub ahead: usize,
    pub behind: usize,
    pub changed_files: Vec<String>,
    pub has_remote: bool,
    pub remote_url: Option<String>,
}

/// Request to push project to a remote repo
#[derive(Debug, Deserialize)]
pub struct GitPushRequest {
    pub connection_id: Uuid,
    pub repo_name: String,
    pub repo_description: Option<String>,
    pub private: bool,
    pub branch: Option<String>,
    pub commit_message: Option<String>,
}

/// Request to clone a repo as a new project
#[derive(Debug, Deserialize)]
pub struct GitCloneRequest {
    pub connection_id: Uuid,
    pub repo_full_name: String,
    pub project_name: Option<String>,
    pub branch: Option<String>,
}

/// A branch on a Git repository
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranch {
    pub name: String,
    pub is_default: bool,
}

/// Query params for listing branches
#[derive(Debug, Deserialize)]
pub struct ListBranchesQuery {
    pub repo_full_name: String,
}
