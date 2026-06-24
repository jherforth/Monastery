# Agents — Architecture & Implementation

## Overview

Monastery's agent system dispatches specialized work (review, refactor, test, deploy) to an external **Hermes** agent framework. Hermes runs the agent loop, manages tools, sub-agents, and model calls. Monastery provides the project context and file surface — the UI is a thin dispatch layer with role labels for UX, but **all execution happens in Hermes**.

**Status: Phase 4 complete.** Built-in agent prompts have been stripped. All agent runs now proxy through Hermes's REST API (`POST /v1/chat/completions`). Connect your Hermes instance in **Settings → Hermes Agent**.

### Integration model (important)

Monastery talks to Hermes as an **OpenAI-compatible chat endpoint**: it sends your prompt **plus the project's file tree and contents** as messages, Hermes replies (streamed), and Monastery **writes back any code blocks Hermes returns** (in the ` ```language:path/to/file ` format) to your project on disk. Hermes operating its **own** filesystem tools directly on the project is **not** wired up yet — file changes happen via Monastery applying the returned code. Agent actions and the chat "Agent mode" toggle share one code path (`handleSendMessage` in `App.tsx`), so both carry project context and apply edits identically.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                    Monastery UI                           │
│  Chat quick-actions / Editor toolbar / @-mentions        │
└──────────────────────┬────────────────────────────────────┘
                       │ POST /api/hermes/run
                       ▼
┌──────────────────────────────────────────────────────────┐
│                  Monastery Backend (Rust)                 │
│  Looks up default Hermes connection from SQLite          │
│  Proxies task → Hermes REST API with Bearer auth         │
│  Passes SSE stream through to frontend                   │
└──────────────────────┬────────────────────────────────────┘
                       │ POST /v1/chat/completions
                       ▼
┌──────────────────────────────────────────────────────────┐
│                     Hermes Agent                         │
│  • Agent loop (tools, sub-agents, memory)                │
│  • Model/provider routing                                │
│  • Streaming response (SSE)                              │
└──────────────────────────────────────────────────────────┘
```

> Note: Hermes receives the project as **message context** (files in the prompt) and returns code
> blocks that Monastery applies. Direct Hermes-native filesystem access to the project mount is a
> future enhancement, not the current behavior.

**How it works under the hood:**

```
User clicks "🔍 Review" (or types in chat with Agent mode on)
  → handleSendMessage builds messages = [system: project file tree + contents, ...history, user: role-prefixed task]
  → POST /api/hermes/run { messages, model, project_path }   (routes to Hermes when connected)
  → Backend loads default Hermes connection from hermes_connections table
  → Proxies to Hermes POST /v1/chat/completions with Bearer auth
  → Hermes SSE stream is parsed (content / reasoning / finish_reason) and passed to the UI
  → Frontend renders the live-streamed reply AND writes any ```lang:path code blocks to the project
```

---

## Agent Roles (UI Labels)

Monastery keeps agent role profiles for UI display only. System prompts live in Hermes, not Monastery:

| Agent | Role | Typical Task |
|---|---|---|
| 🏗️ **Architect** | System Designer | Architecture design, trade-off analysis, project structure |
| 💻 **Coder** | Implementation | Write/edit code following project patterns |
| 🔍 **Reviewer** | Code Review | Bugs, security, performance, anti-patterns |
| 🧪 **Tester** | Quality Assurance | Unit/integration/edge case tests |
| 📝 **Documenter** | Technical Writer | README, API docs, JSDoc, troubleshooting guides |
| 🚀 **Deployer** | DevOps / Deployment | Dockerfile generation, hosting platform configuration |

---

## Setup: Connecting Hermes

1. Ensure Hermes is running with its REST API enabled (default port 8642).
2. Open **Settings → Hermes Agent**.
3. Enter a name, Hermes base URL (`http://localhost:8642`), and API key.
4. Click **Connect Hermes**.
5. Click the **connection test** icon to verify the link.
6. The first connection is automatically set as default. Use the ★ button to change defaults.

