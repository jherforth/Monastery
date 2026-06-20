export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  timestamp: number;
  model?: string;
  attachments?: Attachment[];
  /** True when the model stopped because it hit max_tokens (finish_reason="length"),
   *  meaning the response is incomplete and can be continued on user request. */
  truncated?: boolean;
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

// Hosting service types (Self-Host Wizard)
export type HostingServiceType = 'dokploy' | 'coolify' | 'pocketbase';

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
