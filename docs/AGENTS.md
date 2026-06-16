# Agents — Architecture & Implementation Plan

## Overview

Monastery's agent system enables the main chat LLM to dispatch specialized work to sub-agents, each with its own system prompt, tool access, and execution context. Think of agents as **specialized workers** the orchestrator can delegate tasks to.

## Three-Tier Architecture

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

---

## Built-in Agents

These ship with Monastery — each has a tuned system prompt and project context:

| Agent | Role | System Prompt Focus | Tools |
|---|---|---|---|
| **Architect** | Plans project structure, chooses patterns | Architecture design, trade-off analysis | File tree read, package.json scan |
| **Coder** | Writes/edits code files | Implementation, following patterns | File read/write, shell |
| **Reviewer** | Code review, catches bugs/anti-patterns | Code quality, security, performance | File read, git diff |
| **Tester** | Writes unit/integration tests | Test coverage, edge cases | File read/write, shell (test runner) |
| **Documenter** | Generates README, API docs, JSDoc | Documentation clarity, completeness | File read/write |
| **Deployer** | Packages and deploys to hosting services | Deployment configuration, env vars | Hosting API, git push |

---

## External Agent Frameworks

Connect to self-hosted agent frameworks:

| Framework | Description | API Integration |
|---|---|---|
| **Hermes** | Local AI agent runner | REST API — dispatch tasks, stream results |
| **Open Claw** | Multi-agent orchestration | REST/WebSocket API — task delegation protocol |

External agents follow the same **Connect → Validate → Dispatch** pattern as Hosting Services.

---

## Chat Integration Flow (Future Phase)

### Explicit Invocation (User asks)
```
User: "Run the Reviewer agent on my last changes"
 → System: Creates agent run with project context
 → Agent: Streams review results back to chat
 → Result: Displayed in collapsible sub-panel (similar to reasoning window)
```

### Implicit Invocation (LLM decides)
```
LLM: "I'll dispatch the Coder agent to write the auth routes,
      then the Tester agent to verify them."
 → System: Queues Coder → Tester pipeline
 → Each agent: Streams output to chat sub-panels
 → Main chat: Resumes after pipeline completes
```

---

## Agents Tab UI

```
┌─ Agents ─────────────────────────────────────┐
│                                               │
│  Built-in Agents                              │
│  ┌──────────────────────────────────────┐    │
│  │ 🏗️ Architect       idle              │    │
│  │    Plans project structure            │    │
│  │ 💻 Coder           idle              │    │
│  │    Writes and edits code files        │    │
│  │ 🔍 Reviewer        idle              │    │
│  │    Code quality and security review   │    │
│  │ 🧪 Tester          idle              │    │
│  │    Writes unit and integration tests  │    │
│  │ 📝 Documenter      idle              │    │
│  │    Generates README, API docs         │    │
│  │ 🚀 Deployer        idle              │    │
│  │    Deploys to hosting services        │    │
│  └──────────────────────────────────────┘    │
│                                               │
│  External Agents                              │
│  ┌──────────────────────────────────────┐    │
│  │ 🤖 Hermes          Coming soon        │    │
│  │    Local AI agent runner              │    │
│  ├──────────────────────────────────────┤    │
│  │ 🦞 Open Claw      Coming soon        │    │
│  │    Multi-agent orchestration          │    │
│  └──────────────────────────────────────┘    │
│                                               │
│  Dispatch agents from chat — coming soon      │
└───────────────────────────────────────────────┘
```

---

## Implementation Phases

| Phase | What | Effort |
|---|---|---|
| **Phase 1 (Now)** | Agents tab shows 6 built-in agent definitions (static) + external agent placeholders + "coming soon" note | Small |
| **Phase 2** | Backend: `POST /api/agents/:id/run` — spawns sub-LLM call with agent-specific system prompt | Medium |
| **Phase 3** | Chat UI: agent invocation as collapsible sub-message with live stream | Medium |
| **Phase 4** | External agents: connect Hermes / Open Claw via APIs, dispatch tasks | Large |

---

## File Plan

### Phase 1 Files
| File | Purpose |
|---|---|
| `packages/web-ui/src/hooks/useAgents.ts` | Static built-in agent definitions + future external agent connections |
| `packages/web-ui/src/components/AgentsTab.tsx` | Sidebar tab displaying agent list |
| `packages/web-ui/src/components/Sidebar.tsx` | Wire up AgentsTab |

### Future Phase Files
| File | Purpose |
|---|---|
| `crates/harness-api/src/db.rs` | `agent_connections` table |
| `crates/harness-api/src/handlers/agents.rs` | Agent run/dispatch endpoints |
| `packages/web-ui/src/components/AgentRunPanel.tsx` | Chat sub-panel for live agent output |
