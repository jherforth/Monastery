# Monastery

**Build in silence. Deploy with purpose.**

A calm, focused, self-hosted sanctuary for AI-assisted coding. Monastery is a fully self-hosted, browser-based AI coding environment where you prompt local or frontier LLMs to generate, edit, run, debug, and deploy full applications. The harness runs as a standalone service (Docker-first) and connects to LLM backends over the network.

## Key Features

- **Decoupled Architecture**: Harness runs independently of LLM servers. Auto-discovery or manual config for local endpoints.
- **100% Self-Hosted**: Everything containerized, network-aware, and privacy-focused.
- **Lightweight**: Harness container <1GB RAM idle; works on low-power nodes.
- **Homelab Native**: Deep integrations with Proxmox, Coolify, PocketBase, MQTT, etc.
- **OpenAI-Compatible**: Works with Ollama, vLLM, llama.cpp, OpenAI, Groq, and more.

## Quick Start

### Prerequisites

- Docker and Docker Compose
- An LLM endpoint (e.g., Ollama, vLLM, or OpenAI API key)

### 1. Clone and Configure

```bash
git clone https://github.com/jherforth/Monastery.git
cd Monastery
cp .env.example .env
```

Edit `.env` to configure your LLM endpoint:

```bash
# For Ollama on same host (Linux/Mac):
LLM_BASE_URL=http://host.docker.internal:11434

# For Ollama in separate container:
LLM_BASE_URL=http://ollama:11434

# For OpenAI:
LLM_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
```

### 2. Run with Docker Compose

```bash
docker compose up -d
```

The harness will be available at `http://localhost:3000`.

### 3. Connect to Your LLM

1. Open the web UI at `http://localhost:3000`
2. Navigate to Settings → LLM Endpoints
3. Add your LLM endpoint or use auto-discovery to find Ollama on your LAN
4. Test the connection and start prompting!

## Architecture

```
┌─────────────┐     HTTP      ┌──────────────┐
│   Browser   │ ◄──────────► │   Harness    │
│   (Web UI)  │   WebSocket   │   (Rust)     │
└─────────────┘               └──────┬───────┘
                                     │
                          ┌──────────┼──────────┐
                          │          │          │
                          ▼          ▼          ▼
                   ┌──────────┐ ┌────────┐ ┌─────────┐
                   │  Ollama  │ │ vLLM   │ │ OpenAI  │
                   │ (local)  │ │(local) │ │(cloud)  │
                   └──────────┘ └────────┘ └─────────┘
```

## Tech Stack

- **Backend**: Rust (Axum) - lightweight, safe, performant
- **Frontend**: React + TypeScript with Vite - modern, responsive UI with Monaco editor
- **Database**: SQLite - embedded, easy backup
- **Sandbox**: Docker-based isolated execution
- **LLM Client**: OpenAI-compatible protocol
- **Styling**: Tailwind CSS with custom Monastery theme

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `PORT` | Server port | `3000` |
| `DATA_DIR` | Data directory path | `./data` |
| `LOG_LEVEL` | Logging level | `info` |
| `LLM_BASE_URL` | Default LLM endpoint | - |
| `DISABLE_DISCOVERY` | Disable mDNS discovery | `false` |

## API Endpoints

- `GET /api/health` - Health check
- `GET /api/models` - List available models
- `POST /api/models/:id/chat` - Stream chat completion
- `GET /api/endpoints` - List configured endpoints
- `POST /api/endpoints` - Add new endpoint
- `DELETE /api/endpoints/:id` - Remove endpoint
- `POST /api/endpoints/:id/test` - Test connectivity
- `GET /api/discovery` - Discover local services

## Development

### Build from Source

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build
cargo build --release

# Run
cargo run
```

### Run Tests

```bash
cargo test
```

## Self-Hosting Wizard

The built-in wizard helps you:

1. Generate `docker-compose.yml` for your generated apps
2. Configure network connections between services
3. Set up reverse proxies (Traefik, Nginx)
4. Deploy to Coolify, Proxmox, or Kubernetes

## Security

- Minimal outbound connectivity by default
- Sandboxed code execution
- No unnecessary permissions
- Encrypted credential storage (optional)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.

---

**Built with calm intention for the homelab community**

*"Build in silence. Deploy with purpose."*
