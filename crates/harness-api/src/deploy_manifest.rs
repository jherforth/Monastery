//! The committed deploy manifest — `.monastery/deploy.json` in the project directory.
//!
//! Deployment identity as code: the manifest carries a stable `deploy_id` and per-platform
//! desired state (app name, pinned host port, domain, tunnel identifiers), so a repo cloned by a
//! collaborator or opened on another Monastery instance adopts the SAME platform app instead of
//! creating a duplicate. The local `deployments` table remains a per-instance cache; this file is
//! the portable source of identity. It must never contain secrets — tunnel account/tunnel ids are
//! identifiers, not credentials.
//!
//! JSON (pretty-printed) with BTreeMap ordering: deterministic output → stable diffs and a
//! minimal git-merge conflict surface. On a conflict, keep the OLDER deploy_id.

use std::collections::BTreeMap;
use std::path::Path;

use crate::cloudflare::TunnelRef;

pub const MANIFEST_REL_PATH: &str = ".monastery/deploy.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CloudflareState {
    pub account_id: String,
    pub tunnel_id: String,
    /// The public hostname routed to this app (last configured).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
}

impl CloudflareState {
    pub fn tunnel_ref(&self) -> TunnelRef {
        TunnelRef { account_id: self.account_id.clone(), tunnel_id: self.tunnel_id.clone() }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TargetState {
    pub app_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Pinned published host port — stable across renames and Monastery instances.
    pub host_port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloudflare: Option<CloudflareState>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DeployManifest {
    pub version: u32,
    /// Stable unique id, generated once. Embedded in the platform app's description as
    /// `monastery-deploy-id:<id>` so other Monastery instances can discover + adopt the app.
    pub deploy_id: String,
    pub app_name: String,
    /// Keyed by platform type ("coolify" | "dokploy") — connection ids are instance-local,
    /// platform type is the portable dimension.
    #[serde(default)]
    pub targets: BTreeMap<String, TargetState>,
}

impl DeployManifest {
    pub fn new(app_name: &str) -> Self {
        let id = uuid::Uuid::new_v4().simple().to_string();
        Self {
            version: 1,
            deploy_id: format!("mstr-{}", &id[..8]),
            app_name: app_name.to_string(),
            targets: BTreeMap::new(),
        }
    }

    /// The marker string embedded in platform app descriptions for cross-instance discovery.
    pub fn marker(&self) -> String {
        marker(&self.deploy_id)
    }
}

pub fn marker(deploy_id: &str) -> String {
    format!("monastery-deploy-id:{}", deploy_id)
}

/// Load the manifest from a project directory. Missing file → Ok(None); unreadable/corrupt
/// content is surfaced as an error string so the deploy can report it rather than silently
/// forking a new identity.
pub fn load(project_dir: &Path) -> Result<Option<DeployManifest>, String> {
    let path = project_dir.join(MANIFEST_REL_PATH);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", MANIFEST_REL_PATH, e))?;
    let manifest: DeployManifest = serde_json::from_str(&raw)
        .map_err(|e| format!("Invalid {}: {}", MANIFEST_REL_PATH, e))?;
    Ok(Some(manifest))
}

/// Write the manifest (pretty-printed) into the project directory. Best-effort callers may
/// log-and-continue on failure — a failed manifest write must not fail a deploy.
pub fn save(project_dir: &Path, manifest: &DeployManifest) -> Result<(), String> {
    let path = project_dir.join(MANIFEST_REL_PATH);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    let body = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
    std::fs::write(&path, body + "\n")
        .map_err(|e| format!("Failed to write {}: {}", MANIFEST_REL_PATH, e))?;
    Ok(())
}
