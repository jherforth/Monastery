import { Folder, FileCode, ChevronRight, ChevronDown, MessageSquare, Plus, Trash2, Loader2, Cpu, GitBranch, Server, Database, CheckCircle2, Bot, FilePlus, FolderPlus, Upload, RefreshCw } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
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
                <CheckCircle2 size={12} className="text-green-400 flex-shrink-0" />
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

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  node: FileNode;
}

interface FileTreeItemProps {
  node: FileNode;
  depth: number;
  onSelectFile: (path: string) => void;
  onDeleteFile?: (path: string) => void;
  onCreateFile?: (parentPath: string) => void;
  onCreateDirectory?: (parentPath: string) => void;
  onDeleteDirectory?: (path: string) => void;
  onMoveFile?: (sourcePath: string, targetDirPath: string) => void;
}

function FileTreeItem({ node, depth, onSelectFile, onDeleteFile, onCreateFile, onCreateDirectory, onDeleteDirectory, onMoveFile }: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, node: node });
  const [isDragOver, setIsDragOver] = useState(false);
  const isDirectory = node.type === 'directory';

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, node });
  }, [node]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, []);

  // Close context menu on any click outside
  useEffect(() => {
    if (!contextMenu.visible) return;
    const handler = () => closeContextMenu();
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu.visible, closeContextMenu]);

  // --- Drag and Drop handlers ---
  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'move';
  }, [node.path]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isDirectory) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, [isDirectory]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!isDirectory) return;

    const sourcePath = e.dataTransfer.getData('text/plain');
    if (!sourcePath || sourcePath === node.path) return; // Can't drop on self

    // Prevent dropping a directory into one of its own descendants
    if (node.path.startsWith(sourcePath + '/')) return;

    onMoveFile?.(sourcePath, node.path);
  }, [isDirectory, node.path, onMoveFile]);

  return (
    <div>
      <button
        draggable
        onClick={() => isDirectory ? setIsExpanded(!isExpanded) : onSelectFile(node.path)}
        onContextMenu={handleContextMenu}
        onDragStart={handleDragStart}
        onDragOver={isDirectory ? handleDragOver : undefined}
        onDragLeave={isDirectory ? handleDragLeave : undefined}
        onDrop={isDirectory ? handleDrop : undefined}
        className={`w-full flex items-center gap-1.5 px-2 py-1 hover:bg-monastery-dark-surface rounded-md transition-colors text-sm ${
          isDragOver ? 'bg-monastery-pine/20 ring-1 ring-monastery-pine' : ''
        }`}
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
      
      {/* Context Menu */}
      {contextMenu.visible && contextMenu.node.path === node.path && (
        <div
          className="fixed z-50 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {isDirectory ? (
            <>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-colors"
                onClick={() => { onCreateDirectory?.(node.path); closeContextMenu(); }}
              >
                <FolderPlus size={14} className="text-monastery-pine" />
                New Directory
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-colors"
                onClick={() => { onCreateFile?.(node.path); closeContextMenu(); }}
              >
                <FilePlus size={14} className="text-monastery-lantern" />
                New File
              </button>
              <div className="border-t border-monastery-dark-border my-0.5" />
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                onClick={() => { onDeleteDirectory?.(node.path); closeContextMenu(); }}
              >
                <Trash2 size={14} />
                Delete Directory
              </button>
            </>
          ) : (
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
              onClick={() => { onDeleteFile?.(node.path); closeContextMenu(); }}
            >
              <Trash2 size={14} />
              Delete File
            </button>
          )}
        </div>
      )}
      
      {isDirectory && isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelectFile={onSelectFile}
              onDeleteFile={onDeleteFile}
              onCreateFile={onCreateFile}
              onCreateDirectory={onCreateDirectory}
              onDeleteDirectory={onDeleteDirectory}
              onMoveFile={onMoveFile}
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
  // File operations (user-initiated, no LLM)
  onDeleteFile?: (path: string) => void;
  onCreateFile?: (parentPath: string) => void;
  onCreateDirectory?: (parentPath: string) => void;
  onDeleteDirectory?: (path: string) => void;
  onUploadFile?: (parentPath: string, file: File) => void;
  onMoveFile?: (sourcePath: string, targetDirPath: string) => void;
  /** Re-read the project files from disk (surfaces changes made outside Monastery, e.g. by Hermes). */
  onRefreshFiles?: () => void;
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
  onDeleteFile,
  onCreateFile,
  onCreateDirectory,
  onDeleteDirectory,
  onUploadFile,
  onMoveFile,
  onRefreshFiles,
  sessions = [],
  currentSessionId = null,
  isLoadingSessions = false,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
}: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'files' | 'sessions' | 'agents' | 'integrations'>('files');
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);

  // Close the create dropdown when clicking outside
  useEffect(() => {
    if (!showCreateMenu) return;
    const handler = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setShowCreateMenu(false);
      }
    };
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [showCreateMenu]);

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
            {/* Files Toolbar */}
            <div className="flex items-center gap-1 px-3 py-1.5 border-b border-monastery-dark-border mb-1">
              <span className="text-xs text-monastery-text-muted flex-1">Files</span>

              {/* Refresh from disk — surfaces files written outside Monastery (e.g. by Hermes) */}
              {onRefreshFiles && (
                <button
                  onClick={onRefreshFiles}
                  className="p-1 hover:bg-monastery-dark-surface rounded transition-colors text-monastery-text-secondary hover:text-monastery-text-primary"
                  title="Refresh files from disk (e.g. changes written by Hermes)"
                >
                  <RefreshCw size={14} />
                </button>
              )}

              {/* Upload button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-1 hover:bg-monastery-dark-surface rounded transition-colors text-monastery-text-secondary hover:text-monastery-text-primary"
                title="Upload file to project"
              >
                <Upload size={14} />
              </button>

              {/* Create dropdown */}
              <div className="relative" ref={createMenuRef}>
                <button
                  onClick={(e) => { e.stopPropagation(); setShowCreateMenu(!showCreateMenu); }}
                  className="p-1 hover:bg-monastery-dark-surface rounded transition-colors text-monastery-text-secondary hover:text-monastery-text-primary"
                  title="Create file or directory"
                >
                  <Plus size={14} />
                </button>
                {showCreateMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg shadow-xl py-1 min-w-[140px] z-50">
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-colors"
                      onClick={() => { onCreateFile?.(''); setShowCreateMenu(false); }}
                    >
                      <FilePlus size={14} className="text-monastery-lantern" />
                      New File
                    </button>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-colors"
                      onClick={() => { onCreateDirectory?.(''); setShowCreateMenu(false); }}
                    >
                      <FolderPlus size={14} className="text-monastery-pine" />
                      New Directory
                    </button>
                  </div>
                )}
              </div>

              {/* Hidden file input for uploads */}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file && onUploadFile) {
                    onUploadFile('', file);
                  }
                  // Reset so the same file can be re-uploaded
                  e.target.value = '';
                }}
              />
            </div>
            {files.length > 0 ? (
              files.map((node) => (
                <FileTreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  onSelectFile={onSelectFile}
                  onDeleteFile={onDeleteFile}
                  onCreateFile={onCreateFile}
                  onCreateDirectory={onCreateDirectory}
                  onDeleteDirectory={onDeleteDirectory}
                  onMoveFile={onMoveFile}
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
