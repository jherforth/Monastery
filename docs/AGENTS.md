# Agents — Architecture & Implementation

## Overview

Monastery's agent system dispatches specialized work (review, refactor, test, deploy) to an external **Hermes** agent framework. Hermes runs the agent loop, manages tools, sub-agents, and model calls. Monastery provides the project context and file surface — the UI is a thin dispatch layer with role labels for UX, but **all execution happens in Hermes**.

**Status: Phase 4 complete.** Built-in agent prompts have been stripped. All agent runs now proxy through Hermes's REST API (`POST /v1/chat/completions`). Connect your Hermes instance in **Settings → Hermes Agent**.

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
│  • File I/O via Monastery project mounts                 │
│  • Model/provider routing                                │
│  • Streaming response (SSE)                              │
└──────────────────────────────────────────────────────────┘
```

**How it works under the hood:**

```
User clicks "🔍 Review"
  → POST /api/hermes/run { task, project_id, agent_role }
  → Backend loads default Hermes connection from hermes_connections table
  → Proxies to Hermes POST /v1/chat/completions with Bearer auth
  → Hermes SSE stream is passed transparently to Monastery UI
  → Frontend renders live-streamed agent message in chat
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

### 1. Chat Quick-Action Buttons (collapsible)

Toggleable row above the chat input. Click to expand/collapse:

| Button | Agent | Predefined Task |
|---|---|---|
| 🔍 Review | Reviewer | "Review my latest changes for bugs, security issues, and anti-patterns." |
| 🏗️ Plan | Architect | "Analyze this project and recommend the best architecture, patterns, and structure." |
| 🧪 Test | Tester | "Write comprehensive unit and integration tests for the current module." |
| 📝 Docs | Documenter | "Generate documentation for this project: README, API docs, and inline comments." |
| 💻 Implement | Coder | "Implement the feature described in the latest conversation with clean, secure code." |
| 🚀 Deploy | Deployer | "Prepare this project for deployment: check configuration, generate Dockerfile if needed." |

The quick-actions row is toggled by clicking the **🤖 Agents** header above the chat input. Users familiar with agents can collapse it.

### 2. Editor Toolbar Buttons

In the code editor toolbar, beside the file path:

| Button | Agent | What It Sends |
|---|---|---|
| **Explain** | Reviewer | Current file content + "Explain this code in detail" |
| **Refactor** | Coder | Current file content + "Refactor for better patterns, readability, and performance" |
| **Add Tests** | Tester | Current file content + "Write comprehensive unit and integration tests" |

Buttons are disabled when no file is open in the editor. Prompt templates live in `useAgents.ts`'s `editorPrompts` map — easy to customize without touching UI components.

### 3. Chat Input

Type a message like *"Review my latest changes"* — the task is dispatched to Hermes with the selected agent role as context.

---

## Response Flow

When an agent is invoked:

1. A **user message** appears in chat showing which agent was called (e.g., `🔍 **Reviewer**: Review my latest changes...`)
2. A **placeholder assistant message** is created and updated in real-time as Hermes streams
3. Monastery backend proxies the request to Hermes `POST /v1/chat/completions` with Bearer auth
4. Hermes SSE response is streamed transparently through Monastery to the frontend
5. The final response is saved to the session if one is active

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
| `packages/web-ui/src/hooks/useAgents.ts` | Agent role profiles, `runAgent()` → `POST /api/hermes/run` via SSE, quick action config, `editorPrompts` map |
| `packages/web-ui/src/hooks/useHermesAgent.ts` | SWR-based hook for Hermes connection CRUD (list/create/delete/test/set-default) |
| `packages/web-ui/src/components/ChatPane.tsx` | Toggleable quick-action buttons above chat input |
| `packages/web-ui/src/components/SettingsModal.tsx` | Hermes tab — add/test/delete connections, set default, connection status |
| `packages/web-ui/src/App.tsx` | `triggerAgent()` callback — shared by chat quick-actions and editor toolbar, uses `editorPrompts` |

### Backend
| File | Purpose |
|---|---|
| `crates/harness-api/src/handlers.rs` | Hermes handlers: `list_hermes_connections`, `create_hermes_connection`, `delete_hermes_connection`, `test_hermes_connection`, `set_default_hermes_connection`, `hermes_agent_run` (SSE proxy to Hermes `/v1/chat/completions`). Legacy `run_agent` still present for backward compat. |
| `crates/harness-api/src/main.rs` | Routes: `GET/POST /api/hermes/connections`, `DELETE /api/hermes/connections/:id`, `POST /api/hermes/connections/:id/test`, `POST /api/hermes/connections/:id/default`, `POST /api/hermes/run` |
| `crates/harness-api/src/db.rs` | `hermes_connections` table (id, name, base_url, api_key, is_default, created_at, last_used_at) |

