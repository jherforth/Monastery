//! HomeLab AI Harness API Server

mod handlers;
mod db;
mod middleware;
mod snapshot_service;
mod cloudflare;
mod deploy_manifest;

use axum::{Router, routing::get, routing::post, routing::patch, routing::delete};
use tower_http::{cors::{CorsLayer, Any}, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use std::sync::Arc;

use harness_core::HarnessConfig;
use snapshot_service::SnapshotService;

/// Application state shared across handlers
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<HarnessConfig>,
    pub db: Arc<sqlx::SqlitePool>,
    pub snapshot_service: Arc<SnapshotService>,
    /// Serializes Cloudflare tunnel-config read-modify-write cycles across concurrent deploys
    /// (the ingress list is replaced wholesale; parallel writers would drop each other's rules).
    pub cloudflare_config_lock: Arc<tokio::sync::Mutex<()>>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "harness=info,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
    
    tracing::info!("Starting HomeLab AI Harness");
    
    // Load configuration
    let config = HarnessConfig::load()?;
    tracing::info!("Configuration loaded - port: {}, data_dir: {:?}", config.port, config.data_dir);
    
    // Create data directory if it doesn't exist
    tokio::fs::create_dir_all(&config.data_dir).await?;
    
    // Initialize database - ensure parent directory exists
    if let Some(parent) = config.database_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let db = db::init_db(&config.database_path).await?;
    tracing::info!("Database initialized at {:?}", config.database_path);
    
    // Initialize snapshot service
    let snapshot_service = SnapshotService::new(db.clone());
    tracing::info!("Snapshot service initialized");
    
    // Create application state
    let state = AppState {
        config: Arc::new(config),
        db: Arc::new(db),
        snapshot_service: Arc::new(snapshot_service),
        cloudflare_config_lock: Arc::new(tokio::sync::Mutex::new(())),
    };
    
    // Configure CORS for web UI
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    
    // Build router
    let app = Router::new()
        .route("/api/health", get(handlers::health_check))
        .route("/api/models", get(handlers::list_models))
        .route("/api/models/:id/chat", post(handlers::chat_stream))
        .route("/api/endpoints", get(handlers::list_endpoints))
        .route("/api/endpoints", post(handlers::add_endpoint))
        .route("/api/endpoints/:id", delete(handlers::delete_endpoint))
        .route("/api/endpoints/:id/test", post(handlers::test_endpoint))
        .route("/api/projects", get(handlers::list_projects))
        .route("/api/projects", post(handlers::create_project))
        .route("/api/projects/:id", get(handlers::get_project).delete(handlers::delete_project))
        .route("/api/projects/:id/files", get(handlers::list_project_files))
        .route("/api/projects/:id/files/read", get(handlers::read_project_file))
        .route("/api/projects/:id/files/read-all", get(handlers::read_all_project_files))
        .route("/api/projects/:id/files/write", post(handlers::write_project_file))
        .route("/api/projects/:id/files/edit", post(handlers::edit_project_file))
        .route("/api/projects/:id/files", delete(handlers::delete_project_file))
        .route("/api/projects/:id/files/dir", post(handlers::create_project_directory))
        .route("/api/projects/:id/files/dir", delete(handlers::delete_project_directory))
        .route("/api/projects/:id/files/upload", post(handlers::upload_project_file))
        .route("/api/projects/:id/files/move", post(handlers::move_project_file))
        .route("/api/projects/:id/shell", post(handlers::project_shell))
        .route("/api/projects/:id/search", get(handlers::search_project))
        // Staged coding workflow — local task store (.monastery/tasks)
        .route("/api/projects/:id/tasks", get(handlers::list_tasks))
        .route("/api/projects/:id/tasks", post(handlers::create_task))
        .route("/api/projects/:id/tasks/:task_id", get(handlers::get_task))
        .route("/api/projects/:id/tasks/:task_id", patch(handlers::update_task))
        .route("/api/projects/:id/tasks/:task_id/verify", post(handlers::verify_task))
        .route("/api/projects/:id/preview/*path", get(handlers::project_preview))
        // Session routes
        .route("/api/projects/:project_id/sessions", get(handlers::list_sessions))
        .route("/api/projects/:project_id/sessions", post(handlers::create_session))
        .route("/api/projects/:project_id/sessions/:session_id", get(handlers::get_session))
        .route("/api/projects/:project_id/sessions/:session_id", patch(handlers::update_session))
        .route("/api/projects/:project_id/sessions/:session_id", delete(handlers::delete_session))
        .route("/api/projects/:project_id/sessions/:session_id/messages", post(handlers::add_session_message))
        .route("/api/discovery", get(handlers::discover_services))
        // Snapshot routes
        .route("/api/projects/:project_id/snapshots", get(handlers::list_snapshots))
        .route("/api/projects/:project_id/snapshots", post(handlers::create_snapshot))
        .route("/api/projects/:project_id/snapshots/checkpoint", post(handlers::create_checkpoint_snapshot))
        .route("/api/projects/:project_id/snapshots/:snapshot_id", get(handlers::get_snapshot))
        .route("/api/projects/:project_id/snapshots/:snapshot_id", delete(handlers::delete_snapshot))
        .route("/api/projects/:project_id/snapshots/:snapshot_id/restore", post(handlers::restore_snapshot))
        .route("/api/projects/:project_id/snapshots/:snapshot_id/diff", get(handlers::diff_snapshots))
        // Git forge routes
        .route("/api/git/connections", get(handlers::list_git_connections))
        .route("/api/git/connections", post(handlers::connect_git_forge))
        .route("/api/git/connections/:id", delete(handlers::delete_git_connection))
        .route("/api/git/connections/:id/test", post(handlers::test_git_connection))
        .route("/api/git/connections/:id/repos", get(handlers::list_git_repos))
        .route("/api/git/connections/:id/branches", get(handlers::list_git_branches))
        .route("/api/git/status", get(handlers::get_git_status))
        .route("/api/git/commit-push", post(handlers::git_commit_push))
        .route("/api/git/pull", post(handlers::git_pull))
        .route("/api/git/push", post(handlers::git_push))
        .route("/api/git/clone", post(handlers::git_clone))
        // Hosting service routes (Self-Host Wizard)
        .route("/api/hosting/connections", get(handlers::list_hosting_connections))
        .route("/api/hosting/connections", post(handlers::connect_hosting_service))
        .route("/api/hosting/connections/:id", delete(handlers::delete_hosting_connection))
        .route("/api/hosting/connections/:id/test", post(handlers::test_hosting_connection))
        .route("/api/hosting/connections/:id/servers", get(handlers::list_hosting_servers))
        .route("/api/hosting/connections/:id/deployment-log", get(handlers::get_deployment_log))
        .route("/api/hosting/deploy", post(handlers::deploy_to_hosting))
        .route("/api/hosting/preview", post(handlers::preview_deploy))
        // Agent routes
        .route("/api/agents/run", post(handlers::run_agent))
        // Hermes agent routes
        .route("/api/hermes/connections", get(handlers::list_hermes_connections))
        .route("/api/hermes/connections", post(handlers::create_hermes_connection))
        .route("/api/hermes/connections/:id", delete(handlers::delete_hermes_connection))
        .route("/api/hermes/connections/:id/test", post(handlers::test_hermes_connection))
        .route("/api/hermes/connections/:id/default", post(handlers::set_default_hermes_connection))
        .route("/api/hermes/run", post(handlers::hermes_agent_run))
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    // Get bind address from config (before moving state into router)
    let port = state.config.port;
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("Listening on {}", addr);

    let app = app.with_state(state);
    
    // Start server
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    
    Ok(())
}
