# High-Level Architecture

## Tech Stack (Rust Primary + Python Secondary — per prior discussion)
- **Frontend**: Leptos (Rust, WASM) or Dioxus — reactive UI with Monaco Editor, terminal pane, preview iframe, model selector, chat history.
- **Backend Orchestrator**: Rust (Axum) — API server, streaming LLM proxy, WebSockets/SSE, project filesystem (in-memory + persistent via SQLite or LiteFS).
- **AI Core**: Python microservices (FastAPI) for complex agents (LangGraph/CrewAI-style), RAG over project files, tool calling. Communicates via gRPC/HTTP.
- **Local Model Serving**: Ollama + custom Rust proxy (or llama.cpp bindings). Fallback to frontier APIs.
- **Code Execution Sandbox**: Rust/Wasmtime or Docker-in-Docker (isolated containers). Support for WebContainer-like browser execution where possible.
- **Persistence & State**: SQLite (main), optional LiteFS for multi-node. Project memory as structured Markdown/JSON.
- **Deployment**: Docker Compose first-class. Self-Host Wizard generates configs for Coolify, Dokploy, CapRover, or bare Proxmox.
- **Self-Hosting Wizard Module**: Detects generated stack → Templates (Next.js + PocketBase, Rust Axum + SQLite, etc.) → SSH/Ansible-light scripts or API pushes.

## Data Flow
1. User prompt → Rust orchestrator → Unified LLM client (local priority).
2. LLM response → Streaming to UI + agent loop (Python for tools/RAG).
3. Edits applied to virtual FS → Live preview/sandbox run.
4. Deploy: Wizard → docker-compose.yml + .env + install script.

## Homelab Integrations Layer
- Proxmox VM/LXC provisioning.
- Coolify/PocketBase/Appwrite templates.
- MQTT for IoT-aware apps.
- Resource monitoring (CPU/GPU/memory) to guide LLM prompts.
