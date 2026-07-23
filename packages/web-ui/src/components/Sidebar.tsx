import { Folder, FileCode, ChevronRight, ChevronDown, Plus, Trash2, Bot, FilePlus, FolderPlus, Upload, RefreshCw } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { FileNode } from '../types';
import { AgentsTab } from './AgentsTab';

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

  const handleDragLeave = useCallback(() => {
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
}: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'files' | 'agents'>('files');
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
    { id: 'agents', label: 'Agents', icon: Bot },
  ] as const;

  return (
    <aside className="w-64 bg-monastery-dark-bg border-r border-monastery-dark-border flex flex-col shrink-0">
      {/* Tabs */}
      <div className="flex border-b border-monastery-dark-border">
        {tabs.map((tab) => {
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
        
        {activeTab === 'agents' && (
          <AgentsTab />
        )}
      </div>
    </aside>
  );
}
