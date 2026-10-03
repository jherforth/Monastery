//! User-initiated file operations, plus the edit helpers the chat turn applies changes with.

use super::*;

/// List files in a project directory
pub async fn list_project_files(
    project: ProjectCtx,
) -> Result<Json<Vec<serde_json::Value>>, ApiError> {
    let project_path = project.dir.clone();
    if !project_path.exists() {
        return Ok(Json(Vec::new()));
    }

    let files = walk_directory(&project_path, &project_path);
    Ok(Json(files))
}

/// Read a single file from a project
pub async fn read_project_file(
    project: ProjectCtx,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let file_path = params.get("path").ok_or_else(|| ApiError::Config("Missing path parameter".into()))?;
    let full_path = project.dir.join(file_path);

    // Security: ensure the resolved path is within the project directory
    let canonical_base = project.dir.canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;
    let canonical_file = full_path.canonicalize()
        .map_err(|_| ApiError::NotFound("File not found".into()))?;
    if !canonical_file.starts_with(&canonical_base) {
        return Err(ApiError::Config("Path traversal not allowed".into()));
    }

    let content = std::fs::read_to_string(&canonical_file)
        .map_err(|e| ApiError::Internal(format!("Failed to read file: {}", e)))?;

    Ok(Json(serde_json::json!({ "content": content, "path": file_path })))
}

/// Write content to a file in a project
#[derive(Debug, Deserialize)]
pub struct WriteFileRequest {
    pub path: String,
    pub content: String,
    /// "base64" = content is base64-encoded binary (e.g. an uploaded image) and must be
    /// decoded to raw bytes before writing. Absent/other = plain text.
    #[serde(default)]
    pub encoding: Option<String>,
}

/// Resolve a client-supplied relative path inside a project directory, refusing anything that
/// could land outside it. Runs BEFORE anything is created on disk — the previous handlers called
/// `create_dir_all` first and checked afterwards, so `../../x/y` created directories outside the
/// project before being rejected. Lexical check first (no absolute paths, no `..`), then the
/// deepest existing ancestor is canonicalized so a symlink inside the project (e.g. from a cloned
/// repo) can't redirect the write elsewhere.
pub(crate) fn safe_project_path(project_dir: &std::path::Path, rel: &str) -> Result<std::path::PathBuf, ApiError> {
    use std::path::Component;
    let mut clean = std::path::PathBuf::new();
    for part in std::path::Path::new(rel).components() {
        match part {
            Component::Normal(p) => clean.push(p),
            Component::CurDir => {}
            _ => return Err(ApiError::Config("Path traversal not allowed".into())),
        }
    }
    let base = project_dir.canonicalize()
        .map_err(|_| ApiError::NotFound("Project directory not found".into()))?;
    let full = base.join(&clean);
    let mut existing = full.as_path();
    while !existing.exists() {
        match existing.parent() {
            Some(p) => existing = p,
            None => break,
        }
    }
    let resolved = existing.canonicalize()
        .map_err(|_| ApiError::Internal("Failed to resolve path".into()))?;
    if !resolved.starts_with(&base) {
        return Err(ApiError::Config("Path traversal not allowed".into()));
    }
    Ok(full)
}

pub async fn write_project_file(
    project: ProjectCtx,
    Json(req): Json<WriteFileRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_dir = project.dir.clone();
    let full_path = safe_project_path(&project_dir, &req.path)?;

    if let Some(parent) = full_path.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| ApiError::Internal(format!("Failed to create directories: {}", e)))?;
    }

    if req.encoding.as_deref() == Some("base64") {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(req.content.trim())
            .map_err(|e| ApiError::Config(format!("Invalid base64 content: {}", e)))?;
        std::fs::write(&full_path, bytes)
            .map_err(|e| ApiError::Internal(format!("Failed to write file: {}", e)))?;
    } else {
        std::fs::write(&full_path, &req.content)
            .map_err(|e| ApiError::Internal(format!("Failed to write file: {}", e)))?;
    }

    Ok(Json(serde_json::json!({ "success": true, "path": req.path })))
}

