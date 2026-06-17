# Monastery Web UI

The frontend interface for **Monastery** — a self-hosted sanctuary for AI-assisted coding.

## Tech Stack

- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS with custom Monastery theme
- **State Management**: Zustand with persistence
- **Data Fetching**: SWR for automatic revalidation
- **Code Editor**: Monaco Editor (VS Code's editor)
- **Icons**: Lucide React
- **Resizable Panels**: react-resizable-panels

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
cd packages/web-ui
npm install
npm run dev
```

The development server starts on `http://localhost:3000` and proxies API requests to the backend at `http://localhost:8080`.

### Build for Production

```bash
npm run build
```

Output goes to `dist/`, served by the Rust backend or a static host.

---

## Project Structure

```
packages/web-ui/
├── src/
│   ├── components/           # UI components
│   │   ├── TopBar.tsx            # Persistent top navigation bar
│   │   ├── Sidebar.tsx           # Collapsible left sidebar (4 tabs)
│   │   ├── ChatPane.tsx          # AI chat with reasoning + agents
│   │   ├── CodeEditor.tsx        # Monaco editor wrapper
│   │   ├── PreviewPane.tsx       # Preview/terminal output
│   │   ├── SettingsModal.tsx     # Settings: LLM, Git, Hosting tabs
│   │   ├── GitForgeSetup.tsx     # GitHub/GitLab/Forgejo/Gitea connections
│   │   ├── HostingServicesTab.tsx # Dokploy/Coolify/Pocketbase setup
│   │   ├── SelfHostWizard.tsx    # One-click deployment wizard
│   │   ├── AgentsTab.tsx         # Sidebar agent list
│   │   └── ui/                   # Shared UI primitives
│   ├── hooks/                # Custom React hooks
│   │   ├── useEndpoints.ts       # LLM endpoint CRUD
│   │   ├── useGitForge.ts        # Git forge connections
│   │   ├── useHostingServices.ts # Hosting service connections + deploy
│   │   ├── useAgents.ts          # Agent definitions + runAgent()
│   │   ├── useSnapshots.ts       # Snapshot version control
│   │   └── useSessions.ts        # Chat session persistence
│   ├── lib/                 # Shared utilities
│   │   └── fetch.ts              # Shared SWR fetcher
│   ├── store/               # State management
│   │   └── useAppStore.ts        # Zustand store (persisted)
│   ├── types/               # TypeScript definitions
│   │   └── index.ts              # All shared interfaces
│   ├── styles/              # CSS modules & theme
│   ├── App.tsx              # Main application + keyboard shortcuts
│   ├── main.tsx             # Entry point
│   └── index.css            # Global styles & CSS variables
├── public/                  # Static assets (SVGs, icons)
│   └── images/                  # Logo + background SVGs
├── index.html
├── tailwind.config.js
├── vite.config.ts
└── package.json
```

---

## Design System

### Color Palette

| Token | Hex | Usage |
|---|---|---|
| Forest Green | `#0A3D2A` | Deep brand |
| Pine Green | `#1E6B4E` | Primary actions, borders |
| Lantern Gold | `#F4A460` | Accents, focus, links |
| Dark Background | `#0D1117` | Main surface |
| Dark Surface | `#161B22` | Cards, inputs |

See `BRANDING.md` for complete design guidelines.

### Themes

- **Monastery Dark** (default) — optimized for long coding sessions
- **Scriptorium Light** — warm, parchment-inspired light theme

Toggle via the sun/moon icon in the top bar.

---

## Components

### TopBar
Persistent header with project switcher, LLM status indicator, resource monitor, Self-Host Wizard button, theme toggle, and Settings.

### Sidebar
Collapsible left panel with 4 tabs:
- **Files** — project file tree
- **Sessions** — chat history with create/delete
- **Agents** — 6 built-in agent definitions with system prompts and tool badges
- **Integrations** — live status of LLM endpoints, Git forges, and hosting services

### ChatPane
AI conversation with:
- Live SSE streaming responses
- **Reasoning window** — expandable panel showing LLM thinking text (max 12 rows)
- **Agent quick-actions** — collapsible button row to dispatch Reviewer, Architect, Tester, Documenter, Coder, or Deployer agents
- File attachments, code block copy buttons, snapshot revert
- Welcome screen with suggested prompts when no messages exist

### CodeEditor
Monaco-based editor with custom Monastery dark theme, syntax highlighting, and a toolbar with:
- **Explain** — dispatches Reviewer agent on current file
- **Refactor** — dispatches Coder agent on current file
- **Add Tests** — dispatches Tester agent on current file
- **Save** — persist file changes

### SettingsModal
Multi-tab settings with:
- **LLM Endpoints** — add/validate/delete OpenAI-compatible endpoints
- **Git Forges** — connect GitHub, GitLab, Forgejo, Gitea with wizard-style setup
- **Hosting Services** — connect Dokploy, Coolify, Pocketbase with URL + API key + validation

### SelfHostWizard
One-click deployment modal (Ctrl+Shift+D):
- Detects connected deployment platforms and database backends
- Auto-generates Dockerfile based on framework detection (Next.js, Vite, React, Express, etc.)
- Creates app on Dokploy or Coolify and triggers deployment
- Returns dashboard URL to monitor build

### HostingServicesTab
Three service cards for Dokploy (PaaS), Coolify (deploy platform), and Pocketbase (database backend). Each card shows connection status:
- ⚠ **Not Verified** — saved but not validated
- ✓ **Connected** — validated successfully
- ✗ **Failed** — validation error with message

### GitForgeSetup
Wizard-style Git forge connection flow supporting GitHub, GitLab, Forgejo, and Gitea. Features repo browsing with branch selection, push-to-forge, and clone-to-project.

---

## State Management

Uses Zustand for lightweight, persistent state:

```typescript
import { useAppStore } from './store/useAppStore';

function MyComponent() {
  const { theme, toggleSidebar, currentProject } = useAppStore();
}
```

Persisted preferences: theme, pane layout, sidebar/preview collapsed state, active endpoint.

---

## API Integration

The UI connects to the Rust backend via:

| Protocol | Endpoints | Purpose |
|---|---|---|
| **REST** | `/api/*` | CRUD for endpoints, projects, sessions, git, hosting, agents |
| **SSE** | `/api/models/:id/chat`, `/api/agents/run` | Streaming LLM + agent responses |
| **SSE events** | `event: reasoning` / default | Separates reasoning from content in chat |

Data fetching uses **SWR** with automatic revalidation via the shared `lib/fetch.ts` fetcher.

---

## Key Features

### LLM Reasoning Display
When models emit reasoning tokens (e.g., DeepSeek's `reasoning_content`), they appear in a collapsible **Reasoning** panel above the chat message, capped at ~12 rows and scrollable.

### Agent System
6 built-in agents (Architect, Coder, Reviewer, Tester, Documenter, Deployer) can be invoked from:
- Chat quick-action buttons (collapsible row above input)
- Editor toolbar (Explain / Refactor / Add Tests)
- Each agent receives the full project context and streams its response live

### Git Forge Integration
Connect to GitHub, GitLab, Forgejo, or Gitea. Browse repos with branch selection, push projects, and clone repos as new Monastery projects.

### Self-Host Deployment
One-click deployment to Dokploy or Coolify. Auto-detects project framework, generates Dockerfile, creates the app on the platform, and triggers the build.

### Snapshot Version Control
Create, list, diff, and restore project snapshots. Automatic pre-commit snapshots on git push.

### Session Persistence
Chat sessions tied to projects with message history stored in SQLite via the backend.

---

## Architecture Patterns

### Shared Fetcher
All SWR hooks use a single `fetcher` from `lib/fetch.ts`:

```typescript
import { fetcher } from '../lib/fetch';
import useSWR from 'swr';

const { data } = useSWR('/api/endpoints', fetcher);
```

### Connection CRUD Pattern
Git forges, hosting services, and (future) external agents follow the same pattern:
```
useSWR → list connections
useCallback → connect / delete / test → mutate()
```

```

## Accessibility

- WCAG AA contrast compliance
- Full keyboard navigation
- Screen reader friendly
- Reduced motion support
- Focus indicators (Lantern Gold rings)

## Performance

- Code splitting by route
- Lazy component loading
- Virtualized lists for large message histories
- Debounced search inputs
- Efficient re-renders with React.memo

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Desktop-optimized (primary target)

## License

AGPL v3 - See LICENSE file
