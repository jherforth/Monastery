import { Folder, FileCode, ChevronRight, ChevronDown, MessageSquare, Plus, Trash2, Loader2, Cpu, GitBranch, Server, Database, CheckCircle2, Bot } from 'lucide-react';
import { useState } from 'react';
import { FileNode, SessionInfo, SessionDetail } from '../types';
import { useEndpoints } from '../hooks/useEndpoints';
import { useGitForge } from '../hooks/useGitForge';
import { useHostingServices } from '../hooks/useHostingServices';
import { AgentsTab } from './AgentsTab';

function IntegrationsStatus() {
  const { endpoints, isLoading: llmLoading } = useEndpoints();
  const { connections: gitConns, isLoading: gitLoading } = useGitForge();
  const { connections: hostingConns, isLoading: hostingLoading } = useHostingServices();

  const isLoading = llmLoading || gitLoading || hostingLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-monastery-text-muted">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const activeLLM = endpoints.filter(e => e.is_favorite).length;
  const totalLLM = endpoints.length;
  const activeGit = gitConns.length;
  const activeHosting = hostingConns.length;
  const totalActive = activeLLM + activeGit + activeHosting;

  const serviceLabel = (type: string) => {
    switch (type) {
      case 'dokploy': return 'Dokploy';
      case 'coolify': return 'Coolify';
      case 'pocketbase': return 'Pocketbase';
      default: return type;
    }
  };

  const serviceIcon = (type: string) => {
    switch (type) {
      case 'pocketbase': return <Database size={12} className="text-amber-400" />;
      default: return <Server size={12} className="text-blue-400" />;
    }
  };

  return (
    <div className="px-3 py-2 space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-2 px-1">
        <div className={`w-2 h-2 rounded-full ${totalActive > 0 ? 'bg-green-400' : 'bg-monastery-text-muted'}`} />
        <span className="text-xs text-monastery-text-secondary">
          {totalActive > 0 ? `${totalActive} active` : 'No active integrations'}
        </span>
      </div>

      {/* LLM Endpoints */}
      <div>
        <div className="flex items-center gap-1.5 px-1 mb-1.5">
          <Cpu size={12} className="text-monastery-lantern" />
          <span className="text-xs font-medium text-monastery-text-primary">LLM Endpoints</span>
          <span className="text-xs text-monastery-text-muted">({totalLLM})</span>
        </div>
        {endpoints.length === 0 ? (
          <p className="px-3 text-xs text-monastery-text-muted italic">None configured</p>
        ) : (
          <div className="space-y-0.5">
            {endpoints.map(ep => (
              <div key={ep.id} className="flex items-center gap-1.5 px-3 py-1 text-xs">
                {ep.is_favorite ? (
                  <CheckCircle2 size={12} className="text-green-400 flex-shrink-0" />
                ) : (
                  <CheckCircle2 size={12} className="text-monastery-text-muted flex-shrink-0" />
                )}
                <span className="text-monastery-text-secondary truncate">{ep.name}</span>
                {ep.is_local && (
                  <span className="text-[10px] text-monastery-text-muted bg-monastery-dark-tertiary px-1 rounded">local</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Git Forges */}
      <div>
        <div className="flex items-center gap-1.5 px-1 mb-1.5">
          <GitBranch size={12} className="text-monastery-pine" />
          <span className="text-xs font-medium text-monastery-text-primary">Git Forges</span>
          <span className="text-xs text-monastery-text-muted">({activeGit})</span>
        </div>
        {gitConns.length === 0 ? (
          <p className="px-3 text-xs text-monastery-text-muted italic">None configured</p>
        ) : (
          <div className="space-y-0.5">
            {gitConns.map(conn => (
              <div key={conn.id} className="flex items-center gap-1.5 px-3 py-1 text-xs">
                <CheckCircle2 size={12} className="text-green-400 flex-shrink-0" />
                <span className="text-monastery-text-secondary truncate">
                  {conn.forge_type === 'github' ? 'GitHub' : conn.forge_type === 'gitlab' ? 'GitLab' : conn.forge_type === 'forgejo' ? 'Forgejo' : 'Gitea'}
                </span>
                {conn.username && (
                  <span className="text-[10px] text-monastery-text-muted">({conn.username})</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hosting Services */}
      <div>
        <div className="flex items-center gap-1.5 px-1 mb-1.5">
          <Server size={12} className="text-purple-400" />
          <span className="text-xs font-medium text-monastery-text-primary">Hosting Services</span>
          <span className="text-xs text-monastery-text-muted">({activeHosting})</span>
        </div>
        {hostingConns.length === 0 ? (
          <p className="px-3 text-xs text-monastery-text-muted italic">None configured</p>
        ) : (
          <div className="space-y-0.5">
            {hostingConns.map(conn => (
              <div key={conn.id} className="flex items-center gap-1.5 px-3 py-1 text-xs">
                <CheckCircle2 size={12} className="text-green-400 flex-shrink-0" />
                <span className="text-monastery-text-secondary truncate">{serviceLabel(conn.service_type)}</span>
                <span className="text-[10px] text-monastery-text-muted truncate">{conn.base_url}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick link to Settings */}
      <div className="pt-1 border-t border-monastery-dark-border">
        <p className="px-1 text-[10px] text-monastery-text-muted italic">
          Manage connections in Settings
        </p>
      </div>
    </div>
  );
}

interface FileTreeItemProps {
  node: FileNode;
  depth: number;
  onSelectFile: (path: string) => void;
}

function FileTreeItem({ node, depth, onSelectFile }: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const isDirectory = node.type === 'directory';

  return (
    <div>
      <button
        onClick={() => isDirectory ? setIsExpanded(!isExpanded) : onSelectFile(node.path)}
        className="w-full flex items-center gap-1.5 px-2 py-1 hover:bg-monastery-dark-surface rounded-md transition-colors text-sm"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isDirectory && (
          <span className="text-monastery-text-muted">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        )}
        
        {isDirectory ? (
          <Folder size={14} className="text-monastery-pine" />
        ) : (
          <FileCode size={14} className="text-monastery-text-secondary" />
        )}
        
        <span className="truncate">{node.name}</span>
        
        {node.syncStatus && node.syncStatus !== 'synced' && (
          <span
            className={`ml-auto w-2 h-2 rounded-full ${
              node.syncStatus === 'modified'
                ? 'bg-status-warning'
                : node.syncStatus === 'new'
                ? 'bg-status-success'
                : 'bg-monastery-text-muted'
            }`}
            title={node.syncStatus}
          />
        )}
      </button>
      
      {isDirectory && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface SidebarProps {
  files?: FileNode[];
  onSelectFile: (path: string) => void;
  // Session props
  sessions?: SessionInfo[];
  currentSessionId?: string | null;
  isLoadingSessions?: boolean;
  onCreateSession?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
}

export function Sidebar({ 
  files = [], 
  onSelectFile,
  sessions = [],
  currentSessionId = null,
  isLoadingSessions = false,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
}: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'files' | 'sessions' | 'agents' | 'integrations'>('files');

  const tabs = [
    { id: 'files', label: 'Files', icon: Folder },
    { id: 'sessions', label: 'Sessions', icon: MessageSquare },
    { id: 'agents', label: 'Agents', icon: Bot },
    { id: 'integrations', label: 'Integrations', icon: Server },
  ] as const;

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 7) return `${diffDays}d ago`;
      return d.toLocaleDateString();
    } catch {
      return dateStr;
    }
  };

  return (
    <aside className="w-64 bg-monastery-dark-bg border-r border-monastery-dark-border flex flex-col shrink-0">
      {/* Tabs */}
      <div className="flex border-b border-monastery-dark-border">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-monastery-lantern border-b-2 border-monastery-lantern'
                  : 'text-monastery-text-secondary hover:text-monastery-text-primary'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto py-2">
        {activeTab === 'files' && (
          <div>
            {files.length > 0 ? (
              files.map((node) => (
                <FileTreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  onSelectFile={onSelectFile}
                />
              ))
            ) : (
              <div className="px-4 py-8 text-center text-monastery-text-muted text-sm">
                No files yet. Start a new project or open an existing one.
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'sessions' && (
          <div className="flex flex-col h-full">
            {/* New Session Button */}
            <div className="px-3 pb-2">
              <button
                onClick={onCreateSession}
                disabled={!onCreateSession}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm bg-monastery-dark-surface hover:bg-monastery-dark-tertiary border border-monastery-dark-border rounded-lg transition-colors text-monastery-text-primary disabled:opacity-50"
              >
                <Plus size={14} />
                New Session
              </button>
            </div>

            {/* Session List */}
            {isLoadingSessions ? (
              <div className="flex items-center justify-center py-8 text-monastery-text-muted">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : sessions.length > 0 ? (
              <div className="space-y-0.5 px-2">
                {sessions.map((session) => (
                  <div
                    key={session.id}
                    className={`group flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer transition-colors ${
                      currentSessionId === session.id
                        ? 'bg-monastery-dark-tertiary text-monastery-text-primary'
                        : 'hover:bg-monastery-dark-surface text-monastery-text-secondary'
                    }`}
                    onClick={() => onSelectSession?.(session.id)}
                  >
                    <MessageSquare size={14} className="shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{session.title}</div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-xs text-monastery-text-muted">
                          {formatDate(session.updated_at)}
                        </span>
                        {session.message_count > 0 && (
                          <span className="text-xs text-monastery-text-muted">
                            • {session.message_count} msgs
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession?.(session.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded transition-all"
                      title="Delete session"
                    >
                      <Trash2 size={12} className="text-red-400" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-4 py-8 text-center text-monastery-text-muted text-sm">
                No chat sessions yet. Start a new session to begin.
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'agents' && (
          <AgentsTab />
        )}
        
        {activeTab === 'integrations' && (
          <IntegrationsStatus />
        )}
      </div>
    </aside>
  );
}