In Docker, use `http://host.docker.internal:8642` to reach a host-running Hermes from the Monastery container.

---

## Invocation Methods

### 1. Agent role selector (above the chat input)

The **Agent roles** row above the chat input lets you **select one or more roles** that act as a
*lens* over your next messages. Clicking a role **toggles it active** (highlighted); it does **not**
fire a canned prompt. You then type your real request and send — the selected role(s) are injected
**silently** as a system instruction along with your project context, and the reply shows the
**"via Hermes"** badge. The active role(s) persist (and show as chips by the input) until you remove
them or **Clear**.

| Role | Agent | Lens it applies |
|---|---|---|
| 🔍 Review | Reviewer | Bugs, security, performance, anti-patterns |
| 🏗️ Plan | Architect | Architecture, patterns, project structure |
| 🧪 Test | Tester | Unit/integration/edge-case tests |
| 📝 Docs | Documenter | README, API docs, inline comments |
| 💻 Implement | Coder | Clean, secure implementation |
| 🚀 Deploy | Deployer | Deploy config, Dockerfile, env checks |

- **Multi-select is capped** (default **2**, the `MAX_ACTIVE_ROLES` constant in `App.tsx`) — when two
  are active the rest are disabled until you remove one. This keeps the model focused.
- **Roles need no external setup.** They are Monastery-side prompt snippets in `useAgents.ts`
  (`AGENT_PROFILES`) — **not** Hermes entities, no kanban, no DB. A bare Hermes + LLM connection is
  all that's required; selecting a role just prepends an instruction to the request.
- When exactly one role is active, the input placeholder shows that role's suggested task as a hint.

### 2. Editor Toolbar Buttons

In the code editor toolbar, beside the file path:

| Button | Agent | What It Sends |
|---|---|---|
| **Explain** | Reviewer | Current file content + "Explain this code in detail" |
| **Refactor** | Coder | Current file content + "Refactor for better patterns, readability, and performance" |
| **Add Tests** | Tester | Current file content + "Write comprehensive unit and integration tests" |

Buttons are disabled when no file is open in the editor. Prompt templates live in `useAgents.ts`'s `editorPrompts` map — easy to customize without touching UI components.

### 3. Chat Input + "Agent mode" toggle

When a Hermes connection exists, a small **Agent mode** toggle appears above the chat input. With
it **on**, your normal chat messages route to Hermes (instead of the local LLM). Selecting an
**agent role** also routes your messages to Hermes when connected (independent of the toggle); if no
Hermes connection is configured, messages fall back to the local LLM. Assistant messages answered by
Hermes show a small **"via Hermes"** badge, and your sent message shows a chip for the role(s) it
used.

---

## Response Flow

When an agent is invoked (button or Agent-mode chat):

1. A **user message** appears in chat (agent buttons prefix the role, e.g. `🔍 Act as the Reviewer (Code Review). …`).
2. `handleSendMessage` builds the request: a system message with the **project file tree + contents**, the chat history, and the user task.
3. A **placeholder assistant message** is created and updated live as Hermes streams (tagged **via Hermes**).
4. The backend proxies to Hermes `POST /v1/chat/completions` with Bearer auth and re-emits the SSE.
5. On completion, any ` ```lang:path ` code blocks are **written to the project files**, and the reply is saved to the active session. Use **Commit & Push** to persist to your repo.

---

## How to test Hermes (end to end)

1. **Run Hermes** with its REST API enabled (default port `8642`). Confirm it answers — a quick chat to it should reply (e.g. "operational").
2. **Connect it:** Settings → **Hermes Agent** → add a connection (name, base URL `http://localhost:8642` — or `http://host.docker.internal:8642` from the Monastery container — and API key) → **test** → it's set as default automatically.
3. **Pick a project:** use the **project menu** in the top bar (next to "Monastery") to switch projects or **+ New Project** to start a fresh one.
4. **Engage an agent:** click an agent button (e.g. 💻 Implement) *or* turn on **Agent mode** and send a chat message like *"Build a simple landing page in index.html."*
5. **Watch it work:** the reply streams with a **via Hermes** badge; any returned code blocks appear as files in the file tree. Open them to verify, then **Commit & Push**.

