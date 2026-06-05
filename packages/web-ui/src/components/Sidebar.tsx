import { Folder, FileCode, ChevronRight, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { FileNode } from '../types';

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
}

export function Sidebar({ files = [], onSelectFile }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'files' | 'sessions' | 'agents' | 'integrations'>('files');

  const tabs = [
    { id: 'files', label: 'Files', icon: Folder },
    { id: 'sessions', label: 'Sessions', icon: Folder },
    { id: 'agents', label: 'Agents', icon: Folder },
    { id: 'integrations', label: 'Integrations', icon: Folder },
  ] as const;

  return (
    <aside className="w-64 bg-monastery-dark-bg border-r border-monastery-dark-border flex flex-col shrink-0">
      {/* Tabs */}
      <div className="flex border-b border-monastery-dark-border">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-monastery-lantern border-b-2 border-monastery-lantern'
                : 'text-monastery-text-secondary hover:text-monastery-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
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
          <div className="px-4 py-8 text-center text-monastery-text-muted text-sm">
            Chat sessions will appear here
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
