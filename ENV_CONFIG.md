# Environment Configuration & LLM Endpoint Management

## Overview

This document describes the environment configuration system and the ability to manage LLM endpoints dynamically through the UI, ensuring the services won't fail if no LLM is configured on deployment.

## Environment Variables

### `.env.example`

A new `.env.example` file has been created to document all available environment variables:

```bash
# Server Configuration
PORT=3000
DATA_DIR=./data
LOG_LEVEL=info

# Database (SQLite by default)
# DATABASE_URL=sqlite://./data/harness.db

# LLM Endpoint Configuration (Optional - can be configured via UI)
# If set, this endpoint will be added automatically on startup
# LLM_BASE_URL=http://localhost:11434
# LLM_API_KEY=your-api-key-here

# Service Discovery
DISABLE_DISCOVERY=false
```

### Key Changes

1. **LLM Configuration is Now Optional**: The `LLM_BASE_URL` environment variable is commented out by default, indicating that it's optional.

2. **UI-Based Configuration**: Users can add, configure, and test LLM endpoints directly from the UI without needing environment variables.

3. **Graceful Degradation**: The application starts successfully even without any LLM endpoints configured.

## Backend Changes

### Database Schema Updates

Added a `models_cache` table to store discovered models from endpoints:

```sql
CREATE TABLE IF NOT EXISTS models_cache (
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

### API Endpoint Improvements

#### 1. List Endpoints (`GET /api/endpoints`)
- Now fetches from database instead of static config
- Returns empty array if no endpoints configured (no error)
- Falls back to in-memory config for env-configured endpoints

#### 2. Add Endpoint (`POST /api/endpoints`)
- Saves new endpoints to database
- Accepts: `name`, `base_url`, `api_key` (optional)
- Automatically detects if endpoint is local based on URL

#### 3. Delete Endpoint (`DELETE /api/endpoints/:id`)
- Removes endpoint from database
- Returns 204 No Content on success

#### 4. Test Endpoint (`POST /api/endpoints/:id/test`)
- Tests connectivity to the endpoint
- Returns health status and message
- Works with both database and in-memory endpoints

#### 5. List Models (`GET /api/models`)
- Fetches models from ALL configured endpoints
- Gracefully handles connection failures (logs warning, continues)
- Returns empty array if no endpoints available

#### 6. Chat Stream (`POST /api/models/:id/chat`)
- Now accepts optional `endpoint_id` query parameter
- Provides clear error message if no endpoints configured
- Uses first available endpoint by default

## Frontend Changes

### New Components

#### `SettingsModal.tsx`
A comprehensive settings modal for managing LLM endpoints:

**Features:**
- Add new endpoints with name, URL, and API key
- Test endpoint connectivity
- Delete existing endpoints
- Visual feedback for connection status
- Helpful hints for Docker networking

**Usage:**
```tsx
import { SettingsModal } from './components/SettingsModal';

// In your component
const [isOpen, setIsOpen] = useState(false);

<SettingsModal 
  isOpen={isOpen} 
  onClose={() => setIsOpen(false)} 
/>
```

#### `useEndpoints.ts` Hook
Custom React hook for endpoint management:

```typescript
const {
  endpoints,        // Array of configured endpoints
  isLoading,        // Loading state
  isError,          // Error state
  addEndpoint,      // Function to add endpoint
  deleteEndpoint,   // Function to delete endpoint
  testEndpoint,     // Function to test connectivity
  mutate,           // SWR mutate for manual refresh
} = useEndpoints();
```

#### `useModels.ts` Hook
Hook for fetching available models:

```typescript
const { models, isLoading, isError } = useModels(endpointId);
```

### Updated Components

#### `TopBar.tsx`
- Added Settings button integration
- "No LLM connected" message now clickable to open settings
- Integrated `SettingsModal`

## User Workflows

### First-Time Setup (No LLM Configured)

1. **Deploy Application**
   ```bash
   docker-compose up -d
   ```

2. **Open UI**
   - Navigate to `http://localhost:3000`
   - See "No LLM connected • Click to configure" in top bar

3. **Configure Endpoint**
   - Click the "No LLM connected" message or Settings icon
   - Fill in endpoint details:
     - Name: "My Ollama Server"
     - Base URL: `http://host.docker.internal:11434` (for Docker)
     - API Key: (leave blank for local Ollama)
   - Click "Add Endpoint"
   - Click "Test" to verify connectivity

4. **Start Using**
   - Select model from dropdown
   - Start chatting!

### Adding Multiple Endpoints

Users can configure multiple endpoints for different purposes:
- Local Ollama for development
- Cloud provider for production
- Different providers for different capabilities

## Security Considerations

### API Key Storage
- API keys are stored in the SQLite database
- Keys are not exposed in API responses
- Use HTTPS in production

### Docker Networking
For connecting to local services from Docker:
- **Linux**: Use `http://172.17.0.1:PORT` or configure host networking
- **macOS/Windows**: Use `http://host.docker.internal:PORT`
- **Alternative**: Run services on the same Docker network

## Migration Path

### From Environment Variables to UI

If you currently use `LLM_BASE_URL`:

1. **Keep it working**: Environment-configured endpoints still work
2. **Migrate gradually**: Add endpoints via UI
3. **Remove env vars**: Once UI endpoints are configured, remove `LLM_BASE_URL`

### Backward Compatibility

- Environment variables take precedence on startup
- UI-configured endpoints persist across restarts
- Both methods can coexist

## Troubleshooting

### "No LLM endpoint configured" Error

**Cause**: No endpoints configured in database or environment

**Solution**:
1. Open Settings (gear icon)
2. Add an endpoint
3. Test connectivity

### Connection Failed in Docker

**Common Issues**:
1. Wrong hostname - use `host.docker.internal` not `localhost`
2. Firewall blocking - ensure port is accessible
3. Service not running - verify LLM service is up

**Solution**:
```bash
# Test from host
curl http://localhost:11434/api/tags

# Test from container
docker exec -it <container> curl http://host.docker.internal:11434/api/tags
```

### API Key Issues

**Symptoms**: 401 Unauthorized errors

**Solution**:
1. Verify API key is correct
2. Check key permissions/scopes
3. Ensure endpoint URL matches the provider

## Future Enhancements

- [ ] Endpoint priority/failover configuration
- [ ] Model caching for offline operation
- [ ] Automatic endpoint discovery
- [ ] Usage statistics per endpoint
- [ ] Rate limiting configuration
- [ ] Encrypted API key storage

## Related Documentation

- `.env.example` - Environment variable reference
- `SNAPSHOT_FEATURE.md` - Snapshot and rollback feature
- `ARCHITECTURE.md` - System architecture overview
