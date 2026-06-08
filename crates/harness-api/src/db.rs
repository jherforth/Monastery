//! Database initialization and operations

use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::path::Path;

/// Initialize the SQLite database with required tables
pub async fn init_db(database_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    // Ensure parent directory exists
    if let Some(parent) = database_path.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| sqlx::Error::Io(e))?;
    }

    // Build SQLite connection string with create-if-not-exists mode
    let db_url = format!("sqlite:{}?mode=rwc", database_path.to_str().unwrap());

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&db_url)
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
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            title TEXT NOT NULL,
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
        CREATE TABLE IF NOT EXISTS session_messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            model TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(&pool)
    .await?;
    
    // Drop legacy chat_history table if it exists (unused placeholder)
    sqlx::query("DROP TABLE IF EXISTS chat_history")
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
    
    // Git forge connections table
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS git_connections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            forge_type TEXT NOT NULL CHECK(forge_type IN ('github', 'gitlab', 'forgejo')),
            base_url TEXT NOT NULL,
            api_token TEXT NOT NULL,
            username TEXT,
            email TEXT,
            is_default INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            last_synced_at TEXT
        )
        "#,
    )
    .execute(&pool)
    .await?;
    
    // Migration: add email column if it doesn't exist (for existing DBs)
    let _ = sqlx::query("ALTER TABLE git_connections ADD COLUMN email TEXT")
        .execute(&pool)
        .await;
    
    Ok(pool)
}
