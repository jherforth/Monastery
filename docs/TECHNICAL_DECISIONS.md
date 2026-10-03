# Key Technical Decisions

## Language & Runtime
- Rust (Axum) for the backend harness (performance, safety, small binaries, excellent for homelab/low-resource environments): `crates/harness-api` (HTTP + SSE server) and `crates/harness-core` (LLM client, config, discovery, snapshots, git).
- React + TypeScript + Vite + Tailwind for the web UI (`packages/web-ui`), with Monaco for editing. (The original Leptos/Dioxus-WASM plan and the Python agent sidecar were never built.)
- No agent framework in the core loop: one system prompt with Build and Discuss modes (see `docs/SIMPLIFICATION_PLAN.md`). External agents work through git — `docs/EXTERNAL_AGENTS.md`.
- No heavy dependencies that bloat the container or increase idle resource usage.

## LLM Integration & Decoupling
- The harness is **completely decoupled** from LLM serving. It never bundles or runs LLMs itself.
- Connects exclusively via OpenAI-compatible HTTP endpoints (Ollama, vLLM, llama.cpp server, OpenAI, Groq, etc.).
- Unified Rust client (`async-openai` or equivalent with custom base URL support) for seamless switching between local and frontier models.
- Configuration UI for managing multiple LLM endpoints (URL, API keys if required, model lists, favorites).
- Built-in proxy/forwarder in the Rust backend for consistent streaming, logging, retries, and fallback chaining (local first → frontier).
- Auto-discovery support (mDNS/Avahi for common services like Ollama on the LAN).

## LLM Context Pipeline (hard-won invariants)
A chat turn runs on the server: `POST /api/projects/:id/chat` (`crates/harness-api/src/chat/`).
The browser only renders the events it streams back. Each rule below exists because its absence
once caused a real "the model overwrote working code with out-of-context content" incident:
- **The disk is the single source of truth.** The system prompt is rebuilt from the files on disk
  for every model request in a turn (`chat/prompt.rs`), so it can never carry a stale copy. The only
  exception is the open file, which uses the editor's live buffer so unsaved edits are seen. The old
  browser engine kept an in-memory copy of the project and had to sync it on every write path,
  which was the root of the freshness bugs. Older assistant replies in the history have their
  `<file>`/`<edit>` bodies and code blocks collapsed to markers (`sanitize_assistant_history`).
