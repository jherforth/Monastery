# Key Technical Decisions

## Language & Runtime
- Rust as the primary language for the core harness (performance, safety, small binaries, excellent for homelab/low-resource environments).
- Python as a secondary microservice layer for complex agentic logic, tool calling, and RAG (where the AI ecosystem depth is unmatched).
- Frontend: Lightweight Rust-based web framework (Leptos or Dioxus) compiling to WASM. Avoid Electron; Tauri is available as a desktop option if needed.
- No heavy dependencies that bloat the container or increase idle resource usage.

## LLM Integration & Decoupling
- The harness is **completely decoupled** from LLM serving. It never bundles or runs LLMs itself.
- Connects exclusively via OpenAI-compatible HTTP endpoints (Ollama, vLLM, llama.cpp server, OpenAI, Groq, etc.).
- Unified Rust client (`async-openai` or equivalent with custom base URL support) for seamless switching between local and frontier models.
- Configuration UI for managing multiple LLM endpoints (URL, API keys if required, model lists, favorites).
- Built-in proxy/forwarder in the Rust backend for consistent streaming, logging, retries, and fallback chaining (local first → frontier).
- Auto-discovery support (mDNS/Avahi for common services like Ollama on the LAN).
- Python agent services use the same unified client or direct HTTP calls.

## Model & Resource Awareness
- Hardware detection (CPU cores, RAM, GPU availability) to inform LLM prompts and quantization recommendations.
- Context window management and automatic prompt optimization based on detected resources.
- No auto-quantization inside the harness (defer to the user's LLM server).

## Storage & Persistence
- SQLite as primary database (lightweight, embedded, easy to backup).
- Optional LiteFS or similar for multi-node/high-availability setups.
- Project files stored on the host filesystem (volume-mounted in Docker) for easy Git integration and external access.
- Browser FS sync for the web interface.

## Code Execution Sandbox
- Strict isolation for running LLM-generated code.
- Primary: Docker-based execution (user-provided Docker socket or dedicated sandbox container).
- Secondary: Wasmtime / WASM for browser-safe execution where feasible.
- Seccomp, namespaces, and resource limits enforced.

## Self-Host Focus
- All generated app templates are Docker-first and homelab-friendly.
- Self-Hosting Wizard generates `docker-compose.yml`, `.env`, Coolify/Dokploy configs, Proxmox import scripts, etc.
- Integration with Coolify APIs where available; rich fallback to copy-paste scripts.
- Network-aware templates that show how to connect the harness to separate LLM containers on the same Docker network or LAN.

## Container & Deployment Strategy
- Single primary `docker-compose.yml` for the harness (Rust binary + optional Python sidecar).
- Designed to run as a standalone service alongside the user's existing LLM containers (e.g., Ollama, vLLM).
- Full ARM64 support for Jetson, mini PCs, and Proxmox.
- Environment variables and UI config for easy networking (e.g., `LLM_BASE_URL=http://ollama:11434`).
- Wizard includes examples for common side-by-side setups (harness + Ollama + PocketBase, etc.).

## Security & Operations
- Minimal outbound connectivity by default.
- Careful handling of SSH keys / server credentials in the wizard (user consent, encrypted storage).
- Comprehensive logging and health monitoring for LLM connections.
- Sandboxed operations for all agent tools.

## Extensibility
- Plugin system via WASM modules or Python extensions.
- Easy addition of new homelab integrations (Proxmox, MQTT, Meshtastic, etc.).

## Git Forge Integration
- **Multi-Forge Support**: First-class integrations with GitHub, GitLab, and Forgejo (including self-hosted instances).
- **Forgejo Self-Hosted Priority**: Native support for local/self-hosted Forgejo deployments — users point the harness at their own Forgejo instance URL. No cloud dependency required.
- **Authentication**: Personal Access Tokens (PAT) for each forge, stored encrypted in the local SQLite database. Tokens are scoped per-repo and never transmitted outside the user's network.
- **Operations**:
  - Clone existing repos into new Monastery projects
  - Push AI-generated projects to new or existing repos
  - Pull latest changes from connected remotes
  - View git status (branch, dirty files, ahead/behind) inline
  - Create repos directly from Monastery on the target forge
- **Guided Setup Wizard**: In-app step-by-step guide for generating tokens and connecting each forge type, with screenshots and copy-paste instructions.
- **Offline Resilient**: All local git operations work without a forge connection. Sync is explicit and user-initiated.
- **Architecture**: Uses the system `git` CLI for local operations (no heavy libgit2 dependency) and `reqwest` HTTP calls for forge REST APIs. Tokens never leave the harness container.

These decisions prioritize long-term maintainability, low resource usage, and flexibility for homelab users while keeping the harness lightweight and focused.
