export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  attachments?: Attachment[];
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

export interface Session {
  id: string;
  projectId: string;
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
  paneLayout: {
    chat: number;
    editor: number;
    preview: number;
  };
}