/// Guardrail against the "section clobbered the whole file" bug: an AI whole-file write whose
/// content is literally a contiguous slice of a non-trivial existing file is almost certainly a
/// partial edit mis-formatted as a full file, and writing it would delete the rest. (Low
/// false-positive: a genuine rewrite essentially never reproduces itself as an exact substring.)
pub(crate) fn is_partial_overwrite(existing: &str, new: &str) -> bool {
    let (old, new) = (existing.trim(), new.trim());
    old.len() > 400 && new.len() < old.len() && old.contains(new)
}

/// Result of applying search/replace hunks to a file's contents.
pub(crate) struct EditOutcome {
    pub applied: usize,
    /// Hunks whose search text matched nowhere, as (search, replace).
    pub failed: Vec<(String, String)>,
    pub content: String,
}

/// Apply targeted search/replace hunks in order — a real modify-in-place, so the model can
/// change one section of a large file without re-emitting (and risking truncating) all of it.
pub(crate) fn apply_hunks(content: &str, hunks: &[(String, String)]) -> EditOutcome {
    let mut out = EditOutcome { applied: 0, failed: Vec::new(), content: content.to_string() };
    for (search, replace) in hunks {
        match find_match_range(&out.content, search) {
            Some((s, e)) => {
                out.content.replace_range(s..e, replace);
                out.applied += 1;
            }
            None => out.failed.push((search.clone(), replace.clone())),
        }
    }
    out
}

