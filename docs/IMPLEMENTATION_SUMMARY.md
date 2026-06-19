# Implementation Summary: Environment Configuration & LLM Management

## Overview
This implementation ensures that:
1. **`.env.example` file exists** with comprehensive documentation
2. **Services won't fail without LLM configuration** on deployment
3. **Users can add API keys through the UI** without environment variables

## Files Created

### 1. `/workspace/.env.example`
- Documents all available environment variables
- Shows LLM configuration as optional (commented out by default)
- Includes helpful comments for each setting
- Covers server config, database, LLM endpoints, and discovery settings

### 2. `/workspace/ENV_CONFIG.md`
- Comprehensive documentation for the new configuration system
- User workflows for first-time setup
- Security considerations
- Troubleshooting guide
- Migration path from env vars to UI

### 3. `/workspace/packages/web-ui/src/hooks/useEndpoints.ts`
- `useEndpoints()` hook for managing LLM endpoints
- `useModels()` hook for fetching available models
- Full CRUD operations: add, delete, test endpoints
- TypeScript interfaces for type safety

### 4. `/workspace/packages/web-ui/src/components/SettingsModal.tsx`
- Full-featured modal for endpoint management
- Add endpoints with name, URL, and API key
- Test connectivity with visual feedback
- Delete endpoints with confirmation
- Helpful hints for Docker networking

## Files Modified

### Backend (Rust)

#### `/workspace/crates/harness-api/src/db.rs`
- Added `models_cache` table for storing discovered models
- Enables model caching across restarts

#### `/workspace/crates/harness-api/src/handlers.rs`

**Enhanced Endpoints:**

1. **`list_endpoints()`** - Now fetches from database
   - Returns empty array if no endpoints (no error)
   - Falls back to in-memory config

2. **`add_endpoint()`** - Saves to database
   - Persists endpoint configuration
   - Auto-detects local vs remote

3. **`delete_endpoint()`** - Removes from database
   - Proper cleanup with foreign keys

4. **`test_endpoint()`** - Tests connectivity
   - Works with DB and in-memory endpoints
   - Returns health status

5. **`list_models()`** - Aggregates from all endpoints
   - Graceful error handling
   - Continues if some endpoints fail

6. **`chat_stream()`** - Enhanced with endpoint selection
   - Optional `endpoint_id` query param
   - Clear error message if no endpoints
   - Uses first available by default

**New Types:**
- `ChatQueryParams` - For endpoint selection

### Frontend (TypeScript/React)

#### `/workspace/packages/web-ui/src/hooks/index.ts`
- Exported `useEndpoints` hook

#### `/workspace/packages/web-ui/src/components/TopBar.tsx`
- Added `useState` for settings modal
- Imported `SettingsModal` component
- Made "No LLM connected" clickable
- Integrated settings modal
- Settings button opens modal

## Key Features

### 1. Graceful Degradation
- Application starts without any LLM configured
- No crashes or errors on startup
- Clear UI indication when no LLM is connected

### 2. UI-Based Configuration
- Add/remove/test endpoints from browser
- No need to edit config files or restart
- Persistent storage in SQLite database

### 3. Multiple Endpoint Support
- Configure multiple LLM providers
- Switch between local and cloud
- Aggregate models from all endpoints

### 4. Testing & Validation
- Test endpoint connectivity before use
- Visual feedback (success/failure)
- Detailed error messages

### 5. Backward Compatibility
- Environment variables still work
- `LLM_BASE_URL` auto-adds endpoint on startup
- Both methods can coexist

## API Changes

### New/Updated Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/endpoints` | List all configured endpoints |
| POST | `/api/endpoints` | Add new endpoint |
| DELETE | `/api/endpoints/:id` | Remove endpoint |
| POST | `/api/endpoints/:id/test` | Test connectivity |
| GET | `/api/models` | List models from all endpoints |
| POST | `/api/models/:id/chat` | Chat (now with optional `?endpoint_id=`) |

### Request/Response Examples

**Add Endpoint:**
```json
POST /api/endpoints
{
  "name": "My Ollama",
  "base_url": "http://host.docker.internal:11434",
  "api_key": null
}
```

**Test Endpoint:**
```json
POST /api/endpoints/{id}/test
// Response:
{
  "endpoint_id": "uuid...",
  "is_healthy": true,
  "message": "Connection successful"
}
```

## Database Schema

### New Table: `models_cache`
```sql
CREATE TABLE models_cache (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    name TEXT,
    capabilities TEXT,
    discovered_at TEXT NOT NULL,
    FOREIGN KEY (endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE,
    UNIQUE(endpoint_id, model_id)
)
```

## User Experience Improvements

### Before
- Required `.env` file with `LLM_BASE_URL`
- Application might fail without configuration
- No way to add endpoints without restart
- Static configuration only

### After
- Optional environment configuration
- Application always starts successfully
- Add/configure endpoints from UI
- Dynamic configuration with persistence
- Test before using
- Multiple endpoints supported

## Testing Checklist

- [x] `.env.example` created with all variables
- [x] Services start without LLM config
- [x] UI shows "No LLM connected" state
- [x] Clicking opens settings modal
- [x] Can add endpoint via UI
- [x] Can test endpoint connectivity
- [x] Can delete endpoint
- [x] Endpoints persist after restart
- [x] Models list from configured endpoints
- [x] Chat works with selected endpoint
- [x] Clear error messages when needed
- [x] Backward compatible with env vars

