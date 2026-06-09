import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useState, useEffect } from 'react';
import { Terminal as TerminalIcon, Eye, GitCompare, RefreshCw } from 'lucide-react';

interface PreviewPaneProps {
  projectId?: string | null;
}

export function PreviewPane({ projectId }: PreviewPaneProps) {
  const [selectedTab, setSelectedTab] = useState<'preview' | 'terminal' | 'diff'>('preview');
  const [previewUrl, setPreviewUrl] = useState('about:blank');
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    if (projectId) {
      setPreviewUrl(`/api/projects/${projectId}/preview/index.html`);
    } else {
      setPreviewUrl('about:blank');
    }
  }, [projectId]);

  return (
    <PanelGroup direction="vertical" className="h-full">
      {/* Main Content */}
      <Panel defaultSize={70} minSize={20}>
        <div className="h-full bg-monastery-dark-bg">
          {selectedTab === 'preview' && (
            <div className="h-full flex flex-col">
              <div className="flex items-center justify-between px-3 py-2 border-b border-monastery-dark-border bg-monastery-dark-surface">
                <div className="flex items-center gap-2">
                  <Eye size={14} className="text-monastery-text-secondary" />
                  <span className="text-xs font-medium text-monastery-text-secondary">
                    {projectId ? 'Live Preview' : 'Preview (no project)'}
                  </span>
                </div>
                <button
                  onClick={() => setPreviewKey(k => k + 1)}
                  className="p-1.5 hover:bg-monastery-dark-tertiary rounded transition-colors"
                  title="Refresh preview"
                >
                  <RefreshCw size={14} className="text-monastery-lantern" />
                </button>
              </div>
              <iframe
                key={previewKey}
                src={previewUrl}
                className="flex-1 w-full bg-white"
                title="Preview"
                sandbox="allow-scripts allow-same-origin"
              />
            </div>
          )}

          {selectedTab === 'terminal' && (
            <div className="h-full flex flex-col">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-monastery-dark-border bg-monastery-dark-surface">
                <TerminalIcon size={14} className="text-monastery-text-secondary" />
                <span className="text-xs font-medium text-monastery-text-secondary">Terminal</span>
              </div>
              <div className="flex-1 p-4 font-mono text-sm text-monastery-text-primary overflow-auto">
                <div className="text-monastery-text-muted">$ npm run dev</div>
                <div className="mt-2 text-status-success">✓ Ready in 234ms</div>
                <div className="mt-1 text-monastery-text-secondary">➜  Local:   http://localhost:3000</div>
                <div className="animate-pulse mt-1">_</div>
              </div>
            </div>
          )}

          {selectedTab === 'diff' && (
            <div className="h-full flex flex-col">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-monastery-dark-border bg-monastery-dark-surface">
                <GitCompare size={14} className="text-monastery-text-secondary" />
                <span className="text-xs font-medium text-monastery-text-secondary">Diff View</span>
              </div>
              <div className="flex-1 p-4 font-mono text-sm">
                <div className="text-monastery-text-muted">// AI-proposed changes will appear here</div>
                <div className="mt-4 p-3 bg-red-900/20 border-l-2 border-status-error">
                  <code className="text-status-error">- const old = "value";</code>
                </div>
                <div className="mt-1 p-3 bg-green-900/20 border-l-2 border-status-success">
                  <code className="text-status-success">+ const newValue = "updated";</code>
                </div>
              </div>
            </div>
          )}
        </div>
      </Panel>

      <PanelResizeHandle className="h-1 bg-monastery-dark-border hover:bg-monastery-lantern transition-colors" />

      {/* Output/Console */}
      <Panel defaultSize={30} minSize={10}>
        <div className="h-full bg-monastery-dark-surface border-t border-monastery-dark-border flex flex-col">
          <div className="flex items-center gap-4 px-3 py-2 border-b border-monastery-dark-border">
            <button
              onClick={() => setSelectedTab('preview')}
              className={`text-xs font-medium transition-colors ${
                selectedTab === 'preview'
                  ? 'text-monastery-lantern'
                  : 'text-monastery-text-secondary hover:text-monastery-text-primary'
              }`}
            >
              Preview
            </button>
            <button
              onClick={() => setSelectedTab('terminal')}
              className={`text-xs font-medium transition-colors ${
                selectedTab === 'terminal'
                  ? 'text-monastery-lantern'
                  : 'text-monastery-text-secondary hover:text-monastery-text-primary'
              }`}
            >
              Terminal
            </button>
            <button
              onClick={() => setSelectedTab('diff')}
              className={`text-xs font-medium transition-colors ${
                selectedTab === 'diff'
                  ? 'text-monastery-lantern'
                  : 'text-monastery-text-secondary hover:text-monastery-text-primary'
              }`}
            >
              Diff
            </button>
          </div>
          <div className="flex-1 p-3 overflow-auto">
            <div className="text-xs text-monastery-text-secondary font-mono">
              <div className="flex items-center gap-2">
                <span className="text-status-success">●</span>
                <span>Server running on port 8080</span>
              </div>
              <div className="mt-1 text-monastery-text-muted">
                [info] Connected to LLM endpoint
              </div>
            </div>
          </div>
        </div>
      </Panel>
    </PanelGroup>
  );
}
