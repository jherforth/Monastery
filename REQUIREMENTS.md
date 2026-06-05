# Functional & Non-Functional Requirements

## Must-Have Features (Core Loop)
- Multi-model support: Local (Ollama priority) + frontier via proxy. Per-prompt model selection.
- Full-stack project creation/iteration in browser (files, preview, terminal).
- Agentic capabilities: "Add auth with PocketBase", "Deploy to my Proxmox", "Optimize for low power".
- Git integration (Forgejo/self-hosted or GitHub fallback).
- File attachments/images for vision models.
- Persistent project memory/context.

## Self-Hosting Assistant (ODT Core)
- Post-generation: "Deploy Self-Hosted" button.
- Wizard: Server creds → Tailored compose + scripts → Coolify one-click or manual.
- Templates for common homelab stacks.
- Cost/ resource estimator, troubleshooting chat, backups.

## Non-Functional
- **Performance**: <2s response on Jetson with quantized models. Low idle footprint.
- **Security**: Sandboxed execution, no unnecessary outbound, SSH key handling with user consent.
- **Usability**: Extremely guided for non-experts; power-user CLI/API.
- **Extensibility**: Plugin system for new tools/models/integrations (WASM or Python).
- **Deployment**: Single `docker compose up` for full harness. ARM64 native.
- **Offline**: 95% functionality without internet (local models + cached templates).

## Stretch Goals
- Multi-node homelab orchestration (distribute agents across Proxmox nodes).
- Voice/input via local STT.
- Marketplace for community self-host templates.
