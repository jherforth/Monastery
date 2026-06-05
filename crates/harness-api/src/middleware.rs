//! Middleware for the API server

use axum::{
    http::Request,
    middleware::Next,
    response::Response,
};
use tracing::info;

/// Log incoming requests
pub async fn log_request<B>(
    req: Request<B>,
    next: Next<B>,
) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    
    info!("Received request: {} {}", method, uri);
    
    next.run(req).await
}
