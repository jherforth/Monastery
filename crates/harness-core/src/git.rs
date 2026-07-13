//! Git Forge Integration Service
//!
//! Handles Git operations (status, push, pull, clone) and forge API calls
//! for GitHub, GitLab, Forgejo, and Gitea. Uses system `git` CLI for local operations
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
            GitForgeType::Gitea => (base_url.to_string(), "/api/v1/user"),
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
            GitForgeType::GitHub | GitForgeType::Forgejo | GitForgeType::Gitea => {
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

    /// Validate that a Gitea instance URL is plausible
    pub fn validate_gitea_url(url: &str) -> Result<()> {
        if url.is_empty() {
            return Err(crate::Error::Config("Gitea requires a base URL (e.g., https://git.yourdomain.com)".into()));
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(crate::Error::Config("Gitea URL must start with http:// or https://".into()));
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
                GitForgeType::Forgejo | GitForgeType::Gitea => (
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
            GitForgeType::Forgejo | GitForgeType::Gitea => serde_json::json!({
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
            GitForgeType::GitHub | GitForgeType::Forgejo | GitForgeType::Gitea => GitRepo {
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
            // GitHub/Forgejo/Gitea don't include is_default; GitLab might not either
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

        // NOTE: a FULL clone (no --depth) for the local working copy. A shallow clone can't
        // rebase/merge cleanly against later remote commits, which broke multi-contributor
        // sync. The throwaway deploy clone (generate_clone_dockerfile) stays shallow.
        let mut args = vec!["clone"];
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
        // Ensure a commit identity exists (a fresh clone may have none, which makes `git commit` fail).
        let _ = run_git(project_path, &["config", "user.email", "monastery@homelab.local"]);
        let _ = run_git(project_path, &["config", "user.name", "Monastery AI"]);

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

    /// Stage, commit, and push changes in an existing git repo. When a `token` is supplied the
    /// remote is fetched and any diverging commits (another contributor's work) are rebased in
    /// BEFORE pushing — so a non-fast-forward rejection can't leave the user stuck. A rebase
    /// conflict aborts cleanly and reports it; the local commit is preserved either way.
    pub fn git_commit_and_push(project_path: &Path, message: &str, author_name: Option<&str>, author_email: Option<&str>, token: Option<&str>) -> Result<String> {
        // Configure git identity for commits
        let name = author_name.unwrap_or("Monastery AI");
        let email = author_email.unwrap_or("monastery@homelab.local");
        let _ = run_git(project_path, &["config", "user.email", email]);
        let _ = run_git(project_path, &["config", "user.name", name]);

        // Stage all changes
        run_git(project_path, &["add", "-A"])?;

        // Check if there are staged changes
        let diff_check = run_git(project_path, &["diff", "--cached", "--quiet"]);
        let had_changes = diff_check.is_err();
        if had_changes {
            run_git(project_path, &["commit", "-m", message])?;
        }

        // Get current branch
        let branch = run_git(project_path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "main".to_string());

        // Integrate remote changes before pushing (multi-contributor safety). Best-effort fetch:
        // a brand-new remote branch or an offline forge shouldn't block a local commit.
        let mut rebased_remote = false;
        if Self::git_fetch(project_path, token, &branch).is_ok() {
            let behind = count_commits(project_path, &format!("HEAD..origin/{}", branch));
            if behind > 0 {
                if run_git(project_path, &["rebase", &format!("origin/{}", branch)]).is_err() {
                    let _ = run_git(project_path, &["rebase", "--abort"]);
                    return Err(crate::Error::Config(format!(
                        "origin/{b} has commits from another contributor that conflict with your changes. Your work is committed locally but was NOT pushed — use Pull to bring in and resolve their changes, then push again.", b = branch
                    )));
                }
                rebased_remote = true;
            }
        }

        // Nothing to do if there were no local changes AND we didn't pull anything to push.
        let ahead = count_commits(project_path, &format!("origin/{}..HEAD", branch));
        if !had_changes && ahead == 0 {
            return Ok("No changes to commit".to_string());
        }

        // Push (token-authed URL when available; else rely on origin's stored credentials).
        push_current(project_path, token, &branch)?;

        Ok(if rebased_remote {
            format!("Merged remote changes and pushed to origin/{}", branch)
        } else {
            format!("Committed and pushed to origin/{}", branch)
        })
    }

    /// Pull remote changes into the local working copy, rebasing local edits on top so nothing
    /// is lost. Uncommitted edits are committed first (as a safety commit) before the rebase.
    /// Returns a human-readable summary; a rebase conflict is rolled back and reported.
    pub fn git_pull(project_path: &Path, token: Option<&str>) -> Result<String> {
        let branch = run_git(project_path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "main".to_string());

        Self::git_fetch(project_path, token, &branch)?;

        let behind = count_commits(project_path, &format!("HEAD..origin/{}", branch));
        if behind == 0 {
            return Ok(format!("Already up to date with origin/{}.", branch));
        }

        // Preserve any uncommitted local edits as a commit so the rebase can't discard them.
        let _ = run_git(project_path, &["config", "user.email", "monastery@homelab.local"]);
        let _ = run_git(project_path, &["config", "user.name", "Monastery AI"]);
        run_git(project_path, &["add", "-A"])?;
        if run_git(project_path, &["diff", "--cached", "--quiet"]).is_err() {
            run_git(project_path, &["commit", "-m", "Monastery: local changes before pull"])?;
        }

        match run_git(project_path, &["rebase", &format!("origin/{}", branch)]) {
            Ok(_) => Ok(format!("Pulled {} change(s) from origin/{} (your local edits kept on top).", behind, branch)),
            Err(_) => {
                let _ = run_git(project_path, &["rebase", "--abort"]);
                Err(crate::Error::Config(format!(
                    "Pulled changes from origin/{b} conflict with your local edits. The pull was rolled back — revert or reconcile the overlapping changes, then try again.", b = branch
                )))
            }
        }
    }

    /// Fetch `branch` from origin into refs/remotes/origin/<branch>, unshallowing a shallow
    /// clone so a later rebase/merge has enough history. Auth via token when the origin URL is
    /// http(s); a token-less/offline call simply returns Err and callers treat it as best-effort.
    pub fn git_fetch(project_path: &Path, token: Option<&str>, branch: &str) -> Result<()> {
        let remote_url = run_git(project_path, &["remote", "get-url", "origin"])
            .map_err(|_| crate::Error::Config("No remote 'origin' configured".into()))?;
        let url = match token {
            Some(t) => inject_token(&remote_url, t),
            None => remote_url,
        };
        let is_shallow = run_git(project_path, &["rev-parse", "--is-shallow-repository"])
            .map(|s| s.trim() == "true").unwrap_or(false);
        // '+' force-updates the tracking ref even on a non-fast-forward remote history.
        let refspec = format!("+{b}:refs/remotes/origin/{b}", b = branch);
        if is_shallow {
            // Unshallow so merges work; if it errors (e.g. already complete), fall through.
            if run_git(project_path, &["fetch", "--unshallow", &url, &refspec]).is_ok() {
                return Ok(());
            }
        }
        run_git(project_path, &["fetch", &url, &refspec]).map(|_| ())
    }
}

/// Count commits in a revision range (e.g. "HEAD..origin/main"); 0 on any error.
fn count_commits(project_path: &Path, range: &str) -> u32 {
    run_git(project_path, &["rev-list", "--count", range])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Push the current branch to origin, using a token-authed URL when available.
fn push_current(project_path: &Path, token: Option<&str>, branch: &str) -> Result<()> {
    match token {
        Some(t) => {
            let remote_url = run_git(project_path, &["remote", "get-url", "origin"])?;
            let url = inject_token(&remote_url, t);
            run_git(project_path, &["push", &url, branch]).map(|_| ())
        }
        None => run_git(project_path, &["push", "origin", branch]).map(|_| ()),
    }
}

/// Inject an oauth2 token into an http(s) remote URL for authenticated fetch/push. Idempotent:
/// strips any credentials already baked into the URL first, so a token-cloned origin
/// (`https://oauth2:TOKEN@host/…`) doesn't get double-injected into a malformed URL that fails auth.
fn inject_token(remote_url: &str, token: &str) -> String {
    for scheme in ["https://", "http://"] {
        if let Some(rest) = remote_url.strip_prefix(scheme) {
            // Split off the authority (up to the first '/') and drop any existing "user:pass@".
            let (authority, path) = match rest.find('/') {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, ""),
            };
            let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
            return format!("{}oauth2:{}@{}{}", scheme, token, host, path);
        }
    }
    remote_url.to_string()
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
