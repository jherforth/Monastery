//! API route handlers, one module per concern. Everything is re-exported here, so routes
//! and other modules keep using `handlers::name`.

use axum::{
    extract::{Path, State, Query},
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use crate::AppState;
use harness_core::{
    CreateSnapshotRequest, RestoreSnapshotRequest, SnapshotTrigger,
};

mod error;
mod fs;
mod models;
mod projects;
mod sessions;
mod snapshots;
mod git;
mod files;
mod preview;
mod shell;
mod hosting;
mod deploy;

pub use error::*;
pub(crate) use fs::*;
pub use models::*;
pub use projects::*;
pub use sessions::*;
pub use snapshots::*;
pub use git::*;
pub use files::*;
pub use preview::*;
pub use shell::*;
pub use hosting::*;
pub use deploy::*;

#[cfg(test)]
mod tests;
