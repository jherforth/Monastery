//! Middleware for the API server

use axum::{
    http::Request,
    response::Response,
};
use axum::middleware::Next;
use tracing::info;

/// Log incoming requests
pub async fn log_request(
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    
    info!("Received request: {} {}", method, uri);
    
    next.run(req).await
}
