# Monastery Simplification Plan

> A plan to keep coming back to while refining the harness. Written 2026-10-02 after a full read of
> the codebase (as of `cb21640`) and a side-by-side with `boltdiyexample/` (bolt.diy).
> Tick boxes as you go. When a decision changes, update the decision log at the bottom.

---

## 1. North star

**Monastery lets someone describe a website or simple web app, watch it appear in a live preview,
tweak it by chatting, and ship it to their homelab.**

Every feature should make that loop faster, more reliable, or safer. Anything that doesn't is a
candidate for removal, hiding behind "Advanced", or a plugin later.

The loop, in order of importance:

1. **Describe** — one chat box, one mode toggle (Build / Discuss).
2. **See** — live preview that actually runs what was generated, with errors fed back.
3. **Tweak** — reliable edits that never wipe work, plus one-click undo.
4. **Ship** — one button to deploy, with git kept in the background.

---

## 2. Diagnosis: where the complexity lives

Approximate lines of code per concern (excluding SVGs, lockfiles, LICENSE):

| Concern | Backend | Frontend | Serves the core loop? |
|---|---|---|---|
| Chat engine (context, streaming, apply, recovery) | ~300 (`chat_stream`, files/edit) | **1,459** (`useChatOrchestrator.ts`) + 906 (`ChatPane.tsx`) | Yes. This is the core, but it's overbuilt |
| Deploy (Coolify, Dokploy, Cloudflare, Pocketbase, manifest) | **~2,560** (`handlers.rs` 2915–5146, `cloudflare.rs`, `deploy_manifest.rs`) | ~1,150 (wizard, hosting tab, hook) | Yes (Ship), but it's the largest single area |
| Git forge + sync | ~1,340 (`git.rs` + handlers) | ~1,070 (`GitForgeSetup.tsx` alone is 883) | Partly. Users need backup and history, not git |
| Snapshots | ~1,150 | ~210 | Yes (undo) |
| Staged workflow (tasks, spec, gates, verify) | ~235 | ~670 + orchestrator glue | **No.** Process ceremony aimed at large codebases |
| Agents (roles, Hermes, legacy `/api/agents/run`) | ~530 | ~170 + ChatPane/Settings glue + 2 docs (370 lines) | **No.** It's a second code path for the same thing |
| Dead code | `harness-agent` crate (~230, stub, unused), `xterm` deps, docker.sock mount | — | No |

### The symptoms

- **`handlers.rs` is 5,932 lines.** `deploy_to_hosting` alone is ~1,060 lines. The
  `SELECT name FROM projects WHERE id = ?` lookup is copy-pasted **22 times**, even though
  `resolve_project_dir` exists (used 8 times).
- **The chat engine lives in a React hook.** It holds the whole project (`allFileContents`) in
  browser memory and ships it with every request. It runs three nested loops (token-cap
  auto-continue, `@read`/`@search` rounds, 3-stage edit recovery) and needs refs
  (`recoverFailedEditsRef`, `continueTaskRef`, `allFileContentsRef`) to work around stale
  closures. Most of the "freshness invariant" bugs in memory notes come from keeping the map in
  sync with the disk. That class of bug goes away if the server builds context from disk.
- **The UI has too many overlapping concepts.** Users see Chat/Agent mode, 6 roles (max 2), tasks
  with 7 templates and 4 stages, context toggles, skills, auto-continue, editor quick-actions,
  sessions, snapshots, git, deploy, Hermes. Roles, stages and agents are three ways of saying
  "approach this as X".
- **Many defensive layers patch the same problem.** These include four code-block regex patterns,
  a tool-markup leak rescuer, a continuation seam-stitcher, five fuzzy-match tiers plus a "loose"
  mode, `guard_partial_overwrite`, and an LLM re-edit stage. Each one fixed a real incident, but
  together they suggest the output format itself is too loose.

### Gaps that matter more than complexity

These came out of the comparison with bolt.diy and from reading the Docker setup:

1. **The preview can't run web apps.** `project_preview` serves static files only. bolt.diy runs
   `npm install && npm run dev` in a WebContainer and previews the dev server. Monastery can't
   preview a Vite/React app at all.
2. **The shipped container has no Node.** The runtime image is `nginx:1.27-bookworm` plus
   `curl git` (`docker/Dockerfile`). In the Docker deployment that means:
   - the Verify gate's default `npm run build` can't pass;
   - model-emitted ```` ```bash npm install ```` blocks fail;
   - `@search` falls back from ripgrep (not installed) to the slow walk.
3. **Preview errors never reach the model.** bolt.diy catches uncaught exceptions and unhandled
   rejections from the preview and shows a "Fix this" alert that posts the error to chat.
   Monastery has nothing like it, so the user has to notice the error and describe it.
4. **Shell blocks run automatically and the guard is weak.** Any ```` ```bash ```` block in a
   response is executed via `sh -c` (`project_shell`). The allowlist only checks the *prefix*, so
   `echo x; <anything>` passes. That is a real risk with a confused model, and worse with a
   prompt-injected README.
5. **Junk inflates the context.** `read_files_recursive` skips `.git`, `node_modules` and
   `target`, but not `package-lock.json`, `dist/`, `build/`, `.monastery/` or other lockfiles. A
   single lockfile can push a small site over `SMALL_PROJECT_LIMIT` into scoped mode, which is
   what the whole `@read`/`@search`/working-set machinery exists for. bolt.diy ignores all of
   these (`IGNORE_PATTERNS`).
6. **Markdown files break the fence parser.** Pattern 1 is
   ```` /```(\w*)\s*:\s*(\S+)\s*\n([\s\S]*?)\n```/ ```` and stops at the *first* inner fence. A
   `README.md` containing a code example is cut off at that example. Tag-based formats like
   bolt.diy's `<boltAction>` don't have this problem.

---

## 3. Monastery vs bolt.diy