/// Find `needle` in `hay` and return the (start, end) byte range of the first match. Tiers, from
/// strict to loose, so a model that slightly misquotes a section still lands the edit:
///   1. exact substring
///   2. line-by-line, ignoring TRAILING whitespace
///   3. line-by-line, ignoring LEADING+TRAILING whitespace (indentation drift — the common case
///      where the model reflows/re-indents the SEARCH block relative to the real file)
///   4. as (3) but ignoring blank lines on both sides (stray blank line in the SEARCH block)
///   5. fuzzy: >=4 lines, >=80% of lines matching, and the single best window (see below)
pub(crate) fn find_match_range(hay: &str, needle: &str) -> Option<(usize, usize)> {
    if needle.trim().is_empty() {
        return None;
    }
    // Tier 1: exact.
    if let Some(pos) = hay.find(needle) {
        return Some((pos, pos + needle.len()));
    }

    let hay_lines: Vec<&str> = hay.lines().collect();
    // Byte offset of the start of each line (for reconstructing the match range).
    let mut line_starts = Vec::with_capacity(hay_lines.len() + 1);
    let mut off = 0usize;
    for l in &hay_lines {
        line_starts.push(off);
        off += l.len();
        // account for the '\n' that `lines()` stripped (assumes LF; CRLF is normalized on write)
        if off < hay.len() {
            off += 1;
        }
    }
    line_starts.push(hay.len());

    // Reconstruct the byte range spanning hay lines [first, last].
    let byte_range = |first: usize, last: usize| -> (usize, usize) {
        let start_byte = line_starts[first];
        let end_byte = if last + 1 < hay_lines.len() {
            line_starts[last + 1].saturating_sub(1)
        } else {
            hay.len()
        };
        (start_byte, end_byte)
    };

    // Contiguous line match with a given per-line normalizer (tiers 2 & 3).
    fn norm_line(l: &str, trim_both: bool) -> &str {
        if trim_both { l.trim() } else { l.trim_end() }
    }
    let windowed = |trim_both: bool| -> Option<(usize, usize)> {
        let needle_norm: Vec<&str> = needle.lines().map(|l| norm_line(l, trim_both)).collect();
        if needle_norm.is_empty() || hay_lines.len() < needle_norm.len() {
            return None;
        }
        for start in 0..=(hay_lines.len() - needle_norm.len()) {
            if needle_norm.iter().enumerate().all(|(i, nl)| norm_line(hay_lines[start + i], trim_both) == *nl) {
                return Some(byte_range(start, start + needle_norm.len() - 1));
            }
        }
        None
    };

    if let Some(r) = windowed(false) { return Some(r); }
    if let Some(r) = windowed(true) { return Some(r); }

    // Tier 4: match the non-blank lines only (blank lines ignored on both sides), fully trimmed.
    let needle_ne: Vec<&str> = needle.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    if needle_ne.is_empty() {
        return None;
    }
    let hay_ne: Vec<(usize, &str)> = hay_lines.iter().enumerate()
        .map(|(i, l)| (i, l.trim()))
        .filter(|(_, l)| !l.is_empty())
        .collect();
    if hay_ne.len() < needle_ne.len() {
        return None;
    }
    for start in 0..=(hay_ne.len() - needle_ne.len()) {
        if (0..needle_ne.len()).all(|k| hay_ne[start + k].1 == needle_ne[k]) {
            let first_line = hay_ne[start].0;
            let last_line = hay_ne[start + needle_ne.len() - 1].0;
            return Some(byte_range(first_line, last_line));
        }
    }

    // Tier 5: fuzzy — the model got most of the block right but misquoted a line or two. Slide a
    // window and score by positional line similarity (fully trimmed). Requires >=4 lines, >=80%
    // of them matching, and a SOLE best window. (The looser "escalated retry" variant was dropped
    // in simplification Phase 3: a failed edit is now retried against fresh file contents
    // instead.) The pre-turn snapshot backstops the residual wrong-region risk.
    let needle_t: Vec<&str> = needle.lines().map(|l| l.trim()).collect();
    let n = needle_t.len();
    let (min_lines, ratio_num, ratio_den) = (4usize, 4usize, 5usize);
    if n >= min_lines && hay_lines.len() >= n {
        let hay_t: Vec<&str> = hay_lines.iter().map(|l| l.trim()).collect();
        let score = |start: usize| -> usize {
            (0..n).filter(|&i| hay_t[start + i] == needle_t[i]).count()
        };
        let last_start = hay_t.len() - n;
        let mut best_start = 0usize;
        let mut best_count = 0usize;
        for start in 0..=last_start {
            let c = score(start);
            if c > best_count { best_count = c; best_start = start; }
        }
        let unique = (0..=last_start).filter(|&s| score(s) == best_count).count() == 1;
        // best_count/n >= ratio_num/ratio_den, integer-safe.
        if best_count * ratio_den >= n * ratio_num && unique {
            return Some(byte_range(best_start, best_start + n - 1));
        }
    }

    None
}

/// Query param for file/directory path operations
#[derive(Debug, Deserialize)]
pub struct FilePathQuery {
    pub path: String,
}

/// Delete a file from a project
pub async fn delete_project_file(
    project: ProjectCtx,
    Query(query): Query<FilePathQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_path = project.dir.clone();
    let canonical_base = project_path.canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;

    let full_path = project_path.join(&query.path);

    // Security: canonicalize and verify within project
    let resolved = full_path.canonicalize()
        .map_err(|_| ApiError::NotFound(format!("File not found: {}", query.path)))?;
    if !resolved.starts_with(&canonical_base) {
        return Err(ApiError::Config("Path traversal not allowed".into()));
    }
    if !resolved.is_file() {
        return Err(ApiError::Config("Path is not a file".into()));
    }

    std::fs::remove_file(&resolved)
        .map_err(|e| ApiError::Internal(format!("Failed to delete file: {}", e)))?;

    tracing::info!("Deleted file: {}", query.path);
    Ok(Json(serde_json::json!({ "success": true, "path": query.path })))
}

