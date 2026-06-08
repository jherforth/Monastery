import { Folder, FileCode, ChevronRight, ChevronDown, MessageSquare, Plus, Trash2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { FileNode, SessionInfo, SessionDetail } from '../types';

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
    { id: 'agents', label: 'Agents', icon: Folder },
    { id: 'integrations', label: 'Integrations', icon: Folder },
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
          <div className="px-4 py-8 text-center text-monastery-text-muted text-sm">
            Agents & tools library
          </div>
        )}
        
        {activeTab === 'integrations' && (
          <div className="px-4 py-8 text-center text-monastery-text-muted text-sm">
            Homelab integrations (Proxmox, Coolify, etc.)
          </div>
        )}
      </div>
    </aside>
  );
}