| Aspect | bolt.diy | Monastery today | Direction |
|---|---|---|---|
| Modes | **Build** / **Discuss** (two prompts) | Chat / Agent + 6 roles + task stages | **Adopt Build/Discuss**; drop roles & stages |
| Output format | One `<boltArtifact>` with `<boltAction type="file\|shell\|start">`, streamed | Fenced ```` ```lang:path ```` + 3 fallback patterns, parsed after stream ends | **One strict tag format**, streamed |
| Applying edits | Whole files only ("Only include new/modified files") | SEARCH/REPLACE + whole-file + 5-tier fuzzy + 3-stage recovery | Whole-file by default for small files; SEARCH/REPLACE only for large ones; one retry |
| Context | Whole project, or (opt-in) summary + LLM-picked ≤5 files | 96KB threshold → scoped working set + `@read`/`@search` + filename mentions | Ignore junk first; whole project for small sites; one selection mechanism for big ones |
| Where orchestration runs | Server (`api.chat.ts`): context selection, continuation | Browser hook | **Move to Rust** |
| Continuation | Server-side, `MAX_RESPONSE_SEGMENTS = 2` | Client-side, up to 5 auto + manual | Server-side, small cap, keep manual fallback |
| Runtime / preview | WebContainer: npm install, dev server, live preview | Static file server | Static-first now; real dev-server runner later |
| Error loop | Preview exceptions, build failures, deploy failures → "Ask Bolt" | Deploy-log → chat only | **Add preview error capture** |
| Starters | LLM picks from ~15 starter templates | Empty project | A few local starters |
| Design quality | A long `<design_instructions>` block in the system prompt | None | Add a concise design section |
| User edits | Sent to the model as diffs (`bolt_file_modifications`) | Active-buffer override | Fine for now |
| Locked files | Supported, injected into prompt | None | Nice-to-have later |
| Agents | **None** | Hermes integration + roles | **Remove from the core loop** (see §4) |
| Snapshots / undo | Chat-history rewind | Snapshot before every AI edit + "Abandon" | **Keep. Monastery does this better** |
| Deploy | Netlify / Vercel / GitHub | Coolify, Dokploy, Cloudflare tunnel, Pocketbase | Keep (homelab differentiator); freeze & refactor |
| Hosting model | Cloud/Electron, browser-side runtime | Self-hosted Rust + Docker | Keep (the core differentiator) |

**What Monastery already does better, and should keep:** it's self-hosted and doesn't depend on a
StackBlitz runtime, it takes a snapshot before every AI edit with an inline "Abandon", it
supports homelab deploy targets, it shows real diff cards per write, and its backend is small
and fast.

---

## 4. The agent question

**Recommendation: remove agents from the core product. Keep, at most, a "hand off to Hermes via
git" escape hatch outside the chat loop.**

Why:

- **Agents don't add a capability the chat lacks.** Hermes is called as an OpenAI-compatible
  chat endpoint with the same messages. Monastery still parses and applies the returned code
  blocks. The difference is a different model and loop, at the cost of a second routing path
  everywhere in the orchestrator (`useHermes ? … : …` appears in four places).
- **When Hermes does use its own tools, the writes are invisible.** They land in Hermes's
  `terminal.cwd`. That's why `HERMES_SHARED_WORKSPACE.md` exists (shared volumes,
  `HERMES_WRITE_SAFE_ROOT` overrides, one project at a time, `project_path` ignored) and why the
  orchestrator uses a regex heuristic to guess whether Hermes "claimed writes".
- **Roles are just prompt prefixes.** They compete with task stages for the same job, which is
  why the code needs `WORKFLOW_ROLE_IDS` filtering and a "contextual chip row".
- **bolt.diy gets good results with no agents at all.** It uses one strong system prompt, a
  Discuss mode for planning, and a tight output format. For websites and simple apps, a
  multi-agent loop adds latency, tokens and failure modes without improving the result.
- **The git bridge you validated already works without Monastery knowing about Hermes.** Hermes
  pulls, works and pushes, and you hit Pull. That is the right level of coupling: Hermes is just
  another contributor to the repo.

What to keep from the agent work:

- The **git-bridge pattern**, documented as "working with external agents".
- The **SSE pass-through code**, if a future "bring your own agent endpoint" ever comes back,
  likely as a model endpoint rather than a mode.

---

## 5. Target shape (after simplification)

```
┌ TopBar: [Project ▾]  [Model ▾]          [History]  [Ship 🚀]  [⚙] ┐
├────────────────────────────┬────────────────────────────────────────┤
│ Chat                       │ Preview (primary)  │ Code (toggle)     │
│  …messages, diff cards,    │  live, auto-reload │  file tree +      │
│  "Abandon" on each edit,   │  errors → "Fix it" │  Monaco           │
│  "Fix it" error chips      │                    │                   │
│ ┌────────────────────────┐ │                    │                   │
│ │ [Build|Discuss]  input │ │                    │                   │
│ └────────────────────────┘ │                    │                   │
└────────────────────────────┴────────────────────────────────────────┘
```

- **Concepts a user must learn:** Project, Chat (Build/Discuss), Preview, History (undo), Ship.
- **Advanced (Settings or a drawer):** Git remote and pull/push, hosting connections, Cloudflare,
  Pocketbase, model endpoints.
- **Gone:** Agent mode, roles, task drawer/templates/stages/gates, editor quick-action buttons,
  auto-continue toggle (becomes a fixed server behavior), the "+ Context" popover unless a skill
  needs it.

Backend request flow:

```
POST /api/projects/:id/chat  { message, mode: build|discuss, session_id }
  server: read project from disk (ignore list) → build prompt → stream LLM
        → streaming parser emits events as each <file>/<edit> closes
        → snapshot once, apply, emit file-written / edit-failed
        → continue on finish_reason=length (cap 2)
  SSE events: text | reasoning | file_written | file_edit_failed | usage | done