/// Create a new directory in a project
pub async fn create_project_directory(
    project: ProjectCtx,
    Query(query): Query<FilePathQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_dir = project.dir.clone();
    // (The old check here was skipped entirely when the parent didn't exist yet.)
    let full_path = safe_project_path(&project_dir, &query.path)?;

    if full_path.exists() {
        return Err(ApiError::Config(format!("Directory already exists: {}", query.path)));
    }

    std::fs::create_dir_all(&full_path)
        .map_err(|e| ApiError::Internal(format!("Failed to create directory: {}", e)))?;

    tracing::info!("Created directory: {}", query.path);
    Ok(Json(serde_json::json!({ "success": true, "path": query.path })))
}

/// Delete a directory and all its contents from a project
pub async fn delete_project_directory(
    project: ProjectCtx,
    Query(query): Query<FilePathQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_path = project.dir.clone();
    let canonical_base = project_path.canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;

    let full_path = project_path.join(&query.path);

    // Security: canonicalize and verify within project
    let resolved = full_path.canonicalize()
        .map_err(|_| ApiError::NotFound(format!("Directory not found: {}", query.path)))?;
    if !resolved.starts_with(&canonical_base) {
        return Err(ApiError::Config("Path traversal not allowed".into()));
    }
    if !resolved.is_dir() {
        return Err(ApiError::Config("Path is not a directory".into()));
    }
    // Prevent deleting the project root itself
    if resolved == canonical_base {
        return Err(ApiError::Config("Cannot delete project root directory".into()));
    }

    std::fs::remove_dir_all(&resolved)
        .map_err(|e| ApiError::Internal(format!("Failed to delete directory: {}", e)))?;

    tracing::info!("Deleted directory: {}", query.path);
    Ok(Json(serde_json::json!({ "success": true, "path": query.path })))
}

/// Upload a file to a project (accepts raw binary bytes)
pub async fn upload_project_file(
    project: ProjectCtx,
    Query(query): Query<FilePathQuery>,
    body: axum::body::Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_dir = project.dir.clone();
    let full_path = safe_project_path(&project_dir, &query.path)?;

    if let Some(parent) = full_path.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| ApiError::Internal(format!("Failed to create directories: {}", e)))?;
    }

    std::fs::write(&full_path, &body)
        .map_err(|e| ApiError::Internal(format!("Failed to write file: {}", e)))?;

    tracing::info!("Uploaded file: {} ({} bytes)", query.path, body.len());
    Ok(Json(serde_json::json!({ "success": true, "path": query.path, "size": body.len() })))
}

/// Move/rename a file or directory within a project
#[derive(Debug, Deserialize)]
pub struct MoveFileRequest {
    pub source: String,
    pub destination: String,
}

pub async fn move_project_file(
    project: ProjectCtx,
    Json(req): Json<MoveFileRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let project_path = project.dir.clone();
    let canonical_base = project_path.canonicalize()
        .map_err(|_| ApiError::Internal("Project directory not found".into()))?;

    let source_path = project_path.join(&req.source);

    // Verify source exists and is within project
    let canonical_source = source_path.canonicalize()
        .map_err(|_| ApiError::NotFound(format!("Source not found: {}", req.source)))?;
    if !canonical_source.starts_with(&canonical_base) {
        return Err(ApiError::Config("Source path traversal not allowed".into()));
    }

    // Validate the destination BEFORE creating its parent directories.
    let dest_path = safe_project_path(&project_path, &req.destination)?;
    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| ApiError::Internal(format!("Failed to create target directories: {}", e)))?;
    }

    // Prevent moving into self (source is a prefix of destination = moving into own subtree)
    if dest_path.starts_with(&canonical_source) {
        return Err(ApiError::Config("Cannot move a directory into itself".into()));
    }

    if dest_path.exists() {
        return Err(ApiError::Config(format!("Destination already exists: {}", req.destination)));
    }

    std::fs::rename(&canonical_source, &dest_path)
        .map_err(|e| ApiError::Internal(format!("Failed to move: {}", e)))?;

    tracing::info!("Moved {} -> {}", req.source, req.destination);
    Ok(Json(serde_json::json!({ "success": true, "source": req.source, "destination": req.destination })))
}
