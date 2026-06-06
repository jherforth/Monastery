//! HomeLab AI Harness API Server

mod handlers;
mod db;
mod middleware;
mod snapshot_service;

use axum::{Router, routing::get, routing::post, routing::delete};
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
    
    // Initialize database
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
        .route("/api/projects/:id", get(handlers::get_project))
        .route("/api/discovery", get(handlers::discover_services))
        // Snapshot routes
        .route("/api/projects/:project_id/snapshots", get(handlers::list_snapshots))
        .route("/api/projects/:project_id/snapshots", post(handlers::create_snapshot))
        .route("/api/projects/:project_id/snapshots/:snapshot_id", get(handlers::get_snapshot))
        .route("/api/projects/:project_id/snapshots/:snapshot_id", delete(handlers::delete_snapshot))
        .route("/api/projects/:project_id/snapshots/:snapshot_id/restore", post(handlers::restore_snapshot))
        .route("/api/projects/:project_id/snapshots/:snapshot_id/diff", get(handlers::diff_snapshots))
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
