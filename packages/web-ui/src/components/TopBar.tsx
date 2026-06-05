import { Archive, FolderGit2, Bot, Plug, Settings, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

export function TopBar() {
  const { 
    currentProject, 
    activeEndpoint, 
    resourceUsage, 
    toggleSidebar,
    sidebarCollapsed 
  } = useAppStore();

  return (
    <header className="h-14 bg-monastery-dark-bg border-b border-monastery-dark-border flex items-center justify-between px-4 shrink-0">
      {/* Left: Logo + Project */}
      <div className="flex items-center gap-3">
        <button
          onClick={toggleSidebar}
          className="p-2 hover:bg-monastery-dark-surface rounded-lg transition-colors"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
        
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-monastery-forest rounded-lg flex items-center justify-center">
            <Archive size={18} className="text-monastery-lantern" />
          </div>
          <span className="font-semibold text-lg">Monastery</span>
          {currentProject && (
            <>
              <span className="text-monastery-text-muted">/</span>
              <button className="flex items-center gap-1.5 px-2 py-1 hover:bg-monastery-dark-surface rounded-md transition-colors text-sm">
                <FolderGit2 size={14} />
                <span className="text-monastery-text-secondary">{currentProject.name}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Center: Model Selector */}
      <div className="flex items-center gap-3">
        {activeEndpoint ? (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-monastery-dark-surface rounded-lg border border-monastery-dark-border">
            <div
              className={`w-2 h-2 rounded-full ${
                activeEndpoint.status === 'connected'
                  ? 'bg-status-success'
                  : activeEndpoint.status === 'error'
                  ? 'bg-status-error'
                  : 'bg-status-warning'
              }`}
            />
            <span className="text-sm font-medium">{activeEndpoint.name}</span>
            {activeEndpoint.model && (
              <span className="text-monastery-text-muted text-xs">• {activeEndpoint.model}</span>
            )}
          </div>
        ) : (
          <div className="px-3 py-1.5 bg-monastery-dark-surface rounded-lg border border-monastery-dark-border">
            <span className="text-sm text-monastery-text-muted">No LLM connected</span>
          </div>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        {/* Resource Monitor */}
        {resourceUsage && (
          <div className="flex items-center gap-3 px-3 py-1.5 text-xs text-monastery-text-secondary">
            <span>CPU: {resourceUsage.cpu}%</span>
            <span>RAM: {resourceUsage.memory}%</span>
            {resourceUsage.gpu !== undefined && <span>GPU: {resourceUsage.gpu}%</span>}
          </div>
        )}

        <button
          className="px-3 py-1.5 bg-monastery-pine hover:bg-monastery-forest text-white rounded-lg text-sm font-medium transition-colors"
          title="Self-Host Wizard (Ctrl+Shift+D)"
        >
          Self-Host Wizard
        </button>

        <button
          className="p-2 hover:bg-monastery-dark-surface rounded-lg transition-colors"
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
}
