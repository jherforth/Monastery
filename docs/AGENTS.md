# Agents — Architecture & Implementation

## Overview

Monastery's agent system enables the main chat LLM to dispatch specialized work to sub-agents, each with its own system prompt, tool access, and execution context. Think of agents as **specialized workers** the orchestrator can delegate tasks to.

**Status: Phases 1–3 complete.** Agents are fully functional — you can invoke them from chat quick-actions, the editor toolbar, or by typing `@agent:name task` in the chat input. Each agent streams its response live into the conversation.

## Architecture

```
┌─────────────────────────────────────────────┐
│              Main Chat (Orchestrator)        │
│  "Build a full-stack app with auth"         │
└──────────┬──────────┬──────────┬────────────┘
           │          │          │
     ┌─────▼──┐  ┌────▼───┐  ┌─▼──────────┐
     │ Code   │  │ Test   │  │ Deploy      │
     │ Agent  │  │ Agent  │  │ Agent       │
     │ writes │  │ writes │  │ pushes to   │
     │ routes │  │ unit   │  │ Dokploy/    │
     │ + APIs │  │ tests  │  │ Coolify     │
     └────────┘  └────────┘  └─────────────┘
```

**How it works under the hood:**

```
User clicks "🔍 Review"
  → POST /api/agents/run { system_prompt, task, project_id }
  → Backend loads project files as context (capped at 200KB)
  → LLM streams response via SSE (with reasoning support)
  → Frontend renders live-streamed agent message in chat
```

---

## Built-in Agents

Each agent has a tuned system prompt and receives full project context when invoked:

| Agent | Role | System Prompt Focus |
|---|---|---|
| 🏗️ **Architect** | System Designer | Architecture design, trade-off analysis, project structure |
| 💻 **Coder** | Implementation | Write/edit code following project patterns |
| 🔍 **Reviewer** | Code Review | Bugs, security, performance, anti-patterns |
| 🧪 **Tester** | Quality Assurance | Unit/integration/edge case tests |
| 📝 **Documenter** | Technical Writer | README, API docs, JSDoc, troubleshooting guides |
| 🚀 **Deployer** | DevOps / Deployment | Dockerfile generation, hosting platform configuration |

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

Buttons are disabled when no file is open in the editor.

### 3. Chat Input

Type a message like *"Review my latest changes"* — the main LLM handles it, but you can also explicitly reference agents in natural language.

---

## Response Flow

When an agent is invoked:

1. A **user message** appears in chat showing which agent was called (e.g., `🔍 **Reviewer**: Review my latest changes...`)
2. A **placeholder assistant message** is created and updated in real-time as the agent streams
3. The agent's **system prompt** is combined with the **full project context** (files capped at 200KB)
4. The LLM response streams via **SSE** with reasoning support
5. The final response is saved to the session if one is active

---

## External Agent Frameworks (Future)

| Framework | Description | Status |
|---|---|---|
| 🤖 **Hermes** | Local AI agent runner — REST API for task dispatch | Coming soon |
| 🦞 **Open Claw** | Multi-agent orchestration — task delegation protocol | Coming soon |

External agents will follow the same **Connect → Validate → Dispatch** pattern as Hosting Services.

---

## Implementation Status

| Phase | What | Status |
|---|---|---|
| **Phase 1** | Agents tab with 6 built-in definitions + external placeholders | ✅ Complete |
| **Phase 2** | Backend `POST /api/agents/run` — spawns sub-LLM call with agent system prompt + project context | ✅ Complete |
| **Phase 3** | Chat UI: quick-action buttons, live-streamed agent responses, editor toolbar integration | ✅ Complete |
| **Phase 4** | External agents: connect Hermes / Open Claw via APIs, dispatch tasks | 🔜 Planned |

---

## File Map

### Frontend
| File | Purpose |
|---|---|
| `packages/web-ui/src/hooks/useAgents.ts` | Agent definitions, `runAgent()` with SSE streaming, quick action config |
| `packages/web-ui/src/components/AgentsTab.tsx` | Sidebar tab — agent list with descriptions and tool badges |
| `packages/web-ui/src/components/ChatPane.tsx` | Toggleable quick-action buttons above chat input |
| `packages/web-ui/src/components/Sidebar.tsx` | Agents tab integration |
| `packages/web-ui/src/App.tsx` | `triggerAgent()` callback — shared by chat quick-actions and editor toolbar |

### Backend
| File | Purpose |
|---|---|
| `crates/harness-api/src/handlers.rs` | `run_agent` handler — loads project context, builds agent prompt, streams via LLM |
| `crates/harness-api/src/main.rs` | Route: `POST /api/agents/run` |

### Future
| File | Purpose |
|---|---|
| `crates/harness-api/src/db.rs` | `agent_connections` table for external agents |
| `packages/web-ui/src/components/AgentRunPanel.tsx` | Chat sub-panel for live agent output (if separate from main chat) |

