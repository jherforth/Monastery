//! Project filesystem helpers: resolving a project's directory, validating client-supplied
//! paths, and reading files for context and snapshots.

use super::*;

/// Helper: recursively read files for snapshot creation
pub(crate) fn read_files_for_snapshot(
    base: &std::path::Path,
    current: &std::path::Path,
    files: &mut Vec<harness_core::snapshot::SnapshotFileInput>,
) {
    if let Ok(read_dir) = std::fs::read_dir(current) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if name == ".git" || name == "node_modules" || name == "target" { continue; }

            let rel_path = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();

            if path.is_dir() {
                read_files_for_snapshot(base, &path, files);
            } else if let Ok(content) = std::fs::read_to_string(&path) {
                files.push(harness_core::snapshot::SnapshotFileInput {
                    file_path: rel_path,
                    content: Some(content),
                });
            }
        }
    }
}

/// A project resolved from the request: its id, its name, and its directory under data_dir.
/// As an extractor it reads the route's `:id` or `:project_id` segment; `ProjectCtx::load`
/// covers ids that arrive in a query string or request body. This replaces the project-name
/// lookup that used to be copy-pasted into most handlers.
pub struct ProjectCtx {
    pub id: Uuid,
    pub name: String,
    pub dir: std::path::PathBuf,
}

impl ProjectCtx {
    pub(crate) async fn load(state: &AppState, id: Uuid) -> Result<Self, ApiError> {
        let row = sqlx::query("SELECT name FROM projects WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&*state.db)
            .await?;
        let name: String = row
            .map(|r| r.get(0))
            .ok_or_else(|| ApiError::NotFound("Project not found".into()))?;
        let dir = state.config.data_dir.join(&name);
        Ok(Self { id, name, dir })
    }
}

#[axum::async_trait]
impl axum::extract::FromRequestParts<AppState> for ProjectCtx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut axum::http::request::Parts, state: &AppState) -> Result<Self, ApiError> {
        let params = axum::extract::RawPathParams::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::Config("Missing project id in the path".into()))?;
        let raw = params
            .iter()
            .find(|(key, _)| *key == "id" || *key == "project_id")
            .map(|(_, value)| value.to_string())
            .ok_or_else(|| ApiError::Config("Missing project id in the path".into()))?;
        let id = Uuid::parse_str(&raw).map_err(|_| ApiError::Config(format!("Invalid project id: {}", raw)))?;
        Self::load(state, id).await
    }
}

/// Resolve a project's on-disk directory (data_dir/<name>) from its id.
pub(crate) async fn resolve_project_dir(state: &AppState, project_id: Uuid) -> Result<std::path::PathBuf, ApiError> {
    Ok(ProjectCtx::load(state, project_id).await?.dir)
}

/// Directories never read into LLM context or searched: VCS internals, dependencies, build
/// output, caches, editor settings, and Monastery's own task/deploy state. Mirrors bolt.diy's
/// IGNORE_PATTERNS.
pub(crate) const CONTEXT_SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".turbo",
    "coverage", ".cache", ".monastery", ".vscode", ".idea", "__pycache__", ".venv", "venv",
];
/// Files never read into context. A lockfile alone can be bigger than a whole small site and
/// push it over the scoped-context threshold, and the model has no use for it.
pub(crate) const CONTEXT_SKIP_FILES: &[&str] = &[
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock",
    "composer.lock", "poetry.lock", "Gemfile.lock", ".DS_Store",
];
/// Generated/minified file suffixes never read into context.
pub(crate) const CONTEXT_SKIP_SUFFIXES: &[&str] = &[".log", ".map", ".min.js", ".min.css"];

pub(crate) fn is_context_ignored_file(name: &str) -> bool {
    CONTEXT_SKIP_FILES.contains(&name) || CONTEXT_SKIP_SUFFIXES.iter().any(|s| name.ends_with(s))
}

pub(crate) fn read_files_recursive(
    base: &std::path::Path,
    current: &std::path::Path,
    files: &mut serde_json::Map<String, serde_json::Value>,
    depth: usize,
) {
    if depth > 10 { return; } // Safety limit
    if let Ok(read_dir) = std::fs::read_dir(current) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

            let rel_path = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();

            if path.is_dir() {
                if CONTEXT_SKIP_DIRS.contains(&name.as_str()) { continue; }
                read_files_recursive(base, &path, files, depth + 1);
            } else if is_context_ignored_file(&name) {
                continue;
            } else {
                // Skip images/fonts outright: real binaries would fail read_to_string anyway,
                // but files uploaded before base64 decoding existed are data-URL *text* and
                // would dump megabytes of base64 into the LLM context.
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "bmp" | "avif" | "woff" | "woff2" | "ttf" | "otf" | "eot" | "pdf" | "zip" | "gz" | "tar" | "mp3" | "mp4" | "wav" | "ogg" | "webm") {
                    continue;
                }
                // Read text files only (skip binaries)
                if let Ok(content) = std::fs::read_to_string(&path) {
                    // Limit file size to ~200KB per file (most source files are under this)
                    let truncated: String = if content.len() > 200_000 {
                        format!("{}... [truncated at 200KB]", &content[..200_000])
                    } else {
                        content
                    };
                    files.insert(rel_path, serde_json::Value::String(truncated));
                }
            }
        }
    }
}

/// Recursively walk a directory and return a FileNode tree
pub(crate) fn walk_directory(base: &std::path::Path, current: &std::path::Path) -> Vec<serde_json::Value> {
    let mut entries = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(current) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            // Skip VCS internals and installed dependencies (thousands of entries nobody browses)
            if name == ".git" || name == "node_modules" {
                continue;
            }
            let rel_path = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();
            let is_dir = path.is_dir();
            let children: Vec<serde_json::Value> = if is_dir {
                walk_directory(base, &path)
            } else {
                Vec::new()
            };
            entries.push(serde_json::json!({
                "name": name,
                "path": rel_path,
                "type": if is_dir { "directory" } else { "file" },
                "children": children,
            }));
        }
    }
    entries.sort_by(|a, b| {
        let a_dir = a["type"].as_str() == Some("directory");
        let b_dir = b["type"].as_str() == Some("directory");
        b_dir.cmp(&a_dir).then(a["name"].as_str().cmp(&b["name"].as_str()))
    });
    entries
}
