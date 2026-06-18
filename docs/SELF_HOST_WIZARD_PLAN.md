# Self-Host Wizard — Implementation Plan

## Overview

Guide users through deploying their AI-generated apps to self-hosted platforms:
- **Dokploy** / **Coolify** — Deployment platforms (pick one)
- **Pocketbase** — Backend dependency (DB/Auth/Storage), auto-configured when needed

---

## Architecture: Service Hierarchy

```
┌─────────────────────────────────────────────────┐
│              Deployment Platform                 │
│         (Pick ONE — they're peers)               │
│     ┌──────────┐          ┌──────────┐          │
│     │ Dokploy  │          │ Coolify  │          │
│     │  (PaaS)  │          │  (PaaS)  │          │
│     └────┬─────┘          └────┬─────┘          │
│          │                     │                 │
│          │    Deploys your     │                 │
│          ▼    app container    ▼                 │
│     ┌──────────────────────────────────┐        │
│     │     Your App (Node/Python/etc)    │        │
│     └──────────────┬───────────────────┘        │
│                    │ needs DB?                   │
│                    ▼                             │
│     ┌──────────────────────────────┐            │
│     │        Pocketbase            │            │
│     │  (Backend — DB/Auth/Storage) │            │
│     │  Optional, configured when   │            │
│     │  the app requires a database │            │
│     └──────────────────────────────┘            │
└─────────────────────────────────────────────────┘
```

---

## Settings → "Hosting Services" Tab

Configure URL + API keys upfront. Three service cards:

```
┌─ Settings ────────────────────────────────────────┐
│  [LLM Endpoints]  [Git Forges]  [Hosting Services]│
├───────────────────────────────────────────────────┤
│  Dokploy card     — Instance URL + API Token      │
│  Coolify card     — Instance URL + API Token      │
│  Pocketbase card  — Instance URL + Admin Email    │
│                      + Admin Password             │
│                                                   │
│  Each card has: [Validate] button + status badge  │
└───────────────────────────────────────────────────┘
```

---

## Wizard Auto-Detection

| Service | Configured? | Wizard Behavior |
|---|---|---|
| Dokploy | ✓ Active | Shows green check, skips credential step, goes straight to configure |
| Dokploy | ✗ Not configured | Shows red X, selecting it → prompts for URL + API key |
| Coolify | ✓ Active | Same as Dokploy |
| Coolify | ✗ Not configured | Same as Dokploy |
| Pocketbase | ✓ Active | Shows as available backend. If app needs DB, auto-injected as env vars |
| Pocketbase | ✗ Not configured | Warns user DB won't be available |

---

## Wizard Step Flow

1. **Select Platform** — Dokploy or Coolify (with connection status indicators)
2. **Connect** — URL + API key (SKIPPED if already configured in Settings)
3. **Configure** — App name, domain, env vars, "Need database?" toggle
4. **Deploy** — Build log stream, progress, live URL result

---

## DB Schema

```sql
CREATE TABLE hosting_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    service_type TEXT NOT NULL CHECK(service_type IN ('dokploy', 'coolify', 'pocketbase')),
    base_url TEXT NOT NULL,
    api_token TEXT NOT NULL,
    username TEXT,
    email TEXT,
    is_default INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    last_synced_at TEXT
);
```

---

## API Routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/hosting/connections` | List saved connections |
| `POST` | `/api/hosting/connections` | Add new connection |
| `DELETE` | `/api/hosting/connections/:id` | Remove connection |
| `POST` | `/api/hosting/connections/:id/test` | Test connection validity |
| `POST` | `/api/hosting/deploy` | Deploy project to hosting platform |
| `POST` | `/api/hosting/preview` | Preview generated deploy files (Dockerfile, docker-compose.yml) |

---

## Files

### New Files
| File | Purpose |
|---|---|
| `packages/web-ui/src/components/HostingServicesTab.tsx` | Settings tab with 3 service cards |
| `packages/web-ui/src/hooks/useHostingServices.ts` | Hook with SWR for connections CRUD + test |

### Modified Files
| File | Change |
|---|---|
| `packages/web-ui/src/types/index.ts` | Add `HostingServiceType`, `HostingServiceConnection` |
| `packages/web-ui/src/components/SettingsModal.tsx` | Add "Hosting Services" tab |
| `crates/harness-api/src/db.rs` | Add `hosting_connections` table |
| `crates/harness-api/src/handlers.rs` | Add hosting connection handlers |
| `crates/harness-api/src/main.rs` | Register hosting API routes |

### Deferred to Later Phases
| File | Purpose | Status |
|---|---|---|
| `packages/web-ui/src/components/SelfHostWizard.tsx` | Wizard modal | ✅ Complete — stepper, preview, copy-paste, DB toggle |
| `packages/web-ui/src/lib/selfhost/*.ts` | API clients for Dokploy, Coolify, Pocketbase | 🔜 Deferred (inline fetch used) |
| `crates/harness-api/src/handlers.rs` | Deploy endpoint handlers | ✅ Complete — `deploy_to_hosting`, `preview_deploy` |

### Newly Implemented (June 2026)
| Feature | Description |
|---|---|
| **Stepper Interface** | 4-step flow: Platform → Connect → Configure → Deploy with clickable step indicators |
| **Connect Auto-Skip** | If platform already configured in Settings, skips directly to Configure step |
| **Inline Connect Form** | If platform not configured, shows URL + API Token fields directly in wizard |
| **Domain Configuration** | Optional domain field in Configure step, passed to platform API |
| **Pocketbase Toggle** | "Need database?" toggle generates `docker-compose.yml` with Pocketbase service |
| **Generated Files Preview** | Collapsible preview of Dockerfile and docker-compose.yml in Configure step |
| **Copy-Paste Instructions** | Manual deploy tab with terminal commands and copyable file contents |
| **Backend Preview Endpoint** | `POST /api/hosting/preview` returns framework detection + generated files without deploying |