## Documentation

All changes are documented in:
- `.env.example` - Inline comments
- `ENV_CONFIG.md` - Comprehensive guide
- Code comments in handlers and components

## Next Steps (Optional Enhancements)

1. **Endpoint Priority**: Set default/fallback order
2. **Model Caching**: Cache models for offline use
3. **Auto-Discovery**: Find local services automatically
4. **Usage Stats**: Track usage per endpoint
5. **Encrypted Storage**: Secure API key storage
6. **Rate Limiting**: Configure per-endpoint limits

## Related Features

This implementation complements:
- **Snapshot Feature** (`SNAPSHOT_FEATURE.md`) - Version control for code
- **Service Discovery** - Auto-find local LLM services
- **Multi-Provider Support** - Use different LLM providers

---

**Status**: ✅ Complete
**Breaking Changes**: None (fully backward compatible)
**Migration Required**: No (optional)

---

## Recent Additions (June 2026)

### File Operations (User-Initiated, No LLM Required)

New backend endpoints for direct file management from the sidebar:

| Method | Endpoint | Purpose |
|---|---|---|
| `DELETE` | `/api/projects/:id/files?path=` | Delete a file |
| `POST` | `/api/projects/:id/files/dir?path=` | Create a directory |
| `DELETE` | `/api/projects/:id/files/dir?path=` | Delete a directory recursively |
| `POST` | `/api/projects/:id/files/upload?path=` | Upload raw binary file |
| `POST` | `/api/projects/:id/files/move` | Move/rename file or directory |

All endpoints include path traversal protection (canonicalize + verify within project directory).

Frontend features in `Sidebar.tsx`:
- Files tab toolbar with "+" dropdown (New File, New Directory) and upload button
- Right-click context menu on file tree items
- Drag-and-drop to move files/directories between folders

### Self-Host Wizard Enhancements

`SelfHostWizard.tsx` rewritten with 4-step stepper interface:
- **Step 1 (Platform)**: Select Dokploy or Coolify with connection status
- **Step 2 (Connect)**: Inline credential form (auto-skipped if already configured)
- **Step 3 (Configure)**: App name, domain, port, Pocketbase DB toggle, generated files preview
- **Step 4 (Deploy)**: Auto Deploy (API) + Manual tab with copy-paste terminal commands

New backend endpoint: `POST /api/hosting/preview` — returns framework detection and generated Dockerfile/docker-compose.yml without deploying.

### Files Changed
| File | Change |
|---|---|
| `crates/harness-api/src/handlers.rs` | Added `delete_project_file`, `create_project_directory`, `delete_project_directory`, `upload_project_file`, `move_project_file`, `preview_deploy`, `generate_docker_compose` |
| `crates/harness-api/src/main.rs` | Registered 5 new routes + preview route |
| `packages/web-ui/src/components/Sidebar.tsx` | Context menu, toolbar, drag-and-drop, upload |
| `packages/web-ui/src/components/SelfHostWizard.tsx` | Full rewrite with stepper, preview, copy-paste, DB toggle |
| `packages/web-ui/src/hooks/useHostingServices.ts` | Added `PreviewResult` type, `previewDeploy()` function |
| `packages/web-ui/src/App.tsx` | Added `handleDeleteFile`, `handleCreateFile`, `handleCreateDirectory`, `handleDeleteDirectory`, `handleUploadFile`, `handleMoveFile`, `refreshFileTree` |

### Hermes Agent Integration (June 2026)

Stripped the 6 built-in agent system prompts (~200 lines of hardcoded prompt engineering) and replaced them with a passthrough to Hermes's REST API. All agent runs now proxy through `POST /api/hermes/run` → Hermes `POST /v1/chat/completions`. The frontend keeps agent role profiles (icon, name, description) for UX but delegates execution to Hermes.

New backend surface:
| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/hermes/connections` | List Hermes connections |
| `POST` | `/api/hermes/connections` | Add a Hermes connection |
| `DELETE` | `/api/hermes/connections/:id` | Remove a connection |
| `POST` | `/api/hermes/connections/:id/test` | Test connectivity (calls `/v1/models`) |
| `POST` | `/api/hermes/connections/:id/default` | Set as default connection |
| `POST` | `/api/hermes/run` | Proxy task to Hermes `/v1/chat/completions` with SSE passthrough |

New DB table: `hermes_connections` (id, name, base_url, api_key, is_default, created_at, last_used_at).

| File | Change |
|---|---|
| `crates/harness-api/src/db.rs` | Added `hermes_connections` table |
| `crates/harness-api/src/handlers.rs` | Added 6 Hermes handlers (connections CRUD + run proxy) |
| `crates/harness-api/src/main.rs` | Registered 6 `/api/hermes/*` routes |
| `Cargo.toml` | Added `async-stream = "0.3"` workspace dependency |
| `packages/web-ui/src/hooks/useAgents.ts` | Rewritten: stripped BUILT_IN_AGENTS/EXTERNAL_AGENTS, `runAgent()` now calls `/api/hermes/run`, added `editorPrompts` map |
| `packages/web-ui/src/hooks/useHermesAgent.ts` | New: SWR hook for Hermes connection CRUD |
| `packages/web-ui/src/components/SettingsModal.tsx` | Added Hermes tab with connection form, list, test/set-default/delete |
| `packages/web-ui/src/App.tsx` | Uses `editorPrompts` from `useAgents()`; dispatch flows through `/api/hermes/run` |
