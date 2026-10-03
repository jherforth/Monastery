  <img width="200" height="200" alt="logo" src="https://github.com/user-attachments/assets/2e236f99-6569-4089-b0cb-d5e2d465d0d8" />
</p>

# Monastery

**The homelab's vibe coding center for creating and deploying your projects on your infrastructure.**

A self-hosted sanctuary for AI-assisted coding. Monastery is a fully self-hosted, browser-based AI coding environment where you prompt local or frontier LLMs to generate, edit, run, debug, and deploy full applications. The harness runs as a standalone service (Docker-first) and connects to LLM backends over the network.

### This is an ever changing work in progress. 
- I'm piecing this together and implementing as I can test.

## Key Features

- **Decoupled Architecture**: Harness runs independently of LLM servers. Auto-discovery or manual config for local endpoints.
- **100% Self-Hosted**: Everything containerized, network-aware, and privacy-focused.
- **Lightweight**: Harness container <1GB RAM idle; works on low-power nodes.
- **Homelab Native**: Deploy to Coolify or Dokploy, route through Cloudflare tunnels, back apps with a shared PocketBase, and keep projects in your own git forge.
- **OpenAI-Compatible**: Works with Ollama, vLLM, llama.cpp, OpenAI, Groq, and more.
- **Build & Discuss**: Build mode writes and edits files; Discuss mode answers questions and drafts a plan without touching anything — then **Build this plan** hands it over.
- **Live Preview + Undo**: the preview reloads as files land, and every AI edit is snapshotted first so one click abandons it.

<img width="1912" height="992" alt="Screenshot 2026-06-06 144116" src="https://github.com/user-attachments/assets/39267f69-9197-4c09-9033-54003a2c08e4" />

## Quick Start

### Prerequisites

- Docker and Docker Compose
- An LLM endpoint (e.g., Ollama, vLLM, or OpenAI API key)

### 1. Clone and Configure

```bash
git clone https://github.com/jherforth/Monastery.git
cd Monastery
cp .env.example .env (optional - you can enter keys in the UI)
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
┌─────────────┐  HTTP + SSE   ┌──────────────┐
│   Browser   │ ◄──────────► │   Harness    │
│   (Web UI)  │               │   (Rust)     │
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

The full route table lives in [`crates/harness-api/src/main.rs`](crates/harness-api/src/main.rs). By area:

| Area | Routes |
|---|---|
| Health & models | `GET /api/health`, `GET /api/models`, `POST /api/models/:id/chat` (SSE stream) |
| LLM endpoints | `GET/POST /api/endpoints`, `DELETE /api/endpoints/:id`, `POST /api/endpoints/:id/test`, `GET /api/discovery` |
| Projects & files | `/api/projects`, `/api/projects/:id/files` (+ `read`, `read-all`, `write`, `edit`, `dir`, `upload`, `move`), `search`, `shell` (user-run only), `preview/*path` |
| Sessions | `/api/projects/:project_id/sessions` (+ `:session_id`, `messages`) |
| Snapshots | `/api/projects/:project_id/snapshots` (+ `checkpoint`, `restore`, `diff`) |
| Git | `/api/git/connections`, `status`, `commit-push`, `pull`, `push`, `clone` |
| Hosting | `/api/hosting/connections`, `deploy`, `preview`, `deployment-log` |

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

The built-in wizard (History & Ship → **Deploy to your homelab**) helps you:

1. Detect the project's framework and generate a Dockerfile if it has none
2. Deploy it to your Coolify or Dokploy instance, redeploying in place on later runs
3. Optionally route it through a Cloudflare tunnel and inject a shared PocketBase URL
4. Hand a failed build's log back to the chat to fix

> Deploying to Coolify? See [Coolify Deployment — Requirements & Setup](docs/COOLIFY_DEPLOYMENT.md)
> for the HTTPS-hostname/TLS prerequisites, how updates redeploy in place, and troubleshooting.

## Security

- Minimal outbound connectivity by default
- Model output never executes on its own: shell blocks only run when you click **Run**, without a shell, from an allowlist, with project-relative arguments only
- File APIs refuse paths outside the project before touching disk
- No Docker socket or other host access required

## License

AGPL v3 - see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.

<img width="1919" height="1004" alt="Screenshot 2026-06-23 150255" src="https://github.com/user-attachments/assets/ef53ed1a-eb81-47fa-b1b4-225ff985df98" />
<p align="center">

<img width="914" height="641" alt="Screenshot 2026-06-23 145831" src="https://github.com/user-attachments/assets/67ae5630-3924-4f87-acc8-9b1d88974721" />


---

**Built with intention for the homelab community**

*With a little (LOT/ALL) of help from my frields - Qwen, Claude, and DeepSeek - For AI by AI*