```

The frontend renders events. It no longer holds the whole project in memory for prompting.

---

## 6. Action plan

Phases are ordered so each one leaves the app working and shippable. Within a phase, items are
roughly in priority order.

### Phase 0 — Safety and quick wins (≈1–2 days, no UX change) — ✅ done 2026-10-02

- [x] **Stop auto-running shell blocks.** Render ```` ```bash ```` blocks with a "Run" button
      instead, or drop shell execution for static projects. Replace the prefix allowlist with
      tokenized `Command::new(program).args(...)` (no `sh -c`) and reject `; && | $( \``
      metacharacters. `project_shell` and `verify_task` in `crates/harness-api/src/handlers.rs`.
  - *Done:* `bash`/`sh` blocks get a **Run** button (`runShellCommand`); `parse_command_line` +
    `run_command_steps` replace `sh -c`. `a && b` chains are still allowed (run sequentially);
    arguments can't be absolute or contain `..`; 120s/600s timeouts. Unit-tested in
    `handlers.rs`.
- [x] **Add an ignore list to context reads.** Skip `*lock.json`, `*.lock`, `pnpm-lock.yaml`,
      `dist/`, `build/`, `.next/`, `coverage/`, `.cache/`, `.monastery/`, `*.log`, `.DS_Store`
      (mirror bolt.diy's `IGNORE_PATTERNS`). This is `read_files_recursive`; also apply it in the
      tree (`walk_directory`) for `node_modules`. Then check how often real projects still
      exceed `SMALL_PROJECT_LIMIT`.
  - *Done:* `CONTEXT_SKIP_DIRS/FILES/SUFFIXES` (also used by the search fallback).
  - [ ] Still open: measure how often real projects exceed `SMALL_PROJECT_LIMIT` now.
- [x] **Fix `write_project_file`'s traversal check.** It calls `create_dir_all` on the parent
      *before* checking traversal, so `../../x/y` creates directories outside the project before
      being rejected. Validate the normalized path first.
  - *Done:* `safe_project_path` (lexical check + symlink-aware ancestor check). The same bug was
    in `upload_project_file` and `move_project_file`, and `create_project_directory` skipped its
    check entirely when the parent didn't exist. All four now use it.
- [x] Switch `std::process::Command` to `tokio::process::Command` in async handlers (shell,
      verify, search). The current calls block the runtime.
- [x] **Delete dead code:** the `crates/harness-agent` crate (an unused stub), the
      `/api/agents/run` route and `run_agent`/`collect_files_for_context` (legacy), the `xterm`
      dependencies, and the `docker.sock` mount in `docker-compose.yml` (nothing in Rust uses it).
- [x] **Fix stale docs.** `ARCHITECTURE.md` and `TECHNICAL_DECISIONS.md` still describe
      Leptos/Python. The README's API list is incomplete. `AGENTS.md` references `SettingsModal`
      and `App.tsx handleSendMessage`, which no longer exist there. Mark
      `IMPLEMENTATION_SUMMARY.md`, `UI_IMPLEMENTATION.md` and `SELF_HOST_WIZARD_PLAN.md` as
      historical, or delete them.
  - *Done:* rewrote `ARCHITECTURE.md`; fixed `TECHNICAL_DECISIONS.md` and the README (API table,
    features, security, wizard); historical banners on the three docs; hidden-feature banners
    on `AGENTS.md` and `WORKFLOW.md`.

### Phase 1 — Narrow the surface (≈2–4 days) — ✅ done 2026-10-02

Goal: one way to do each thing. Hide first, delete in Phase 3 once nothing is missed.

> Hidden (unreferenced but intact, each with a `HIDDEN since … Phase 1` header):
> `TaskDrawer.tsx`, `useWorkflow.ts`, `taskTemplates.ts`, `useAgents.ts`, `useHermesAgent.ts`,
> `HermesSettingsSection.tsx`. Backend task and Hermes routes and the DB tables are untouched.

- [x] **Replace Chat/Agent mode + roles with Build / Discuss.**
  - Build uses the current system prompt.
  - Discuss is a planning prompt modeled on bolt.diy's `discuss-prompt.ts`: no code, a single
    "## The Plan" with numbered steps, plus a **"Build this plan"** button that sends the plan
    back in Build mode.
  - This replaces the Plan stage, the Architect role and the workflow nudge.
  - *Done:* `BUILD_RULES` / `DISCUSS_RULES` in `useChatOrchestrator.ts`. Discuss replies are
    tagged `mode: 'discuss'` and never applied. `@read`/`@search` still work in Discuss, since
    they're read-only. "Build this plan" also shows on reloaded `## The Plan` replies.
- [x] **Hide the task drawer, task chip, templates and workflow nudge.** Remove the `workflow`
      dependency from the orchestrator (`buildSystemContext`'s task block, `runStage`, the
      spec-reload hook, `affected_files` seeding).
- [x] **Hide Hermes:** the Settings section, the Agent toggle, the "via Hermes" routing and the
      post-run re-read heuristic. Move the git-bridge section of `HERMES_SHARED_WORKSPACE.md`
      into a short "Working with external agents" doc.
  - *Done:* `docs/EXTERNAL_AGENTS.md`. All model calls now go through a single `postChat`.
- [x] Remove the editor quick-action buttons (Explain/Refactor/Add Tests); chat covers them.
- [x] Make auto-continue a fixed behavior (no toggle) with a small cap, keeping the manual
      Continue button.
  - *Done:* the toggle is gone; caps unchanged (5 token-cap continuations, 4 context rounds).
    Edit recovery now always resumes the task, in Build mode.
- [x] Make **Preview the primary pane** and Code a toggle (already partly done). Move git
      controls into an "Advanced" section of Source & Ship, leaving **History** (snapshots) and
      **Ship** as first-class.
  - *Done:* the editor is hidden by default (store v2 migration hides it once for existing
    users). The drawer is now **History & Ship**: Ship first, History, then a collapsed
    "Advanced · Git sync" section. The top-bar chip reads "History · Ship" and keeps an amber
    ↓N when the remote is ahead, because that's the git-bridge signal for external agents.
  - *Also:* website-oriented empty-state suggestions (the old one suggested Next.js, which the
    preview can't run), and a Ctrl+K "Switch to Discuss/Build mode" command.

### Phase 2 — Make the core loop excellent (≈1–2 weeks) — ✅ done 2026-10-02

This is where most of the user-facing value is.

- [x] **Pick the runtime strategy** (see decision D2 below). Recommended: **static-first.**
  - Target HTML/CSS/vanilla JS with ES modules, plus CDN imports (Tailwind CDN, `esm.sh` /
    `unpkg` for libraries like Alpine, Preact or Chart.js).
  - The preview then works with zero build step, in the existing static server, on any homelab
    box.
  - Say so in the system prompt (bolt.diy's `<system_constraints>` pattern): "no npm, no build
    step; use CDN ES modules".
  - *Done:* the static-first runtime rules go into every prompt. Projects that already have a
    `package.json` get a note to keep their existing stack instead. The note also explains that
    the preview has no dev server.
- [x] **Add a preview error bridge.**
  - In `project_preview`, when serving HTML, inject a small `<script>` that forwards
    `window.onerror`, `unhandledrejection` and `console.error` to the parent via `postMessage`.
  - `PreviewPane` listens for these and shows a "⚠️ 1 error — Fix it" chip that posts the error
    and stack to chat, like bolt.diy's `ChatAlert`.
  - *Done:* `PREVIEW_ERROR_BRIDGE` (also reports failed resource loads) is injected after `<head>`.
    PreviewPane shows "N errors" with a details list, plus **Fix it**, which sends them in Build
    mode. The errors reset on every reload. Preview reloads are debounced to 250ms.
- [x] **Add starter templates.** Ship 4–5 small local starters:
  - blank;
  - landing page;
  - multi-page site;
  - small app with `localStorage`;
  - Pocketbase-backed CRUD (replacing the Pocketbase task template).

  New Project offers them, or a cheap LLM call picks one, as in bolt.diy's
  `selectStarterTemplate.ts`.
  - *Done:* the starters are under `crates/harness-api/starters/` and compiled in by `starters.rs`.
    `GET /api/starters` lists them, and New Project has a picker; there's no LLM pick, the picker
    is enough. The PocketBase starter gets the configured PocketBase URL filled in.
  - *Also:* project names are now validated, since they double as directory names (`../x`
    escaped the data dir), and duplicate names are refused (they shared one folder).
- [x] **Add design guidance to the Build prompt.** A concise version of bolt.diy's
      `<design_instructions>`: responsive, accessible contrast, a real palette and type scale,
      no placeholder lorem ipsum, real image URLs (or none).

### Phase 3 — Move orchestration server-side (≈1–2 weeks, the big refactor) — ✅ done 2026-10-02

Do this after Phase 1, because cutting Hermes, roles and tasks first shrinks what has to move.

- [x] **Adopt one strict output format.** Recommended: tags, which survive markdown fences inside
      files and are easy to parse while streaming:
      ```
      <file path="index.html">…complete contents…</file>
      <edit path="styles.css"><search>…</search><replace>…</replace></edit>
      <read path="src/app.js"/>
      ```
      Drop fallback patterns 2, 4 and 5, `stitchContinuation`'s fence repair, and the
      tool-markup path extraction (keep the stripper for history hygiene).
  - *Done:* `crates/harness-api/src/chat/parser.rs`, with 13 tests covering chunk splits at every
    size, fences inside files, unterminated tags, look-alike tags and the seam repair. `<edit>`
    also accepts the old `<<<<<<< SEARCH` markers. A Build reply that uses the old fenced format
    applies nothing, and the user gets a notice.
- [x] **Add a new endpoint, `POST /api/projects/:id/chat`.** The server:
  - reads files from disk (with the ignore list) and builds the system prompt;
  - streams from the LLM, parsing the tags as they stream;
  - takes **one** snapshot per turn and applies each file as its tag closes, so the preview
    updates mid-response like bolt.diy;
  - handles token-cap continuation (cap 2);
  - emits typed SSE events: `text`, `reasoning`, `file_written`, `file_edit_failed`, `usage`,
    `done`.
  - *Done:* `chat/mod.rs`, with the events documented at the top of the file. It also emits
    `snapshot`, `read`, `segment`, `status`, `notice`, `truncated` and `error`. Every payload is
    JSON. The open file's live buffer and the skill instructions come from the UI. Checked
    end-to-end against a scripted mock LLM: continuation with a re-opened tag, a read round, an
    edit retry, Discuss mode and fenced output.
- [x] **Shrink `useChatOrchestrator.ts` to a renderer** (send, render events, stop). Target: under
      300 lines. `allFileContents` stops being prompt state; the editor reads files on demand.
  - *Done:* 1,459 → 297 lines. `allFileContents` and `/files/read-all` are gone. The chat renders
    tags as compact "Wrote / Editing …" rows. User-run commands moved to `lib/commands.ts`.
- [x] **Simplify editing.** Prompt for whole-file `<file>` blocks when the file is under about
      150–200 lines (most website files), and `<edit>` only above that.
  - On a failed edit: re-read the file and retry once with the exact current contents, then
    ask the user.
  - Drop the "loose" matcher tier, and maybe tier 5 (fuzzy), once whole-file is the default.
    Keep `guard_partial_overwrite`, which is cheap and catches the worst failure.
  - *Done:* the loose tier was dropped and tier 5 kept (strict). The guard is now
    `is_partial_overwrite`. `/files/edit` was removed, since edits only come from the chat turn.
- [x] **Pick one context-growth mechanism for large projects.** Either keep `<read>`
      (model-driven, single round, server-side) **or** do bolt.diy's pre-pass (a cheap call that
      picks ≤5 files). Don't do both. Drop `@search` and filename-mention scanning unless data
      shows they're needed after the ignore list lands.
  - *Done:* `<read>`, served server-side for up to 3 rounds per turn. `@search`, mention scanning and
    the `/search` endpoint were removed.
- [x] Delete the hidden Phase 1 features for real (task store routes, `useWorkflow`,
      `TaskDrawer`, `taskTemplates`, Hermes routes/table/hook, `useAgents`).
  - *Done:* together with `/api/models/:id/chat` (superseded by the turn endpoint), `sse_safe`,
    `docs/AGENTS.md` and `docs/WORKFLOW.md`. The `hermes_connections` table is dropped on startup;
    existing `.monastery/tasks/` folders are left alone.

### Phase 4 — Backend hygiene (ongoing, alongside 2–3) — ✅ done 2026-10-02

- [x] **Split `handlers.rs`** into modules: `projects.rs`, `files.rs`, `chat.rs`, `sessions.rs`,
      `snapshots.rs`, `git.rs`, `deploy/{mod,coolify,dokploy,cloudflare,pocketbase}.rs`,
      `settings.rs`.
  - *Done:* `handlers/{error,fs,models,projects,sessions,snapshots,git,files,preview,shell,hosting}.rs`
    and `handlers/deploy/{mod,coolify,dokploy,dockerfile}.rs`. The code moved verbatim and is all
    re-exported from `handlers/mod.rs`, so routes are unchanged. Chat is its own top-level
    `chat/` module since Phase 3. Cloudflare routing already lived in `cloudflare.rs`, and
    Pocketbase is a few lines inside deploy, so neither got its own file. `settings.rs` became
    `models.rs` + `hosting.rs`.
- [x] **Add one `ProjectCtx` extractor** (id → name → canonical dir) to replace the 22
      copy-pasted lookups.
  - *Done:* `ProjectCtx` in `handlers/fs.rs`. As an extractor it reads `:id`/`:project_id`;
    `ProjectCtx::load` covers ids that arrive in a query string or body. One lookup remains:
    the extractor's own.
- [x] **Break `deploy_to_hosting` (~1,060 lines) into per-platform functions** behind a small
      trait or enum. Decide whether Dokploy stays first-class (D4).
  - *Done:* `deploy_to_hosting` resolves a `DeployContext` once and dispatches to
    `deploy/coolify.rs` or `deploy/dokploy.rs`. An enum match was enough; no trait needed.
    Dokploy keeps working but is marked maintenance-only (D4).
- [x] **Add parser tests** for the new tag format, modeled on bolt.diy's
      `message-parser.spec.ts`: streaming chunks split mid-tag, fences inside files, multiple
      files, unterminated tags. This is the most bug-prone code, and it currently has no tests.
  - *Done (in Phase 3):* 13 parser tests and 6 prompt tests. Phase 4 adds 4 edit-matcher tests.
    The suite is now 35 API tests and 3 core tests.
- [x] Add a CI job running `cargo test` and `npm run build` (the `docker-build.yml` workflow
      currently only builds the image).
  - *Done:* `.github/workflows/ci.yml` runs on pushes to main and on PRs. It publishes nothing.
    The `harness-core` snapshot test that had always failed (it expected 13 bytes for a
    12-byte string) is fixed so CI starts green.

### Phase 5 — Optional, only if wanted later

- [ ] **A real dev-server runner** for npm/Vite apps (D2 option B): a per-project
      `node:20-alpine` container started on demand, `npm install && npm run dev`, preview proxied
      through the backend, logs and errors streamed to chat. Higher cost, but it unlocks React
      apps.
- [ ] **In-browser bundling**: evaluate Sandpack (CodeSandbox's bundler, which can be
      self-hosted) as a lighter alternative to a runner container. WebContainer is what bolt.diy
      uses, but review its licensing terms before adopting it.
- [ ] Locked files (bolt.diy's `isLocked`) and user-edit diffs sent to the model
      (`bolt_file_modifications`).
- [ ] "Download as zip" export as the simplest Ship target.

---

## 7. What NOT to cut

- **The pre-edit snapshot plus inline "Abandon"** is better than bolt.diy and is the safety net
  that makes everything else tolerable.
- **Diff cards and activity rows** in chat.
- **`guard_partial_overwrite`**: tiny, and it prevents the worst outcome.
- **Self-hosted, OpenAI-compatible endpoints with a per-endpoint model list.** It's the core
  differentiator.
- **Coolify deploy, the Cloudflare tunnel and the deploy manifest.** They're validated in your
  homelab. Freeze and refactor them; don't redesign.
- **Sessions per project.**
- **Git pull/push and the safe rebase.** Keep them, but move them out of the primary UI.

---

## 8. Success measures

Use these to tell whether a change helped:

- **Time to first preview:** from "build me a landing page for a bakery" to a rendered page.
  Target: one response, no follow-ups.
- **Edit success rate:** the share of turns where every file change applied without recovery.
  Instrumented: the chat logs every applied change (`info`) and every failed edit (`warn`) under
  the `monastery::chat` target.
- **Concepts on screen** for a new user: target ≤ 6 (Project, Model, Chat mode, Preview,
  History, Ship).
- **`useChatOrchestrator.ts`** under 300 lines; **largest Rust file** under 1,000 lines.
- **Tokens per turn** for a typical site, before and after the ignore list.

---

## 9. Decision log

Record decisions here as they're made so future sessions don't re-litigate them.

| # | Decision | Options | Recommendation | Status |
|---|---|---|---|---|
| D1 | Agents in the core loop? | Keep Hermes mode + roles / Hide / Remove | **Remove from the loop**; keep the git-bridge pattern as docs | **Decided 2026-10-02**: hidden in Phase 1, delete in Phase 3 |
| D2 | Runtime for previews | A: static-first (CDN ES modules) · B: per-project Node runner container · C: in-browser bundler | **A now**, B or C later if React apps become a goal | **Decided 2026-10-02**: A (Phase 2) |
| D3 | Staged workflow (tasks/spec/gates) | Keep / Replace with Discuss mode / Remove | **Replace with Discuss + "Build this plan"** | **Decided 2026-10-02**: replaced in Phase 1, delete in Phase 3 |
| D4 | Deploy targets | Coolify + Dokploy + CF + Pocketbase / Coolify-first | **Coolify-first**, Dokploy maintenance-only | **Decided 2026-10-02** (per recommendation, Phase 4): Dokploy still works, no new features |
| D5 | Output format | Keep fences / Tags | **Tags** (`<file>`, `<edit>`, `<read>`) | **Decided 2026-10-02**: tags (Phase 3) |
| D6 | Where orchestration runs | Browser hook / Rust server | **Rust server** | **Decided 2026-10-02**: Rust server (Phase 3) |
| D7 | Edit strategy | SEARCH/REPLACE-first / Whole-file-first | **Whole-file for small files**, SEARCH/REPLACE above ~150–200 lines | **Decided 2026-10-02**: whole-file under ~200 lines (Phase 3) |

---

## Appendix: key files referenced

- Chat engine: `packages/web-ui/src/hooks/useChatOrchestrator.ts`
- Chat UI: `packages/web-ui/src/components/ChatPane.tsx`
- All handlers: `crates/harness-api/src/handlers.rs`
  - `project_shell` ~2465
  - `read_files_recursive` ~2841
  - `write_project_file` ~2081
  - `project_preview` ~2348
  - `deploy_to_hosting` ~3858
  - `run_agent` ~5159
  - `hermes_agent_run` ~5763
- Routes: `crates/harness-api/src/main.rs`
- Dead crate: `crates/harness-agent/`
- Runtime image: `docker/Dockerfile` (nginx, no Node)
- bolt.diy references:
  - prompt: `boltdiyexample/app/lib/common/prompts/new-prompt.ts`
  - discuss mode: `boltdiyexample/app/lib/common/prompts/discuss-prompt.ts`
  - server orchestration: `boltdiyexample/app/routes/api.chat.ts`
  - context selection: `boltdiyexample/app/lib/.server/llm/select-context.ts`
  - streaming parser: `boltdiyexample/app/lib/runtime/message-parser.ts` (+ `.spec.ts`)
  - action runner: `boltdiyexample/app/lib/runtime/action-runner.ts`
  - starter templates: `boltdiyexample/app/utils/selectStarterTemplate.ts`
  - preview error capture: `boltdiyexample/app/lib/webcontainer/index.ts`
  - ignore list: `boltdiyexample/app/lib/.server/llm/constants.ts`
