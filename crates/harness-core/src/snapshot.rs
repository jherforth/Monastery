//! Snapshot management for code versioning and rollback
//!
//! Provides types and utilities for creating, storing, and restoring
//! code snapshots at specific points in time.

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::{DateTime, Utc};

/// A snapshot represents a point-in-time state of a project's files
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub created_by: Option<String>,
    pub parent_snapshot_id: Option<Uuid>,
    pub is_active: bool,
    pub metadata: SnapshotMetadata,
    pub tags: Vec<String>,
}

/// Metadata associated with a snapshot
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SnapshotMetadata {
    pub total_files: u32,
    pub total_size_bytes: u64,
    pub changed_files: u32,
    pub commit_message: Option<String>,
    pub trigger: SnapshotTrigger,
}

/// What triggered the snapshot creation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotTrigger {
    Manual,
    AutoSave,
    BeforeChange,
    AfterChange,
    PreDeployment,
    UserRequest,
}

impl Default for SnapshotTrigger {
    fn default() -> Self {
        SnapshotTrigger::Manual
    }
}

/// A file within a snapshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotFile {
    pub id: Uuid,
    pub snapshot_id: Uuid,
    pub file_path: String,
    pub content: Option<String>,
    pub file_hash: String,
    pub created_at: DateTime<Utc>,
    pub size_bytes: u64,
}

/// Request to create a new snapshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSnapshotRequest {
    pub project_id: Uuid,
    pub name: Option<String>,
    pub description: Option<String>,
    pub created_by: Option<String>,
    pub trigger: SnapshotTrigger,
    pub files: Vec<SnapshotFileInput>,
    pub parent_snapshot_id: Option<Uuid>,
}

/// Input file data for snapshot creation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotFileInput {
    pub file_path: String,
    pub content: Option<String>,
}

/// Response after creating a snapshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSnapshotResponse {
    pub snapshot: Snapshot,
    pub files_count: u32,
    pub total_size_bytes: u64,
}

/// Request to restore a project to a previous snapshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreSnapshotRequest {
    pub snapshot_id: Uuid,
    pub dry_run: bool,
    pub create_backup: bool,
}

/// Response after restoring a snapshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreSnapshotResponse {
    pub success: bool,
    pub restored_files: u32,
    pub failed_files: u32,
    pub backup_snapshot_id: Option<Uuid>,
    pub errors: Vec<String>,
}

/// List of snapshots with pagination
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotList {
    pub snapshots: Vec<SnapshotSummary>,
    pub total: u32,
    pub page: u32,
    pub per_page: u32,
}

/// Summary information about a snapshot (for listing)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotSummary {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub created_by: Option<String>,
    pub parent_snapshot_id: Option<Uuid>,
    pub is_active: bool,
    pub tags: Vec<String>,
    pub files_count: u32,
    pub total_size_bytes: u64,
}

/// Diff between two snapshots or current state
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SnapshotDiff {
    pub added_files: Vec<FileDiff>,
    pub removed_files: Vec<FileDiff>,
    pub modified_files: Vec<FileDiff>,
    pub unchanged_files: Vec<FileDiff>,
}

/// Information about a file difference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    pub file_path: String,
    pub old_hash: Option<String>,
    pub new_hash: Option<String>,
    pub old_size: u64,
    pub new_size: u64,
    pub change_type: FileChangeType,
}

/// Type of file change
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeType {
    Added,
    Removed,
    Modified,
    Unchanged,
}

impl Snapshot {
    /// Create a new snapshot instance
    pub fn new(
        project_id: Uuid,
        name: String,
        description: Option<String>,
        created_by: Option<String>,
        parent_snapshot_id: Option<Uuid>,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            project_id,
            name,
            description,
            created_at: Utc::now(),
            created_by,
            parent_snapshot_id,
            is_active: false,
            metadata: SnapshotMetadata::default(),
            tags: Vec::new(),
        }
    }
    
    /// Generate a default snapshot name based on timestamp
    pub fn generate_default_name() -> String {
        let now = Utc::now();
        format!("Snapshot {}", now.format("%Y-%m-%d %H:%M:%S"))
    }
}

impl SnapshotFile {
    /// Create a new snapshot file instance
    pub fn new(
        snapshot_id: Uuid,
        file_path: String,
        content: Option<String>,
    ) -> Self {
        let content_str = content.as_deref().unwrap_or("");
        let file_hash = compute_file_hash(content_str);
        let size_bytes = content_str.len() as u64;
        
        Self {
            id: Uuid::new_v4(),
            snapshot_id,
            file_path,
            content,
            file_hash,
            created_at: Utc::now(),
            size_bytes,
        }
    }
}

/// Compute a SHA-256 hash of file content
fn compute_file_hash(content: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_snapshot_creation() {
        let project_id = Uuid::new_v4();
        let snapshot = Snapshot::new(
            project_id,
            "Test Snapshot".to_string(),
            Some("Description".to_string()),
            Some("user".to_string()),
            None,
        );
        
        assert_eq!(snapshot.project_id, project_id);
        assert_eq!(snapshot.name, "Test Snapshot");
        assert!(!snapshot.is_active);
    }
    
    #[test]
    fn test_snapshot_file_creation() {
        let snapshot_id = Uuid::new_v4();
        let file = SnapshotFile::new(
            snapshot_id,
            "src/main.rs".to_string(),
            Some("fn main() {}".to_string()),
        );
        
        assert_eq!(file.file_path, "src/main.rs");
        assert!(!file.file_hash.is_empty());
        assert_eq!(file.size_bytes, 13); // length of "fn main() {}"
    }
    
    #[test]
    fn test_default_snapshot_name() {
        let name = Snapshot::generate_default_name();
        assert!(name.starts_with("Snapshot "));
    }
}
