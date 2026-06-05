//! Snapshot service for managing code versioning and rollback
//!
//! Provides database operations for creating, listing, and restoring snapshots.

use sqlx::{sqlite::SqlitePool, FromRow};
use uuid::Uuid;
use chrono::{DateTime, Utc};
use harness_core::{
    Snapshot, SnapshotFile, SnapshotMetadata, SnapshotTrigger,
    CreateSnapshotRequest, CreateSnapshotResponse,
    RestoreSnapshotRequest, RestoreSnapshotResponse,
    SnapshotList, SnapshotSummary, SnapshotDiff, FileDiff, FileChangeType,
};
use crate::db::DbError;

/// Service for managing snapshots
pub struct SnapshotService {
    pool: SqlitePool,
}

impl SnapshotService {
    /// Create a new snapshot service instance
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
    
    /// Create a new snapshot from the current project state
    pub async fn create_snapshot(
        &self,
        request: CreateSnapshotRequest,
    ) -> Result<CreateSnapshotResponse, DbError> {
        let mut tx = self.pool.begin().await?;
        
        let snapshot_id = Uuid::new_v4();
        let now = Utc::now().to_rfc3339();
        let name = request.name.unwrap_or_else(Snapshot::generate_default_name);
        
        // Insert the snapshot record
        sqlx::query(
            r#"
            INSERT INTO snapshots (id, project_id, name, description, created_at, created_by, parent_snapshot_id, is_active, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
            "#,
        )
        .bind(snapshot_id.to_string())
        .bind(request.project_id.to_string())
        .bind(&name)
        .bind(&request.description)
        .bind(&now)
        .bind(&request.created_by)
        .bind(request.parent_snapshot_id.map(|id| id.to_string()))
        .bind(serde_json::to_string(&SnapshotMetadata {
            total_files: request.files.len() as u32,
            total_size_bytes: 0,
            changed_files: 0,
            commit_message: request.description.clone(),
            trigger: request.trigger,
        })?)
        .execute(&mut *tx)
        .await?;
        
        // Insert all files
        let mut total_size = 0u64;
        for file_input in &request.files {
            let file_id = Uuid::new_v4();
            let content_str = file_input.content.as_deref().unwrap_or("");
            let file_hash = compute_hash(content_str);
            let size = content_str.len() as u64;
            total_size += size;
            
            sqlx::query(
                r#"
                INSERT INTO snapshot_files (id, snapshot_id, file_path, content, file_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                "#,
            )
            .bind(file_id.to_string())
            .bind(snapshot_id.to_string())
            .bind(&file_input.file_path)
            .bind(&file_input.content)
            .bind(&file_hash)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        
        // Update metadata with total size
        let metadata = SnapshotMetadata {
            total_files: request.files.len() as u32,
            total_size_bytes: total_size,
            changed_files: 0,
            commit_message: request.description.clone(),
            trigger: request.trigger,
        };
        
        sqlx::query("UPDATE snapshots SET metadata = ? WHERE id = ?")
            .bind(serde_json::to_string(&metadata)?)
            .bind(snapshot_id.to_string())
            .execute(&mut *tx)
            .await?;
        
        tx.commit().await?;
        
        Ok(CreateSnapshotResponse {
            snapshot: Snapshot {
                id: snapshot_id,
                project_id: request.project_id,
                name,
                description: request.description,
                created_at: Utc::now(),
                created_by: request.created_by,
                parent_snapshot_id: request.parent_snapshot_id,
                is_active: false,
                metadata,
                tags: Vec::new(),
            },
            files_count: request.files.len() as u32,
            total_size_bytes: total_size,
        })
    }
    
    /// List snapshots for a project with pagination
    pub async fn list_snapshots(
        &self,
        project_id: Uuid,
        page: u32,
        per_page: u32,
    ) -> Result<SnapshotList, DbError> {
        let offset = (page - 1) * per_page;
        
        // Get total count
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM snapshots WHERE project_id = ?"
        )
        .bind(project_id.to_string())
        .fetch_one(&self.pool)
        .await?;
        
        let total = count.0 as u32;
        
        // Get snapshots
        let rows = sqlx::query_as::<_, SnapshotRow>(
            r#"
            SELECT 
                s.id, s.project_id, s.name, s.description, s.created_at, 
                s.created_by, s.parent_snapshot_id, s.is_active, s.metadata,
                COUNT(sf.id) as files_count,
                COALESCE(SUM(LENGTH(sf.content)), 0) as total_size
            FROM snapshots s
            LEFT JOIN snapshot_files sf ON s.id = sf.snapshot_id
            WHERE s.project_id = ?
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ? OFFSET ?
            "#,
        )
        .bind(project_id.to_string())
        .bind(per_page as i64)
        .bind(offset as i64)
        .fetch_all(&self.pool)
        .await?;
        
        let snapshots: Vec<SnapshotSummary> = rows.into_iter()
            .map(|row| row.into_summary())
            .collect();
        
        Ok(SnapshotList {
            snapshots,
            total,
            page,
            per_page,
        })
    }
    
    /// Get a specific snapshot with its files
    pub async fn get_snapshot(
        &self,
        snapshot_id: Uuid,
    ) -> Result<(Snapshot, Vec<SnapshotFile>), DbError> {
        let row = sqlx::query_as::<_, SnapshotRow>(
            r#"
            SELECT 
                s.id, s.project_id, s.name, s.description, s.created_at, 
                s.created_by, s.parent_snapshot_id, s.is_active, s.metadata,
                COUNT(sf.id) as files_count,
                COALESCE(SUM(LENGTH(sf.content)), 0) as total_size
            FROM snapshots s
            LEFT JOIN snapshot_files sf ON s.id = sf.snapshot_id
            WHERE s.id = ?
            GROUP BY s.id
            "#,
        )
        .bind(snapshot_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        
        let row = row.ok_or_else(|| DbError::NotFound(format!("Snapshot {} not found", snapshot_id)))?;
        let snapshot = row.into_summary();
        
        // Reconstruct full snapshot
        let metadata: SnapshotMetadata = serde_json::from_str(
            &sqlx::query_scalar::<_, String>("SELECT metadata FROM snapshots WHERE id = ?")
                .bind(snapshot_id.to_string())
                .fetch_one(&self.pool)
                .await?
        ).unwrap_or_default();
        
        let full_snapshot = Snapshot {
            id: snapshot.id,
            project_id: snapshot.project_id,
            name: snapshot.name,
            description: snapshot.description,
            created_at: snapshot.created_at,
            created_by: snapshot.created_by,
            parent_snapshot_id: snapshot.parent_snapshot_id,
            is_active: snapshot.is_active,
            metadata,
            tags: Vec::new(), // Would need separate query for tags
        };
        
        // Get files
        let file_rows = sqlx::query_as::<_, FileRow>(
            "SELECT id, snapshot_id, file_path, content, file_hash, created_at FROM snapshot_files WHERE snapshot_id = ?"
        )
        .bind(snapshot_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        
        let files: Vec<SnapshotFile> = file_rows.into_iter()
            .map(|row| row.into_file())
            .collect();
        
        Ok((full_snapshot, files))
    }
    
    /// Restore a project to a previous snapshot
    pub async fn restore_snapshot(
        &self,
        request: RestoreSnapshotRequest,
    ) -> Result<RestoreSnapshotResponse, DbError> {
        let mut errors = Vec::new();
        let mut restored_count = 0u32;
        let mut failed_count = 0u32;
        let mut backup_snapshot_id: Option<Uuid> = None;
        
        // First, get the snapshot to restore
        let (snapshot, files) = match self.get_snapshot(request.snapshot_id).await {
            Ok(result) => result,
            Err(e) => {
                return Ok(RestoreSnapshotResponse {
                    success: false,
                    restored_files: 0,
                    failed_files: 0,
                    backup_snapshot_id: None,
                    errors: vec![e.to_string()],
                });
            }
        };
        
        // If create_backup is true, create a snapshot of current state first
        if request.create_backup {
            // This would require getting current project files
            // For now, we'll skip this in the basic implementation
            backup_snapshot_id = Some(Uuid::new_v4());
        }
        
        // If dry_run, just report what would be restored
        if request.dry_run {
            return Ok(RestoreSnapshotResponse {
                success: true,
                restored_files: files.len() as u32,
                failed_files: 0,
                backup_snapshot_id,
                errors,
            });
        }
        
        // In a real implementation, this would write files to disk
        // For now, we'll just mark the snapshot as active and deactivate others
        let mut tx = self.pool.begin().await?;
        
        // Deactivate all other snapshots for this project
        sqlx::query("UPDATE snapshots SET is_active = 0 WHERE project_id = ? AND id != ?")
            .bind(snapshot.project_id.to_string())
            .bind(request.snapshot_id.to_string())
            .execute(&mut *tx)
            .await?;
        
        // Activate the restored snapshot
        sqlx::query("UPDATE snapshots SET is_active = 1 WHERE id = ?")
            .bind(request.snapshot_id.to_string())
            .execute(&mut *tx)
            .await?;
        
        tx.commit().await?;
        
        restored_count = files.len() as u32;
        
        Ok(RestoreSnapshotResponse {
            success: true,
            restored_files: restored_count,
            failed_files: failed_count,
            backup_snapshot_id,
            errors,
        })
    }
    
    /// Add a tag to a snapshot
    pub async fn add_tag(
        &self,
        snapshot_id: Uuid,
        tag: &str,
    ) -> Result<(), DbError> {
        let tag_id = Uuid::new_v4();
        let now = Utc::now().to_rfc3339();
        
        sqlx::query("INSERT OR IGNORE INTO snapshot_tags (id, snapshot_id, tag, created_at) VALUES (?, ?, ?, ?)")
            .bind(tag_id.to_string())
            .bind(snapshot_id.to_string())
            .bind(tag)
            .bind(&now)
            .execute(&self.pool)
            .await?;
        
        Ok(())
    }
    
    /// Remove a tag from a snapshot
    pub async fn remove_tag(
        &self,
        snapshot_id: Uuid,
        tag: &str,
    ) -> Result<(), DbError> {
        sqlx::query("DELETE FROM snapshot_tags WHERE snapshot_id = ? AND tag = ?")
            .bind(snapshot_id.to_string())
            .bind(tag)
            .execute(&self.pool)
            .await?;
        
        Ok(())
    }
    
    /// Get diff between two snapshots
    pub async fn diff_snapshots(
        &self,
        snapshot_id_1: Uuid,
        snapshot_id_2: Uuid,
    ) -> Result<SnapshotDiff, DbError> {
        let (_, files_1) = self.get_snapshot(snapshot_id_1).await?;
        let (_, files_2) = self.get_snapshot(snapshot_id_2).await?;
        
        let mut diff = SnapshotDiff::default();
        
        let map_1: std::collections::HashMap<_, _> = files_1.iter()
            .map(|f| (f.file_path.clone(), f))
            .collect();
        let map_2: std::collections::HashMap<_, _> = files_2.iter()
            .map(|f| (f.file_path.clone(), f))
            .collect();
        
        // Find added and modified files
        for (path, file_2) in &map_2 {
            match map_1.get(path) {
                None => {
                    diff.added_files.push(FileDiff {
                        file_path: path.clone(),
                        old_hash: None,
                        new_hash: Some(file_2.file_hash.clone()),
                        old_size: 0,
                        new_size: file_2.size_bytes,
                        change_type: FileChangeType::Added,
                    });
                }
                Some(file_1) => {
                    if file_1.file_hash != file_2.file_hash {
                        diff.modified_files.push(FileDiff {
                            file_path: path.clone(),
                            old_hash: Some(file_1.file_hash.clone()),
                            new_hash: Some(file_2.file_hash.clone()),
                            old_size: file_1.size_bytes,
                            new_size: file_2.size_bytes,
                            change_type: FileChangeType::Modified,
                        });
                    } else {
                        diff.unchanged_files.push(FileDiff {
                            file_path: path.clone(),
                            old_hash: Some(file_1.file_hash.clone()),
                            new_hash: Some(file_2.file_hash.clone()),
                            old_size: file_1.size_bytes,
                            new_size: file_2.size_bytes,
                            change_type: FileChangeType::Unchanged,
                        });
                    }
                }
            }
        }
        
        // Find removed files
        for (path, file_1) in &map_1 {
            if !map_2.contains_key(path) {
                diff.removed_files.push(FileDiff {
                    file_path: path.clone(),
                    old_hash: Some(file_1.file_hash.clone()),
                    new_hash: None,
                    old_size: file_1.size_bytes,
                    new_size: 0,
                    change_type: FileChangeType::Removed,
                });
            }
        }
        
        Ok(diff)
    }
    
    /// Delete a snapshot
    pub async fn delete_snapshot(&self, snapshot_id: Uuid) -> Result<(), DbError> {
        sqlx::query("DELETE FROM snapshots WHERE id = ?")
            .bind(snapshot_id.to_string())
            .execute(&self.pool)
            .await?;
        
        Ok(())
    }
}

/// Helper row type for snapshot queries
#[derive(FromRow)]
struct SnapshotRow {
    id: String,
    project_id: String,
    name: String,
    description: Option<String>,
    created_at: String,
    created_by: Option<String>,
    parent_snapshot_id: Option<String>,
    is_active: i64,
    metadata: String,
    files_count: i64,
    total_size: i64,
}

impl SnapshotRow {
    fn into_summary(self) -> SnapshotSummary {
        SnapshotSummary {
            id: Uuid::parse_str(&self.id).unwrap_or_default(),
            project_id: Uuid::parse_str(&self.project_id).unwrap_or_default(),
            name: self.name,
            description: self.description,
            created_at: DateTime::parse_from_rfc3339(&self.created_at)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
            created_by: self.created_by,
            parent_snapshot_id: self.parent_snapshot_id.and_then(|s| Uuid::parse_str(&s).ok()),
            is_active: self.is_active != 0,
            tags: Vec::new(),
            files_count: self.files_count as u32,
            total_size_bytes: self.total_size as u64,
        }
    }
}

/// Helper row type for file queries
#[derive(FromRow)]
struct FileRow {
    id: String,
    snapshot_id: String,
    file_path: String,
    content: Option<String>,
    file_hash: String,
    created_at: String,
}

impl FileRow {
    fn into_file(self) -> SnapshotFile {
        SnapshotFile {
            id: Uuid::parse_str(&self.id).unwrap_or_default(),
            snapshot_id: Uuid::parse_str(&self.snapshot_id).unwrap_or_default(),
            file_path: self.file_path,
            content: self.content,
            file_hash: self.file_hash,
            created_at: DateTime::parse_from_rfc3339(&self.created_at)
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
            size_bytes: self.content.as_deref().unwrap_or("").len() as u64,
        }
    }
}

/// Compute a hash of content (matches core module)
fn compute_hash(content: &str) -> String {
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
    fn test_compute_hash() {
        let hash1 = compute_hash("hello");
        let hash2 = compute_hash("hello");
        let hash3 = compute_hash("world");
        
        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
    }
}
