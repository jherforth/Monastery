//! Database initialization and operations

use sqlx::{sqlite::SqlitePool, SqlitePoolOptions};
use std::path::Path;

/// Initialize the SQLite database with required tables
pub async fn init_db(database_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_path.to_str().unwrap())
        .await?;
    
    // Create tables
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS endpoints (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key TEXT,
            is_favorite INTEGER DEFAULT 0,
            is_local INTEGER DEFAULT 1,
            created_at TEXT NOT NULL
        )
        "#,
    )
    .execute(&pool)
    .await?;
    
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(&pool)
    .await?;
    
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS project_files (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            path TEXT NOT NULL,
            content TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )
        "#,
    )
    .execute(&pool)
    .await?;
    
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS chat_history (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            model TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id)
        )
        "#,
    )
    .execute(&pool)
    .await?;
    
    // Snapshots table for code versioning and rollback
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS snapshots (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT,
            parent_snapshot_id TEXT,
            is_active INTEGER DEFAULT 0,
            metadata TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id),
            FOREIGN KEY (parent_snapshot_id) REFERENCES snapshots(id)
        )
        "#,
    )
    .execute(&pool)
    .await?;
    
    // Snapshot files table - stores file content for each snapshot
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS snapshot_files (
            id TEXT PRIMARY KEY,
            snapshot_id TEXT NOT NULL,
            file_path TEXT NOT NULL,
            content TEXT,
            file_hash TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(&pool)
    .await?;
    
    // Snapshot tags for categorization
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS snapshot_tags (
            id TEXT PRIMARY KEY,
            snapshot_id TEXT NOT NULL,
            tag TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE,
            UNIQUE(snapshot_id, tag)
        )
        "#,
    )
    .execute(&pool)
    .await?;
    
    // Models cache table - stores discovered models from endpoints
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS models_cache (
            id TEXT PRIMARY KEY,
            endpoint_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            name TEXT,
            capabilities TEXT,
            discovered_at TEXT NOT NULL,
            FOREIGN KEY (endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE,
            UNIQUE(endpoint_id, model_id)
        )
        "#,
    )
    .execute(&pool)
    .await?;
    
    Ok(pool)
}
