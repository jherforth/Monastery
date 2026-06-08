import { useState } from 'react';
import { FolderGit2, Brain, Settings, ChevronLeft, ChevronRight, GitBranch, ArrowUp, ArrowDown, Monitor, MonitorOff, Sun, Moon, ChevronDown, Cpu, Upload } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { SettingsModal } from './SettingsModal';
import { useGitForge } from '../hooks/useGitForge';
import type { EndpointConfig } from '../hooks/useEndpoints';

interface TopBarProps {
  availableProjects?: Array<{ id: string; name: string; description?: string | null }>;
  endpoints?: EndpointConfig[];
  onRefreshProjects?: () => void;
}

export function TopBar({ availableProjects = [], endpoints = [], onRefreshProjects }: TopBarProps) {
  const { 
    currentProject,
    setCurrentProject,
    activeEndpoint, 
    resourceUsage, 
    toggleSidebar,
    togglePreview,
    sidebarCollapsed,
    previewCollapsed,
    theme,
    setTheme,
    setActiveEndpoint,
  } = useAppStore();
  
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [llmDropdownOpen, setLlmDropdownOpen] = useState(false);
  const [gitDropdownOpen, setGitDropdownOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const { gitStatus } = useGitForge(currentProject?.id);

  const handleCommitPush = async () => {
    if (!currentProject?.id) return;
    setCommitting(true);
    try {
      const res = await fetch(`/api/git/commit-push?project_id=${encodeURIComponent(currentProject.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Update from Monastery' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        console.error('Commit/push failed:', err.error);
      }
    } catch (e) {
      console.error('Commit/push error:', e);
    } finally {
      setCommitting(false);
    }
  };

  // Derive clean repo name by stripping known branch suffix
  const getRepoName = () => {
    if (!currentProject || !gitStatus?.branch || gitStatus.branch === 'unknown') {
      return currentProject?.name || '';
    }
    const suffix = `-${gitStatus.branch}`;
    if (currentProject.name.endsWith(suffix)) {
      return currentProject.name.slice(0, -suffix.length);
    }
    return currentProject.name;
  };
  
  return (
    <>
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
            <img
              src={theme === 'monastery-dark' ? '/images/logoDark.svg' : '/images/logoLight.svg'}
              alt="Monastery"
              className="w-8 h-8"
            />
            <span className="font-semibold text-lg">Monastery</span>
            {currentProject && (
              <>
                <span className="text-monastery-text-muted">/</span>
                <div className="relative">
                  <button
                    onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
                    className="flex items-center gap-1.5 px-2 py-1 hover:bg-monastery-dark-surface rounded-md transition-colors text-sm"
                  >
                    <FolderGit2 size={14} />
                    <span className="text-monastery-text-secondary">{currentProject.name}</span>
                    {availableProjects.length > 1 && (
                      <ChevronDown size={12} className="text-monastery-text-muted" />
                    )}
                  </button>
                  
                  {/* Project Dropdown */}
                  {projectDropdownOpen && availableProjects.length > 1 && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setProjectDropdownOpen(false)}
                      />
                      <div className="absolute top-full left-0 mt-1 w-64 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg shadow-xl z-20 py-1 max-h-60 overflow-y-auto">
                        {availableProjects.map((proj) => (
                          <button
                            key={proj.id}
                            onClick={() => {
                              setCurrentProject({
                                id: proj.id,
                                name: proj.name,
                                path: '',
                                lastOpened: Date.now(),
                                files: [],
                              });
                              setProjectDropdownOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                              currentProject?.id === proj.id
                                ? 'bg-monastery-dark-tertiary text-monastery-text-primary'
                                : 'text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <FolderGit2 size={14} className="text-monastery-text-muted shrink-0" />
                              <span className="truncate">{proj.name}</span>
                            </div>
                            {proj.description && (
                              <div className="text-xs text-monastery-text-muted mt-0.5 truncate pl-6">
                                {proj.description}
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Center: LLM Selector + Git Status */}
        <div className="flex items-center gap-3">
          {/* LLM Endpoint Selector */}
          {endpoints.length > 0 ? (
            <div className="relative">
              <button
                onClick={() => setLlmDropdownOpen(!llmDropdownOpen)}
                className="flex items-center gap-2 px-3 py-1.5 bg-monastery-dark-surface rounded-lg border border-monastery-dark-border hover:border-monastery-lantern transition-colors"
              >
                <Brain size={16} className={activeEndpoint ? 'text-pink-400' : 'text-monastery-text-muted'} />
                <span className="text-sm font-medium text-monastery-text-primary">
                  {activeEndpoint?.name || 'Select LLM'}
                </span>
                {endpoints.length > 1 && (
                  <ChevronDown size={12} className="text-monastery-text-muted" />
                )}
              </button>
              
              {llmDropdownOpen && endpoints.length > 1 && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setLlmDropdownOpen(false)} />
                  <div className="absolute top-full right-0 mt-1 w-64 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg shadow-xl z-20 py-1">
                    {endpoints.map((ep) => (
                      <button
                        key={ep.id}
                        onClick={() => {
                          setActiveEndpoint({ id: ep.id, name: ep.name });
                          setLlmDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                          activeEndpoint?.id === ep.id
                            ? 'bg-monastery-dark-tertiary text-monastery-text-primary'
                            : 'text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary'
                        }`}
                      >
                        <Cpu size={14} className="text-monastery-text-muted shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="truncate">{ep.name}</div>
                          <div className="text-xs text-monastery-text-muted truncate">{ep.base_url}</div>
                        </div>
                        {activeEndpoint?.id === ep.id && (
                          <div className="w-2 h-2 rounded-full bg-status-success shrink-0" />
                        )}
                      </button>
                    ))}
                    <div className="border-t border-monastery-dark-border mt-1 pt-1 px-1">
                      <button
                        onClick={() => { setIsSettingsOpen(true); setLlmDropdownOpen(false); }}
                        className="w-full text-left px-3 py-1.5 text-xs text-monastery-text-secondary hover:text-monastery-text-primary hover:bg-monastery-dark-tertiary rounded transition-colors flex items-center gap-2"
                      >
                        <Settings size={12} />
                        Manage endpoints...
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="px-3 py-1.5 bg-monastery-dark-surface rounded-lg border border-monastery-dark-border hover:border-monastery-lantern transition-colors"
              title="Click to configure LLM endpoint"
            >
              <span className="text-sm text-monastery-text-muted">No LLM connected • Click to configure</span>
            </button>
          )}

          {/* Git Status Indicator */}
          {gitStatus && currentProject && (
            <div className="relative">
              <button
                onClick={() => setGitDropdownOpen(!gitDropdownOpen)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-monastery-dark-surface rounded-lg border border-monastery-dark-border hover:border-monastery-pine transition-colors"
                title={`Branch: ${gitStatus.branch}\nAhead: ${gitStatus.ahead}, Behind: ${gitStatus.behind}\nFiles changed: ${gitStatus.changed_files.length}`}
              >
                <GitBranch size={14} className={gitStatus.is_clean ? 'text-green-400' : 'text-amber-400'} />
                <span className="text-xs text-monastery-text-secondary">
                  {getRepoName()}
                </span>
                <span className="text-monastery-text-muted text-xs">•</span>
                <span className="text-xs text-monastery-text-secondary font-medium">{gitStatus.branch}</span>
                {!gitStatus.is_clean && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" title={`${gitStatus.changed_files.length} changed files`} />
                )}
                {gitStatus.ahead > 0 && (
                  <span className="flex items-center text-xs text-green-400">
                    <ArrowUp size={10} />{gitStatus.ahead}
                  </span>
                )}
                {gitStatus.behind > 0 && (
                  <span className="flex items-center text-xs text-amber-400">
                    <ArrowDown size={10} />{gitStatus.behind}
                  </span>
                )}
                {availableProjects.length > 1 && (
                  <ChevronDown size={12} className="text-monastery-text-muted" />
                )}
              </button>

              {/* Project Switcher Dropdown */}
              {gitDropdownOpen && availableProjects.length > 1 && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setGitDropdownOpen(false)} />
                  <div className="absolute top-full right-0 mt-1 w-64 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg shadow-xl z-20 py-1 max-h-60 overflow-y-auto">
                    {availableProjects.map((proj) => {
                      const isActive = currentProject?.id === proj.id;
                      return (
                        <button
                          key={proj.id}
                          onClick={() => {
                            setCurrentProject({
                              id: proj.id,
                              name: proj.name,
                              path: '',
                              lastOpened: Date.now(),
                              files: [],
                            });
                            setGitDropdownOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                            isActive
                              ? 'bg-monastery-dark-tertiary text-monastery-text-primary'
                              : 'text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary'
                          }`}
                        >
                          <GitBranch size={14} className="text-monastery-text-muted shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="truncate">{proj.name}</div>
                            {proj.description && (
                              <div className="text-xs text-monastery-text-muted truncate">{proj.description}</div>
                            )}
                          </div>
                          {isActive && (
                            <div className="w-2 h-2 rounded-full bg-status-success shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Commit & Push Button */}
          {gitStatus && currentProject && !gitStatus.is_clean && (
            <button
              onClick={handleCommitPush}
              disabled={committing}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-monastery-pine hover:bg-monastery-forest text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
              title="Commit all changes and push to remote"
            >
              {committing ? (
                <span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Upload size={12} />
              )}
              {committing ? 'Pushing...' : 'Commit & Push'}
            </button>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {/* Preview Toggle */}
          <button
            onClick={togglePreview}
            className="p-2 hover:bg-monastery-dark-surface rounded-lg transition-colors"
            title={previewCollapsed ? 'Show preview pane' : 'Hide preview pane'}
          >
            {previewCollapsed ? <Monitor size={18} /> : <MonitorOff size={18} />}
          </button>

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
            onClick={() => setTheme(theme === 'monastery-dark' ? 'scriptorium-light' : 'monastery-dark')}
            className="p-2 hover:bg-monastery-dark-surface rounded-lg transition-colors"
            title={theme === 'monastery-dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'monastery-dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 hover:bg-monastery-dark-surface rounded-lg transition-colors"
            title="Settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>

      <SettingsModal isOpen={isSettingsOpen} onClose={() => { setIsSettingsOpen(false); onRefreshProjects?.(); }} />
    </>
  );
}
