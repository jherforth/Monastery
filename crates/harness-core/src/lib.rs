//! HomeLab AI Harness - Core Library
//! 
//! Provides core functionality for LLM connectivity, model management,
//! service discovery, and snapshot-based version control.

pub mod llm;
pub mod models;
pub mod config;
pub mod discovery;
pub mod error;
pub mod snapshot;
pub mod git;

pub use error::{Error, Result};
pub use config::HarnessConfig;
pub use models::{
    ModelInfo, ModelEndpoint, EndpointConfig,
    GitForgeType, GitConnection, GitRepo, GitStatus,
    ConnectGitForgeRequest, GitPushRequest, GitCloneRequest,
};
pub use llm::LLMClient;
pub use discovery::ServiceDiscovery;
pub use git::GitService;
pub use snapshot::{
    Snapshot, SnapshotFile, SnapshotMetadata, SnapshotTrigger,
    CreateSnapshotRequest, CreateSnapshotResponse,
    RestoreSnapshotRequest, RestoreSnapshotResponse,
    SnapshotList, SnapshotSummary, SnapshotDiff, FileDiff, FileChangeType,
};
