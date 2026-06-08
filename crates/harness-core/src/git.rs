//! Git Forge Integration Service
//!
//! Handles Git operations (status, push, pull, clone) and forge API calls
//! for GitHub, GitLab, and Forgejo. Uses system `git` CLI for local operations
//! and `reqwest` for forge REST APIs.

use crate::models::{
    GitForgeType, GitConnection, GitRepo, GitStatus, GitBranch,
};
use crate::Result;
use serde_json::Value;
use std::path::Path;
use std::process::Command;

/// Service for Git forge operations
pub struct GitService;

impl GitService {
    /// Create a new GitService
    pub fn new() -> Self {
        Self
    }

    // ============================================================
    // Forge API: Test Connection & Fetch User Info
    // ============================================================

    /// Test a forge connection and return the authenticated username
    pub async fn test_connection(
        forge_type: &GitForgeType,
        base_url: &str,
        api_token: &str,
    ) -> Result<String> {
        let client = reqwest::Client::new();
        let (url, user_endpoint) = match forge_type {
            GitForgeType::GitHub => (base_url.to_string(), "/user"),
            GitForgeType::GitLab => (base_url.to_string(), "/user"),
            GitForgeType::Forgejo => (base_url.to_string(), "/api/v1/user"),
        };

        let resp = client
            .get(format!("{}{}", url, user_endpoint))
            .header("Authorization", format!("Bearer {}", api_token))
            .header("User-Agent", "Monastery-Harness/0.1")
            .send()
            .await
            .map_err(|e| crate::Error::Network(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(crate::Error::Network(
                format!("Forge returned {}: {}", status, body)
            ));
        }

        let json: Value = resp.json().await
            .map_err(|e| crate::Error::Network(e.to_string()))?;

        let username = match forge_type {
            GitForgeType::GitHub | GitForgeType::Forgejo => {
                json["login"].as_str().unwrap_or("unknown").to_string()
            }
            GitForgeType::GitLab => {
                json["username"].as_str().unwrap_or("unknown").to_string()
            }
        };

        Ok(username)
    }

    /// Validate that a Forgejo instance URL is plausible
    pub fn validate_forgejo_url(url: &str) -> Result<()> {
        if url.is_empty() {
            return Err(crate::Error::Config("Forgejo requires a base URL (e.g., https://git.yourdomain.com)".into()));
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(crate::Error::Config("Forgejo URL must start with http:// or https://".into()));
        }
        Ok(())
    }

    // ============================================================
    // Forge API: List Repos
    // ============================================================

    /// List repositories for a connected forge
    pub async fn list_repos(connection: &GitConnection) -> Result<Vec<GitRepo>> {
        let client = reqwest::Client::new();
        let endpoint = connection.forge_type.repos_endpoint();
        let url = format!("{}{}", connection.base_url, endpoint);

        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", connection.api_token))
            .header("User-Agent", "Monastery-Harness/0.1")
            .send()
            .await
            .map_err(|e| crate::Error::Network(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(crate::Error::Network(
                format!("Failed to list repos: {} - {}", status, body)
            ));
        }

        let repos: Vec<Value> = resp.json().await
            .map_err(|e| crate::Error::Network(e.to_string()))?;

        let parsed = repos.into_iter().map(|repo| {
            let (id, name, full_name, clone_url, html_url, description, private, default_branch) = match connection.forge_type {
                GitForgeType::GitHub => (
                    repo["id"].as_i64().unwrap_or(0),
                    repo["name"].as_str().unwrap_or("").to_string(),
                    repo["full_name"].as_str().unwrap_or("").to_string(),
                    repo["clone_url"].as_str().unwrap_or("").to_string(),
                    repo["html_url"].as_str().unwrap_or("").to_string(),
                    repo["description"].as_str().map(|s| s.to_string()),
                    repo["private"].as_bool().unwrap_or(false),
                    repo["default_branch"].as_str().unwrap_or("main").to_string(),
                ),
                GitForgeType::GitLab => (
                    repo["id"].as_i64().unwrap_or(0),
                    repo["name"].as_str().unwrap_or("").to_string(),
                    repo["path_with_namespace"].as_str().unwrap_or("").to_string(),
                    repo["http_url_to_repo"].as_str().unwrap_or("").to_string(),
                    repo["web_url"].as_str().unwrap_or("").to_string(),
                    repo["description"].as_str().map(|s| s.to_string()),
                    repo["visibility"].as_str().map(|v| v == "private").unwrap_or(false),
                    repo["default_branch"].as_str().unwrap_or("main").to_string(),
                ),
                GitForgeType::Forgejo => (
                    repo["id"].as_i64().unwrap_or(0),
                    repo["name"].as_str().unwrap_or("").to_string(),
                    repo["full_name"].as_str().unwrap_or("").to_string(),
                    repo["clone_url"].as_str().unwrap_or("").to_string(),
                    repo["html_url"].as_str().unwrap_or("").to_string(),
                    repo["description"].as_str().map(|s| s.to_string()),
                    repo["private"].as_bool().unwrap_or(false),
                    repo["default_branch"].as_str().unwrap_or("main").to_string(),
                ),
            };

            GitRepo {
                id,
                name,
                full_name,
                clone_url,
                html_url,
                description,
                private,
                default_branch,
            }
        }).collect();

        Ok(parsed)
    }

    // ============================================================
    // Forge API: Create Repo
    // ============================================================

    /// Create a new repository on the forge
    pub async fn create_repo(
        connection: &GitConnection,
        name: &str,
        description: Option<&str>,
        private: bool,
    ) -> Result<GitRepo> {
        let client = reqwest::Client::new();
        let endpoint = connection.forge_type.create_repo_endpoint();
        let url = format!("{}{}", connection.base_url, endpoint);

        let body = match connection.forge_type {
            GitForgeType::GitHub => serde_json::json!({
                "name": name,
                "description": description.unwrap_or("Created with Monastery"),
                "private": private,
                "auto_init": false,
            }),
            GitForgeType::GitLab => serde_json::json!({
                "name": name,
                "description": description.unwrap_or("Created with Monastery"),
                "visibility": if private { "private" } else { "public" },
            }),
            GitForgeType::Forgejo => serde_json::json!({
                "name": name,
                "description": description.unwrap_or("Created with Monastery"),
                "private": private,
                "auto_init": false,
            }),
        };

        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", connection.api_token))
            .header("User-Agent", "Monastery-Harness/0.1")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| crate::Error::Network(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(crate::Error::Network(
                format!("Failed to create repo: {} - {}", status, body_text)
            ));
        }

        let repo: Value = resp.json().await
            .map_err(|e| crate::Error::Network(e.to_string()))?;

        let git_repo = match connection.forge_type {
            GitForgeType::GitHub | GitForgeType::Forgejo => GitRepo {
                id: repo["id"].as_i64().unwrap_or(0),
                name: repo["name"].as_str().unwrap_or(name).to_string(),
                full_name: repo["full_name"].as_str().unwrap_or(name).to_string(),
                clone_url: repo["clone_url"].as_str().unwrap_or("").to_string(),
                html_url: repo["html_url"].as_str().unwrap_or("").to_string(),
                description: repo["description"].as_str().map(|s| s.to_string()),
                private: repo["private"].as_bool().unwrap_or(private),
                default_branch: repo["default_branch"].as_str().unwrap_or("main").to_string(),
            },
            GitForgeType::GitLab => GitRepo {
                id: repo["id"].as_i64().unwrap_or(0),
                name: repo["name"].as_str().unwrap_or(name).to_string(),
                full_name: repo["path_with_namespace"].as_str().unwrap_or(name).to_string(),
                clone_url: repo["http_url_to_repo"].as_str().unwrap_or("").to_string(),
                html_url: repo["web_url"].as_str().unwrap_or("").to_string(),
                description: repo["description"].as_str().map(|s| s.to_string()),
                private: repo["visibility"].as_str().map(|v| v == "private").unwrap_or(private),
                default_branch: repo["default_branch"].as_str().unwrap_or("main").to_string(),
            },
        };

        Ok(git_repo)
    }

    // ============================================================
    // Forge API: List Branches
    // ============================================================

    /// List branches for a repository
    pub async fn list_branches(
        connection: &GitConnection,
        repo_full_name: &str,
    ) -> Result<Vec<GitBranch>> {
        let client = reqwest::Client::new();
        let parts: Vec<&str> = repo_full_name.split('/').collect();
        let (owner, repo) = if parts.len() >= 2 {
            (parts[0], parts[1])
        } else {
            return Err(crate::Error::Network(format!(
                "Invalid repo name format: {}. Expected owner/repo", repo_full_name
            )));
        };

        let endpoint = connection.forge_type.branches_endpoint(owner, repo);
        let url = format!("{}{}", connection.base_url, endpoint);

        let resp = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", connection.api_token))
            .header("User-Agent", "Monastery-Harness/0.1")
            .send()
            .await
            .map_err(|e| crate::Error::Network(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(crate::Error::Network(
                format!("Failed to list branches: {} - {}", status, body)
            ));
        }

        let branches: Vec<Value> = resp.json().await
            .map_err(|e| crate::Error::Network(e.to_string()))?;

        let parsed: Vec<GitBranch> = branches.into_iter().map(|b| {
            let name = b["name"].as_str().unwrap_or("unknown").to_string();
            // GitHub/Forgejo don't include is_default; GitLab might not either
            // We'll mark based on whether name matches common defaults
            let is_default = name == "main" || name == "master";
            GitBranch { name, is_default }
        }).collect();

        Ok(parsed)
    }

    // ============================================================
    // Local Git Operations (using system `git` CLI)
    // ============================================================

    /// Get git status for a project directory
    pub fn git_status(project_path: &Path) -> Result<GitStatus> {
        // Get current branch
        let branch = run_git(project_path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap_or_else(|_| "unknown".to_string());

        // Check if clean
        let status_output = run_git(project_path, &["status", "--porcelain"])
            .unwrap_or_default();
        let changed_files: Vec<String> = status_output
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l[3..].to_string())
            .collect();
        let is_clean = changed_files.is_empty();

        // Get remote info
        let remote_url = run_git(project_path, &["remote", "get-url", "origin"]).ok();
        let has_remote = remote_url.is_some();

        // Get ahead/behind counts
        let (ahead, behind) = if has_remote {
            let ahead_str = run_git(
                project_path,
                &["rev-list", "--count", "@{u}..HEAD"],
            ).unwrap_or_else(|_| "0".to_string());
            let behind_str = run_git(
                project_path,
                &["rev-list", "--count", "HEAD..@{u}"],
            ).unwrap_or_else(|_| "0".to_string());
            (
                ahead_str.trim().parse().unwrap_or(0),
                behind_str.trim().parse().unwrap_or(0),
            )
        } else {
            (0, 0)
        };

        Ok(GitStatus {
            branch,
            is_clean,
            ahead,
            behind,
            changed_files,
            has_remote,
            remote_url,
        })
    }

    /// Initialize a git repo in a directory (if not already one)
    pub fn git_init(project_path: &Path) -> Result<()> {
        if project_path.join(".git").exists() {
            return Ok(());
        }
        run_git(project_path, &["init"])?;
        Ok(())
    }

    /// Clone a repository into a project directory
    pub fn git_clone(clone_url: &str, target_path: &Path, token: Option<&str>, branch: Option<&str>) -> Result<()> {
        let url = if let Some(t) = token {
            // Inject token into clone URL for auth
            if clone_url.starts_with("https://") {
                clone_url.replacen("https://", &format!("https://oauth2:{}@", t), 1)
            } else {
                clone_url.to_string()
            }
        } else {
            clone_url.to_string()
        };

        let mut args = vec!["clone", "--depth", "1"];
        if let Some(b) = branch {
            args.push("--branch");
            args.push(b);
        }
        args.push(&url);
        args.push(target_path.to_str().unwrap_or(""));

        let output = Command::new("git")
            .args(&args)
            .output()
            .map_err(|e| crate::Error::Network(format!("Failed to run git clone: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(crate::Error::Network(format!("Git clone failed: {}", stderr)));
        }

        Ok(())
    }

    /// Push project to a remote repository
    pub fn git_push(
        project_path: &Path,
        remote_url: &str,
        token: &str,
        branch: &str,
        commit_message: &str,
    ) -> Result<()> {
        // Stage all changes
        run_git(project_path, &["add", "-A"])?;

        // Check if there are staged changes
        let diff = run_git(project_path, &["diff", "--cached", "--quiet"]);
        if diff.is_ok() {
            // No changes to commit — still try to push existing commits
        } else {
            run_git(project_path, &["commit", "-m", commit_message])?;
        }

        // Set or update remote
        let remote_exists = run_git(project_path, &["remote", "get-url", "origin"]).is_ok();
        if remote_exists {
            run_git(project_path, &["remote", "set-url", "origin", remote_url])?;
        } else {
            run_git(project_path, &["remote", "add", "origin", remote_url])?;
        }

        // Push with token-based auth in URL
        let auth_url = if remote_url.starts_with("https://") {
            remote_url.replacen("https://", &format!("https://oauth2:{}@", token), 1)
        } else {
            remote_url.to_string()
        };

        run_git(project_path, &["push", "-u", &auth_url, branch])?;

        Ok(())
    }

    /// Stage, commit, and push changes in an existing git repo
    pub fn git_commit_and_push(project_path: &Path, message: &str, author_name: Option<&str>, author_email: Option<&str>) -> Result<String> {
        // Configure git identity for commits
        let name = author_name.unwrap_or("Monastery AI");
        let email = author_email.unwrap_or("monastery@homelab.local");
        let _ = run_git(project_path, &["config", "user.email", email]);
        let _ = run_git(project_path, &["config", "user.name", name]);
        
        // Stage all changes
        run_git(project_path, &["add", "-A"])?;

        // Check if there are staged changes
        let diff_check = run_git(project_path, &["diff", "--cached", "--quiet"]);
        if diff_check.is_ok() {
            return Ok("No changes to commit".to_string());
        }

        // Commit
        run_git(project_path, &["commit", "-m", message])?;

        // Get current branch
        let branch = run_git(project_path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "main".to_string());

        // Push to origin
        run_git(project_path, &["push", "origin", &branch])?;

        Ok(format!("Committed and pushed to origin/{}", branch))
    }

    /// Pull latest changes from remote
    pub fn git_pull(project_path: &Path, token: Option<&str>) -> Result<String> {
        let remote_url = run_git(project_path, &["remote", "get-url", "origin"])
            .map_err(|_| crate::Error::Config("No remote 'origin' configured".into()))?;

        let pull_url = if let (Some(t), true) = (token, remote_url.starts_with("https://")) {
            remote_url.replacen("https://", &format!("https://oauth2:{}@", t), 1)
        } else {
            remote_url
        };

        let output = Command::new("git")
            .args(["pull", &pull_url])
            .current_dir(project_path)
            .output()
            .map_err(|e| crate::Error::Network(format!("Failed to run git pull: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(crate::Error::Network(format!("Git pull failed: {}", stderr)));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        Ok(stdout)
    }
}

/// Helper: run a git command and return trimmed stdout
fn run_git(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| crate::Error::Unknown(format!("Failed to run git: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(crate::Error::Unknown(format!("git {} failed: {}", args.join(" "), stderr)));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
