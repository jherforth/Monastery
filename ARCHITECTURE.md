# Architecture

Monastery is a self-hosted tool for building websites and simple web apps by chatting with an
LLM: describe it, watch it appear in a live preview, tweak it, and ship it to your homelab.
Where it's heading is in [docs/SIMPLIFICATION_PLAN.md](docs/SIMPLIFICATION_PLAN.md).

## Core principles
- **Decoupled LLM layer**: Monastery never bundles or serves models. It talks to any
  OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp, OpenAI, DeepSeek, Groq, …).
- **Self-host first**: one container, SQLite, project files on a volume — no cloud dependency.
- **One way to do each thing**: one chat with two modes (Build / Discuss), one undo (snapshots),
  one ship flow.

## Components

```
Browser (React UI)
   │  HTTP + SSE
   ▼
nginx :3000 ──► serves the built UI, proxies /api ──► harness (Rust/Axum) :8080
                                                        │
                       ┌────────────────────────────────┼─────────────────────────┐
                       ▼                                ▼                         ▼
                SQLite (data/harness.db)      project files (data/<name>/)   LLM endpoints,
                endpoints, projects,          plain files + their own git    git forges,
                sessions, snapshots,          repo; previews served from     Coolify / Dokploy,
                connections, deployments      here as static files           Cloudflare, Pocketbase
```

| Part | Where | What it does |
|---|---|---|
| Web UI | `packages/web-ui/` | React + TypeScript + Vite + Tailwind, Monaco editor. Chat, live preview, code editor (toggle), file tree, History & Ship drawer, Settings |
| Chat engine | `packages/web-ui/src/hooks/useChatOrchestrator.ts` | Builds the system context, streams the reply, applies path-tagged code blocks to disk (snapshot first), auto-continues capped, runs `@read`/`@search` rounds, recovers failed edits |
| API server | `crates/harness-api/` | Axum routes (`src/main.rs`), handlers (`src/handlers.rs`), SQLite (`src/db.rs`), snapshots, deploy manifest, Cloudflare routing |
| Core library | `crates/harness-core/` | OpenAI-compatible LLM client, config, mDNS discovery, snapshot model, git CLI wrapper |
| Container | `docker/` | Multi-stage build → `nginx` runtime with the Rust binary (`entrypoint.sh` starts both) |

## Request flow (one chat turn)
1. The UI builds a system message: Build or Discuss rules, active skills, the file tree, and file
   contents (the whole project if small, otherwise the active file plus a working set).
2. `POST /api/models/:id/chat` streams the completion back as SSE (`content`, `reasoning`,
   `usage`, `finish_reason` events).
3. In Build mode, path-tagged code blocks are applied after a safety snapshot: whole-file writes
   via `/files/write`, SEARCH/REPLACE hunks via `/files/edit`. Discuss replies are never applied.
4. The preview iframe (`/api/projects/:id/preview/index.html`) reloads when files change.
5. Shell blocks are never run automatically — the user can click **Run**, which calls
   `/api/projects/:id/shell` (no shell, allowlisted programs, project-relative arguments only).

## Shipping
- **History**: a snapshot is taken before every AI edit, pull and restore; any snapshot can be
  restored from the chat ("Abandon these changes") or the History & Ship drawer.
- **Deploy**: the Self-Host Wizard deploys to Coolify (clone-at-build) or Dokploy, optionally
  wiring a Cloudflare tunnel and a shared Pocketbase. See [docs/COOLIFY_DEPLOYMENT.md](docs/COOLIFY_DEPLOYMENT.md).
- **Git** (advanced): each project is its own repo; push to GitHub/GitLab/Forgejo/Gitea, pull with
  a safe rebase. External agents can collaborate through the repo — [docs/EXTERNAL_AGENTS.md](docs/EXTERNAL_AGENTS.md).
