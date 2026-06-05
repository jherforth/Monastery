# High-Level Architecture

## Core Principles
- **Decoupled LLM Layer**: The harness never bundles or serves LLMs itself. It connects via HTTP to any OpenAI-compatible endpoint.
- **Self-Host First**: Everything containerized, network-aware, and privacy-focused.

## Tech Stack
- **Frontend**: Leptos (Rust → WASM) or Dioxus — Monaco Editor, live preview, terminal, model selector, chat.
- **Backend Orchestrator**: Rust (Axum) — lightweight API server, streaming proxy, WebSockets, project FS.
- **AI Agent Core**: Python microservices (FastAPI, optional) for complex tool calling / RAG / agents. Callable from Rust.
- **Model Integration**:
  - Unified client supporting multiple endpoints.
  - Config UI for adding LLM servers (URL, API key if needed, model list).
  - Auto-discovery: mDNS for Ollama on LAN; fallback manual entry.
  - Built-in proxy/forwarder for consistent streaming and logging.
- **Persistence**: SQLite (or LiteFS) for projects, settings, chat history.
- **Code Sandbox**: Docker-based (isolated) or Wasmtime/WASM. Optional integration with user's Proxmox/Docker host.
- **Deployment**: Docker Compose (multi-service if Python agents used). ARM64 native. Self-Host Wizard generates full stack configs including LLM connection examples.

## Network Flow
1. User runs harness container (exposes port 3000).
2. Configures LLM endpoint(s) via UI (e.g., `http://host.docker.internal:11434` or LAN IP).
3. Prompts route through Rust proxy → chosen LLM → streaming back to browser.
4. Homelab integrations use local network (Proxmox API, MQTT broker, Coolify, etc.).

## Self-Hosting Wizard
- Detects generated app stack.
- Generates `docker-compose.yml` for the *app* + instructions for connecting the harness to user's existing LLM service.
- One-click Coolify/PocketBase/Proxmox deployment paths.