If an agent button does nothing, check that a project is selected (you'll get a "select or create a project first" notice) and that the Hermes connection tests green.

---

## Projects: the unit of work

A **project** is the workspace: its own directory (`data/<name>`), its own git repo, its own chat
sessions, and its own files. Switching the active project (top-bar **project menu**) reloads all of
that. The connected git repo and chat sessions belong to whichever project is active — starting a
**new chat session** is just a new conversation *within* the same project, not a new workspace. Use
**+ New Project** to create an empty project, or the git **clone** flow to start one from a repo.

---

## External Agent Frameworks

| Framework | Description | Status |
|---|---|---|
| 🤖 **Hermes** | Local AI agent runner — REST API for task dispatch | ✅ Integrated |
| 🦞 **Open Claw** | Multi-agent orchestration — WebSocket JSON-RPC protocol | 🔜 Planned |

External agents follow the same **Connect → Validate → Dispatch** pattern as Hosting Services. Each framework gets a tab in Settings with connection CRUD, a test button, and a default-selector.

---

## Implementation Status

| Phase | What | Status |
|---|---|---|
| **Phase 1** | Agents tab with 6 role definitions + external placeholders | ✅ Complete |
| **Phase 2** | Backend `POST /api/agents/run` — spawns sub-LLM call with agent system prompt + project context | ✅ Complete (legacy — kept for backward compat) |
| **Phase 3** | Chat UI: quick-action buttons, live-streamed agent responses, editor toolbar integration | ✅ Complete |
| **Phase 4** | Hermes integration: `POST /api/hermes/run` proxies to Hermes REST API, Settings tab for connections, stripped built-in agent prompts | ✅ Complete |
| **Phase 5** | Open Claw integration via WebSocket JSON-RPC | 🔜 Planned |

---

## File Map

### Frontend
| File | Purpose |
|---|---|
| `packages/web-ui/src/hooks/useAgents.ts` | Agent role profiles, quick-action config, `editorPrompts` map (execution is unified through `handleSendMessage`) |
| `packages/web-ui/src/hooks/useHermesAgent.ts` | SWR-based hook for Hermes connection CRUD (list/create/delete/test/set-default) |
| `packages/web-ui/src/components/ChatPane.tsx` | Quick-action buttons + Agent-mode toggle above chat input; "via Hermes" badge on assistant messages |
| `packages/web-ui/src/components/SettingsModal.tsx` | Hermes tab — add/test/delete connections, set default, connection status |
| `packages/web-ui/src/components/TopBar.tsx` | Project menu (switch projects) + **New Project** modal (`POST /api/projects`) |
| `packages/web-ui/src/App.tsx` | `handleSendMessage` (builds context, routes to Hermes via `preferHermes`/Agent mode, applies code blocks); `triggerAgent()` delegates agent buttons to it |

### Backend
| File | Purpose |
|---|---|
| `crates/harness-api/src/handlers.rs` | Hermes handlers: `list_hermes_connections`, `create_hermes_connection`, `delete_hermes_connection`, `test_hermes_connection`, `set_default_hermes_connection`, `hermes_agent_run` (SSE proxy to Hermes `/v1/chat/completions`). Legacy `run_agent` still present for backward compat. |
| `crates/harness-api/src/main.rs` | Routes: `GET/POST /api/hermes/connections`, `DELETE /api/hermes/connections/:id`, `POST /api/hermes/connections/:id/test`, `POST /api/hermes/connections/:id/default`, `POST /api/hermes/run` |
| `crates/harness-api/src/db.rs` | `hermes_connections` table (id, name, base_url, api_key, is_default, created_at, last_used_at) |

