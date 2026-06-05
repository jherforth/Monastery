# Snapshot & Rollback Feature

## Overview

This feature provides robust code versioning and rollback capabilities for the HomeLab AI Harness. Users can create snapshots of their project state at any point in time, browse through snapshot history, and restore to previous versions when mistakes are made.

## Architecture

### Database Schema

Three new tables have been added to the SQLite database:

1. **snapshots** - Main snapshot metadata
   - `id` - Unique identifier (UUID)
   - `project_id` - Parent project reference
   - `name` - Human-readable snapshot name
   - `description` - Optional description/commit message
   - `created_at` - Timestamp
   - `created_by` - User identifier
   - `parent_snapshot_id` - Reference to parent snapshot (for lineage)
   - `is_active` - Currently active snapshot flag
   - `metadata` - JSON metadata (file count, size, trigger type)

2. **snapshot_files** - File content storage
   - `id` - Unique identifier (UUID)
   - `snapshot_id` - Parent snapshot reference
   - `file_path` - Relative file path in project
   - `content` - File content (text)
   - `file_hash` - Hash for change detection
   - `created_at` - Timestamp

3. **snapshot_tags** - Categorization tags
   - `id` - Unique identifier (UUID)
   - `snapshot_id` - Parent snapshot reference
   - `tag` - Tag name
   - `created_at` - Timestamp

### Core Types (`harness-core/src/snapshot.rs`)

- `Snapshot` - Complete snapshot representation
- `SnapshotFile` - Individual file within a snapshot
- `SnapshotMetadata` - Statistics and metadata
- `SnapshotTrigger` - What triggered the snapshot (Manual, AutoSave, BeforeChange, etc.)
- `CreateSnapshotRequest/Response` - Creation API contracts
- `RestoreSnapshotRequest/Response` - Restoration API contracts
- `SnapshotDiff` - Difference between snapshots
- `FileDiff` - Individual file changes

### Service Layer (`harness-api/src/snapshot_service.rs`)

The `SnapshotService` provides:

- `create_snapshot()` - Create new snapshot from file list
- `list_snapshots()` - Paginated snapshot listing
- `get_snapshot()` - Retrieve snapshot with files
- `restore_snapshot()` - Restore project to snapshot state
- `diff_snapshots()` - Compare two snapshots
- `add_tag()` / `remove_tag()` - Tag management
- `delete_snapshot()` - Remove snapshot

### API Endpoints

All endpoints are prefixed with `/api/projects/:project_id/snapshots`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List all snapshots (paginated) |
| POST | `/` | Create new snapshot |
| GET | `/:snapshot_id` | Get snapshot details with files |
| DELETE | `/:snapshot_id` | Delete a snapshot |
| POST | `/:snapshot_id/restore` | Restore to snapshot |
| GET | `/:snapshot_id/diff?target=:uuid` | Compare with another snapshot |

### Request/Response Examples

#### Create Snapshot

```json
POST /api/projects/{project_id}/snapshots
{
  "name": "Before Refactoring",
  "description": "Creating backup before major refactoring",
  "created_by": "user-123",
  "trigger": "manual",
  "files": [
    {
      "file_path": "src/main.rs",
      "content": "fn main() { println!(\"Hello\"); }"
    },
    {
      "file_path": "src/lib.rs",
      "content": "pub fn add(a: i32, b: i32) -> i32 { a + b }"
    }
  ]
}
```

#### List Snapshots

```json
GET /api/projects/{project_id}/snapshots?page=1&per_page=50

{
  "snapshots": [
    {
      "id": "uuid",
      "name": "Before Refactoring",
      "created_at": "2024-01-15T10:30:00Z",
      "files_count": 15,
      "total_size_bytes": 45678,
      "tags": ["before-refactor", "stable"]
    }
  ],
  "total": 5,
  "page": 1,
  "per_page": 50
}
```

#### Restore Snapshot

```json
POST /api/projects/{project_id}/snapshots/{snapshot_id}/restore
{
  "dry_run": false,
  "create_backup": true
}
```

Response:
```json
{
  "success": true,
  "restored_files": 15,
  "failed_files": 0,
  "backup_snapshot_id": "uuid-of-backup",
  "errors": []
}
```

#### Diff Snapshots

```json
GET /api/projects/{project_id}/snapshots/{snapshot_id}/diff?target={other_snapshot_id}

{
  "added_files": [
    {
      "file_path": "src/new_module.rs",
      "new_hash": "abc123",
      "new_size": 1234,
      "change_type": "added"
    }
  ],
  "removed_files": [],
  "modified_files": [
    {
      "file_path": "src/main.rs",
      "old_hash": "def456",
      "new_hash": "ghi789",
      "old_size": 100,
      "new_size": 150,
      "change_type": "modified"
    }
  ],
  "unchanged_files": [...]
}
```

## UI Integration Points

### Components to Implement

1. **SnapshotPanel** (`packages/web-ui/src/components/SnapshotPanel.tsx`)
   - Timeline view of snapshots
   - Search/filter by tags
   - Preview snapshot contents

2. **SnapshotListItem** (`packages/web-ui/src/components/SnapshotListItem.tsx`)
   - Display snapshot metadata
   - Quick actions (restore, diff, delete)
   - Tag badges

3. **SnapshotDiffViewer** (`packages/web-ui/src/components/SnapshotDiffViewer.tsx`)
   - Side-by-side file comparison
   - Change highlighting
   - File tree navigation

4. **RollbackConfirmation** (`packages/web-ui/src/components/RollbackConfirmation.tsx`)
   - Show what will change
   - Backup option toggle
   - Dry run preview

### Store Extensions

Add to `useAppStore.ts`:

```typescript
interface SnapshotState {
  currentSnapshots: SnapshotSummary[];
  selectedSnapshot: Snapshot | null;
  isCreatingSnapshot: boolean;
  isRestoring: boolean;
}

interface SnapshotActions {
  fetchSnapshots: (projectId: string) => Promise<void>;
  createSnapshot: (request: CreateSnapshotRequest) => Promise<Snapshot>;
  restoreSnapshot: (snapshotId: string, options?: RestoreOptions) => Promise<void>;
  deleteSnapshot: (snapshotId: string) => Promise<void>;
  compareSnapshots: (id1: string, id2: string) => Promise<SnapshotDiff>;
}
```

### Automatic Snapshot Triggers

Consider automatic snapshots on:
- Before LLM-generated code changes
- After successful compilation/build
- Before deployment
- Periodic auto-save (configurable interval)
- Manual keyboard shortcut (Ctrl+Shift+S)

## Security Considerations

1. **Project Isolation**: All snapshot operations verify project ownership
2. **Content Validation**: File paths are sanitized to prevent directory traversal
3. **Size Limits**: Implement max snapshot size to prevent DoS
4. **Access Control**: Only authorized users can create/restore/delete

## Performance Optimizations

1. **Incremental Snapshots**: Store only changed files (using hash comparison)
2. **Compression**: Compress file content in database
3. **Pagination**: Default 50 snapshots per page
4. **Lazy Loading**: Load file contents only when viewing snapshot details
5. **Cleanup Policy**: Auto-delete old snapshots beyond retention period

## Future Enhancements

1. **Branch Support**: Multiple snapshot branches like Git
2. **Merge Conflicts**: Handle conflicts during restore
3. **External Storage**: Option to store snapshots in S3/Git
4. **Collaborative Tags**: Shared tags across team members
5. **Snapshot Templates**: Pre-defined snapshot configurations
6. **Webhook Integration**: Notify external services on snapshot events
