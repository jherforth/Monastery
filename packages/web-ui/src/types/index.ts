export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  timestamp: number;
  model?: string;
  /** Custom label for the snapshot-restore button on system messages that carry a
   *  snapshot id in `model` (e.g. "Abandon these changes" on AI-edit checkpoints). */
  revertLabel?: string;
  attachments?: Attachment[];
  /** True when the model stopped because it hit max_tokens (finish_reason="length"),
   *  meaning the response is incomplete and can be continued on user request. */
  truncated?: boolean;
  /** How many times this message was auto-continued after hitting the output-token cap. */
  autoContinueCount?: number;
  /** True while an auto-continuation request is currently streaming into this message. */
  continuing?: boolean;
  /** Accumulated token usage across the initial response + any continuations (when the
   *  endpoint reports it via stream_options.include_usage). */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** Which backend produced this assistant message — shown as a small badge in the UI. */
  via?: 'hermes' | 'llm';
  /** Agent role label(s) active when a user message was sent (e.g. "🏗️ Architect") — shown as chips. */
  agentLabels?: string[];
  /** On system messages: proposed workflow-task title. ChatPane renders a one-click
   *  "create task & plan it" button for it (the large-project workflow nudge). */
  suggestTaskTitle?: string;
  /** Per-file before/after captured when this system message reports applied AI changes —
   *  rendered as expandable diff cards under the message. */
  fileChanges?: FileChange[];
  /** 'activity' renders as a compact inline row (tool/step chatter) instead of a bubble. */
  kind?: 'activity';
}

/** One applied AI file change, with the content before and after for the diff card. */
export interface FileChange {
  path: string;
  kind: 'write' | 'edit';
  before: string;
  after: string;
}

export interface Attachment {
  type: 'file' | 'image' | 'code';
  name: string;
  content?: string;
  path?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  lastOpened: number;
  files: FileNode[];
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  syncStatus?: 'synced' | 'modified' | 'new';
}

export interface LLMEndpoint {
  id: string;
  name: string;
  url: string;
  model?: string;
  status: 'connected' | 'disconnected' | 'error';
  isLocal: boolean;
  priority: number;
}

// Session types (aligned with backend API)
export interface SessionInfo {
  id: string;
  project_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  model: string | null;
  created_at: string;
}

export interface SessionDetail {
  id: string;
  project_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  messages: SessionMessage[];
}

// Legacy session type (used in store)
export interface Session {
  id: string;
  projectId: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface ResourceUsage {
  cpu: number;
  memory: number;
  gpu?: number;
  llmCpu?: number;
  llmMemory?: number;
}

export interface HomelabIntegration {
  type: 'proxmox' | 'coolify' | 'mqtt' | 'docker';
  name: string;
  connected: boolean;
  url?: string;
}

export interface AppState {
  currentProject: Project | null;
  sessions: Session[];
  currentSession: Session | null;
  endpoints: LLMEndpoint[];
  activeEndpoint: LLMEndpoint | null;
  resourceUsage: ResourceUsage | null;
  integrations: HomelabIntegration[];
  theme: 'monastery-dark' | 'scriptorium-light';
  sidebarCollapsed: boolean;
  previewCollapsed: boolean;
  paneLayout: {
    chat: number;
    editor: number;
    preview: number;
  };
}

// Snapshot types (shared between hooks and store)
export interface SnapshotSummary {
  id: string;
  project_id: string;
  name: string;
  description?: string;
  created_at: string;
  created_by?: string;
  parent_snapshot_id?: string;
  is_active: boolean;
  tags: string[];
  files_count: number;
  total_size_bytes: number;
}

export interface SnapshotFile {
  id: string;
  snapshot_id: string;
  file_path: string;
  content?: string;
  file_hash: string;
  created_at: string;
  size_bytes: number;
}

export interface SnapshotDetail {
  snapshot: SnapshotSummary;
  files: SnapshotFile[];
}

export interface SnapshotDiff {
  added_files: FileDiff[];
  removed_files: FileDiff[];
  modified_files: FileDiff[];
  unchanged_files: FileDiff[];
}

export interface FileDiff {
  file_path: string;
  old_hash?: string;
  new_hash?: string;
  old_size: number;
  new_size: number;
  change_type: 'added' | 'removed' | 'modified' | 'unchanged';
}

// Hosting service types (Self-Host Wizard + Cloudflare routing automation)
export type HostingServiceType = 'dokploy' | 'coolify' | 'pocketbase' | 'cloudflare';

export interface HostingServiceConnection {
  id: string;
  name: string;
  service_type: HostingServiceType;
  base_url: string;
  api_token: string;
  username: string | null;
  email: string | null;
  is_default: boolean;
  created_at: string;
  last_synced_at: string | null;
}