- **Junk stays out of context**: `read_files_recursive` skips lockfiles, build output (`dist/`,
  `build/`, `.next/`…), caches, `.monastery/`, logs, source maps and minified files
  (`CONTEXT_SKIP_*` in `handlers.rs`, mirroring bolt.diy's ignore list).
- **Scoped context for large projects** (>~96KB of text, `SMALL_PROJECT_LIMIT`): the file tree plus
  the open file plus the working set. The model asks for more with `<read path="…"/>`. The server
  adds the file to the working set and continues, for at most `MAX_READ_ROUNDS` rounds; the
  browser sends the working set back on later turns. `<read>` is the only context-growth
  mechanism: `@search` and filename-mention scanning were dropped in Phase 3.
- **One strict output format — tags, not fences**: `<file path>` holds complete contents,
  `<edit path>` holds `<search>`/`<replace>` pairs, and `<read path/>` requests a file
  (`chat/parser.rs`). Fences broke on any file that itself contained a fence. Tags are parsed
  while streaming, so each file is applied, and the preview reloads, as soon as its tag closes.
  A Build reply that uses the old fenced format is applied as nothing, and the user is told so.
- **Whole files for small files, edits for large ones**: the prompt asks for a complete `<file>`
  for anything under ~200 lines and `<edit>` only for larger files. A whole-file AI write whose
  content is a contiguous slice of a non-trivial existing file is refused (`is_partial_overwrite`),
  which was the classic "a section clobbered the whole file" mistake. Search text is matched in
  five tiers: exact, then whitespace-tolerant, then a strict fuzzy match (`find_match_range`).
- **One retry for a failed edit**: hunks that match nowhere get a single focused retry. The model
  receives the file's exact current contents and the intended change, and its reply is applied.
  If that also fails, the user is asked to point at the lines. The old three-stage escalation with
  a looser matcher is gone.
- **One safety checkpoint per turn**: the first change of a turn is preceded by a snapshot of the
  on-disk project. The chat's summary message offers one-click abandon.
- **Build vs Discuss**: Discuss mode swaps the editing rules for planning rules, and the server
  never applies anything from a Discuss reply. "Build this plan" hands a plan to Build.
- **Continuation stitching**: when a reply hits the output-token limit, the server continues it,
  at most `MAX_CONTINUATIONS` times. Each continuation is held back until there's enough of it to
  repair the seam: a re-opened tag or repeated lines are dropped (`stitch_continuation`) before
  anything is shown or applied.

## Streaming Robustness
- Every event the chat endpoint streams carries a JSON payload, so there are never raw newlines or
  `\r` in an SSE data field (axum's encoder panics on `\r`, and model output can echo CRLF from
  Windows-authored files). Text uploads are normalized to LF at the source.
- Automatic continuation and `<read>` rounds are always **capped** and stop when the user hits
  Stop: dropping the request drops the turn. A manual Continue button covers the rest. Unbounded
  automatic resends once burned real API credit and are deliberately impossible.

## Model & Resource Awareness
- Hardware detection (CPU cores, RAM, GPU availability) to inform LLM prompts and quantization recommendations.
- Context window management and automatic prompt optimization based on detected resources.
- No auto-quantization inside the harness (defer to the user's LLM server).

## Storage & Persistence
- SQLite as primary database (lightweight, embedded, easy to backup).
- Optional LiteFS or similar for multi-node/high-availability setups.
- Project files stored on the host filesystem (volume-mounted in Docker) for easy Git integration and external access.
- Browser FS sync for the web interface.

## Command Execution
There is no sandbox (the old `harness-agent` sandbox crate was an unused stub and was removed), so
command execution is deliberately narrow:
- **Never automatic.** Shell blocks in model output are inert; the chat shows a **Run** button and
  only a user click executes them (`POST /api/projects/:id/shell`).
- **No shell.** Commands are split into argv and launched directly (`tokio::process`), so `;`, `|`,
  redirection and `$()`/backtick substitution are refused rather than interpreted. `a && b` runs
  sequentially, stopping at the first failure.
- **Exact-match program allowlist** (`SHELL_PROGRAMS` / `VERIFY_PROGRAMS`) — the old prefix check
  accepted `echo x; <anything>`. Arguments may not be absolute paths or climb out with `..`.
- **Timeouts** (120s shell, 600s verify) with kill-on-drop, so a dev server can't hang a request.
- The published runtime image (`nginx` + the Rust binary) has no Node/npm, so npm commands report
  "isn't installed" there. Previews are static-file based — see the runtime decision (D2) in
  `docs/SIMPLIFICATION_PLAN.md`.

## Self-Host Focus
- All generated app templates are Docker-first and homelab-friendly.
- Self-Hosting Wizard generates `docker-compose.yml`, `.env`, Coolify/Dokploy configs, Proxmox import scripts, etc.
- Integration with Coolify APIs where available; rich fallback to copy-paste scripts.
- Network-aware templates that show how to connect the harness to separate LLM containers on the same Docker network or LAN.

## Container & Deployment Strategy
- Single primary `docker-compose.yml` for the harness (one container: nginx serving the UI and proxying `/api` to the Rust binary). It needs no Docker socket.
- Designed to run as a standalone service alongside the user's existing LLM containers (e.g., Ollama, vLLM).
- Full ARM64 support for Jetson, mini PCs, and Proxmox.
- Environment variables and UI config for easy networking (e.g., `LLM_BASE_URL=http://ollama:11434`).
- Wizard includes examples for common side-by-side setups (harness + Ollama + PocketBase, etc.).
- **Image publishing**: `ghcr.io/jherforth/monastery` (`docker/Dockerfile`), built by a
  **manually-triggered** GitHub Action (`.github/workflows/docker-build.yml`) — deliberate builds
  only, tagged `:latest` + `:alpha-v0.1.<n>`; per-commit auto-builds were rejected as version-number
  churn.

## Security & Operations
- Minimal outbound connectivity by default.
- Careful handling of SSH keys / server credentials in the wizard (user consent, encrypted storage).
- Comprehensive logging and health monitoring for LLM connections.
- File APIs validate every client-supplied path before touching disk (`safe_project_path`: no
  absolute paths, no `..`, symlinks resolved against the project root) — directories are never
  created outside a project, even for a request that is then rejected.

## Extensibility
- Skills registry (`packages/web-ui/src/lib/skills.ts`): domain instructions (e.g. Pocketbase) injected only when active; a new skill needs no UI work.
- Easy addition of new homelab integrations (Proxmox, MQTT, Meshtastic, etc.) as Settings sections and ship targets.

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
