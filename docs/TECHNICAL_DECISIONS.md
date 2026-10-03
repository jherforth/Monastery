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
Each of these exists because its absence caused a real "the model overwrote working code with
out-of-context content" incident:
- **Single source of truth**: the per-request system context (built in `buildSystemContext`,
  `packages/web-ui/src/hooks/useChatOrchestrator.ts`) carries current file contents; chat history
  has older assistant code blocks collapsed to placeholders so stale versions can't compete with it.
- **Freshness on every write path**: the in-memory file map is updated after AI writes and manual
  saves, and fully re-read after a user-run command. Any new file-write path MUST keep this invariant.
- **Junk stays out of context**: `read_files_recursive` skips lockfiles, build output (`dist/`,
  `build/`, `.next/`…), caches, `.monastery/`, logs, source maps and minified files
  (`CONTEXT_SKIP_*` in `handlers.rs`, mirroring bolt.diy's ignore list). A lockfile alone used to be
  enough to push a small site into scoped mode.
- **Scoped context for large projects** (>~96KB source, `SMALL_PROJECT_LIMIT`): file tree + active
  file + working set only. The model grows the working set itself via `@read <path>` and
  `@search <query>` (server-side ripgrep) — both auto-fed back in capped rounds. User filename
  mentions are auto-included.
- **Build vs Discuss**: Discuss mode swaps the editing rules for planning rules, and its replies are
  never applied to files (they're tagged `mode: 'discuss'`); "Build this plan" hands a plan to Build.
- **Two edit modes (the fix for "a section clobbered the whole file")**: a path-tagged code block
  containing `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` hunks is applied as a targeted in-place
  edit (`POST .../files/edit`, matched exactly then whitespace-tolerantly against the on-disk file);
  a path-tagged block WITHOUT those markers is a whole-file create/rewrite. Whole-file writes from
  the AI send `guard_partial_overwrite`, so the backend refuses to replace a non-trivial existing
  file whose new content is merely a contiguous slice of the old (the classic partial-edit mistake).
  The apply parser also has NO prose-triggered pattern (removed after it wrote explanatory fragments
  over whole files).
- **Safety checkpoint before every AI edit**: writes only fire after a server-side snapshot of the
  on-disk state (`POST .../snapshots/checkpoint`); the chat message offers one-click abandon.
- **Continuation stitching**: token-cap continuations are re-joined with duplicate fence openers
  and repeated lines stripped (`stitchContinuation`) so code-block rendering and the apply parser
  survive mid-block truncation.

## Streaming Robustness
- SSE data fields are sanitized (`sse_safe` in `harness-api/src/handlers.rs`): axum's SSE encoder
  panics on `\r`, and model output can echo CRLF from Windows-authored context files. All
  model-text emissions pass through it; text uploads are normalized to LF at the source.
- Truncated responses (`finish_reason: "length"`) auto-continue, but always **capped** (both the
  token-cap resends and the `@read`/`@search` rounds), abort-aware, and backed by a manual Continue
  button — unbounded automatic resends once burned real API credit and are deliberately impossible.
  (The on/off toggle was removed in simplification Phase 1; the caps are the safety.)

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
