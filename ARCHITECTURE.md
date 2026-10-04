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
nginx :3091 ──► serves the built UI, proxies /api ──► harness (Rust/Axum) :8080
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
| Chat turn | `crates/harness-api/src/chat/` | One request per message: builds the prompt from disk (`prompt.rs`), streams the reply, parses `<file>`/`<edit>`/`<read>` tags as they arrive (`parser.rs`), applies changes after one snapshot, continues past the output limit, serves reads, retries a failed edit (`mod.rs`) |
| Chat UI | `packages/web-ui/src/hooks/useChatOrchestrator.ts`, `components/ChatPane.tsx` | Sends the turn and renders its events: text, file rows and diff cards, status lines, errors |
| API server | `crates/harness-api/` | Axum routes (`src/main.rs`); handlers in `src/handlers/` (one module per concern — files, git, snapshots, deploy/{coolify,dokploy}, …, with `ProjectCtx` resolving the project for each request); SQLite (`src/db.rs`), starters, deploy manifest, Cloudflare routing |
| Core library | `crates/harness-core/` | OpenAI-compatible LLM client, config, mDNS discovery, snapshot model, git CLI wrapper |
| Container | `docker/` | Multi-stage build → `nginx` runtime with the Rust binary (`entrypoint.sh` starts both) |

## Request flow (one chat turn)
1. The UI sends `POST /api/projects/:id/chat`. The body carries the message, the mode (Build or
   Discuss), the history, active skill instructions, the open file's live buffer, and the working
   set.
2. The server reads the project from disk and builds the system prompt: mode rules, static-first
   runtime rules, design guidance, skills, the file tree, and file contents (everything for a
   small project; otherwise the open file plus the working set).
3. The reply streams back as typed SSE events (`text`, `file`, `status`, `snapshot`,
   `edit_failed`, …). Each `<file>`/`<edit>` is applied as soon as its tag closes, after one
   safety snapshot for the turn. `<read>` requests add files and continue. Replies cut off at the
   output limit are continued and stitched. A failed edit gets one retry. Nothing from a Discuss
   reply is ever applied.
4. The preview iframe (`/api/projects/:id/preview/index.html`) reloads as files land. The page
   reports its runtime errors back through an injected script, and **Fix it** sends them to the
   chat.
5. Shell blocks are never run automatically — the user can click **Run**, which calls
   `/api/projects/:id/shell` (no shell, allowlisted programs, project-relative arguments only).

## Shipping
- **History**: a snapshot is taken before every AI edit, pull and restore; any snapshot can be
  restored from the chat ("Abandon these changes") or the History & Ship drawer.
- **Deploy**: the Self-Host Wizard deploys to Coolify (clone-at-build) or Dokploy, optionally
  wiring a Cloudflare tunnel and a shared Pocketbase. See [docs/COOLIFY_DEPLOYMENT.md](docs/COOLIFY_DEPLOYMENT.md).
- **Git** (advanced): each project is its own repo; push to GitHub/GitLab/Forgejo/Gitea, pull with
  a safe rebase. External agents can collaborate through the repo — [docs/EXTERNAL_AGENTS.md](docs/EXTERNAL_AGENTS.md).
