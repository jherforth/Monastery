import { useState } from 'react';
import { FolderGit2, Brain, Settings, ChevronLeft, ChevronRight, GitBranch, ArrowUp, ArrowDown, Monitor, MonitorOff, Sun, Moon, ChevronDown, Cpu, Upload, Plus, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { SettingsModal } from './SettingsModal';
import { useGitForge } from '../hooks/useGitForge';
import { useSnapshots } from '../hooks/useSnapshots';
import type { EndpointConfig } from '../hooks/useEndpoints';

interface TopBarProps {
  availableProjects?: Array<{ id: string; name: string; description?: string | null }>;
  endpoints?: EndpointConfig[];
  onRefreshProjects?: () => void;
  onCommitComplete?: (message: string, snapshotId?: string, wasRestore?: boolean) => void;
  onRestoreComplete?: () => void;
  onOpenWizard?: () => void;
  /** Called after a successful pull so the app can reload files + LLM context. */
  onPullComplete?: (message: string) => void;
}

export function TopBar({ availableProjects = [], endpoints = [], onRefreshProjects, onCommitComplete, onRestoreComplete, onOpenWizard, onPullComplete }: TopBarProps) {
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
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDesc, setNewProjectDesc] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [llmDropdownOpen, setLlmDropdownOpen] = useState(false);
  const [gitDropdownOpen, setGitDropdownOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const lastRestoredSnapshotId = useAppStore(s => s.lastRestoredSnapshotId);
  const setLastRestoredSnapshotId = useAppStore(s => s.setLastRestoredSnapshotId);
  const { gitStatus, pullProject } = useGitForge(currentProject?.id);
  const { listSnapshots, restoreSnapshot } = useSnapshots();

  // Fetch snapshots when git dropdown opens
  const handleGitDropdownToggle = async () => {
    if (!gitDropdownOpen && currentProject?.id) {
      const result = await listSnapshots();
      if (result?.snapshots) setSnapshots(result.snapshots);
    }
    setGitDropdownOpen(!gitDropdownOpen);
  };

  const handleRestoreSnapshot = async (snapshotId: string) => {
    setRestoringId(snapshotId);
    try {
      await restoreSnapshot(snapshotId, { create_backup: true });
      setLastRestoredSnapshotId(snapshotId);
      setGitDropdownOpen(false);
      onRestoreComplete?.();
    } catch (e) {
      console.error('Restore failed:', e);
    } finally {
      setRestoringId(null);
    }
  };

  // Delete a project: wipes the local directory (so a git repo/branch can be re-cloned
  // fresh) plus its sessions and snapshots. Asks for explicit confirmation first.
  const handleDeleteProject = async (proj: { id: string; name: string }) => {
    const confirmed = window.confirm(
      `Delete project "${proj.name}"?\n\nThis permanently removes its local files, chat sessions, and snapshots. ` +
      `Anything pushed to a git remote is unaffected — you can clone it again afterwards.`
    );
    if (!confirmed) return;
    setDeletingProjectId(proj.id);
    try {
      const res = await fetch(`/api/projects/${proj.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Failed to delete project: ${err.error || res.statusText}`);
        return;
      }
      if (currentProject?.id === proj.id) setCurrentProject(null);
      onRefreshProjects?.();
    } catch (e: any) {
      alert(`Failed to delete project: ${e?.message || e}`);
    } finally {
      setDeletingProjectId(null);
    }
  };

  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name) { setCreateError('Project name is required.'); return; }
    setCreatingProject(true); setCreateError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: newProjectDesc.trim() || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to create project' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const proj = await res.json();
      setCurrentProject({ id: proj.id, name: proj.name, path: '', lastOpened: Date.now(), files: [] });
      onRefreshProjects?.();
      setNewProjectOpen(false);
      setNewProjectName('');
      setNewProjectDesc('');
      setProjectDropdownOpen(false);
    } catch (e: any) {
      setCreateError(e.message || 'Failed to create project');
    } finally {
      setCreatingProject(false);
    }
  };

  const handleCommitPush = async () => {
    if (!currentProject?.id) return;
    setCommitting(true);
    const wasRestore = !!lastRestoredSnapshotId;
    try {
      const res = await fetch(`/api/git/commit-push?project_id=${encodeURIComponent(currentProject.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: wasRestore ? 'Restore from snapshot' : 'Update from Monastery' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Surface the real reason — e.g. a diverged remote that needs a Pull first — instead of
        // failing silently. The backend returns an actionable message in that case.
        console.error('Commit/push failed:', data.error);
        alert(`Commit & Push failed:\n\n${data.error || 'Unknown error'}`);
      } else {
        onCommitComplete?.(data.message || 'Committed', data.snapshot_id, wasRestore);
        setLastRestoredSnapshotId(null);
      }
    } catch (e) {
      console.error('Commit/push error:', e);
    } finally {
      setCommitting(false);
    }
  };

  const handlePull = async () => {
    if (!currentProject?.id) return;
    setPulling(true);
    try {
      const data = await pullProject();
      onPullComplete?.(data.message || 'Pulled latest changes');
    } catch (e: any) {
      console.error('Pull error:', e);
      alert(`Pull failed:\n\n${e?.message || 'Unknown error'}`);
    } finally {
      setPulling(false);
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
            {/* Project menu — always available, for switching projects and creating new ones */}
            <span className="text-monastery-text-muted">/</span>
            <div className="relative">
              <button
                onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
                className="flex items-center gap-1.5 px-2 py-1 hover:bg-monastery-dark-surface rounded-md transition-colors text-sm"
                title="Switch or create a project"
              >
                <FolderGit2 size={14} />
                <span className={currentProject ? 'text-monastery-text-secondary' : 'text-monastery-text-muted'}>
                  {currentProject?.name || 'Select project'}
                </span>
                <ChevronDown size={12} className="text-monastery-text-muted" />
              </button>

              {/* Project Dropdown */}
              {projectDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setProjectDropdownOpen(false)}
                  />
                  <div className="absolute top-full left-0 mt-1 w-64 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg shadow-xl z-20 py-1 max-h-72 overflow-y-auto">
                    {availableProjects.length === 0 && (
                      <div className="px-3 py-2 text-xs text-monastery-text-muted">No projects yet — create one below.</div>
                    )}
                    {availableProjects.map((proj) => (
                      <div
                        key={proj.id}
                        className={`group flex items-start w-full transition-colors ${
                          currentProject?.id === proj.id
                            ? 'bg-monastery-dark-tertiary text-monastery-text-primary'
                            : 'text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary'
                        }`}
                      >
                        <button
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
                          className="flex-1 min-w-0 text-left px-3 py-2 text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <FolderGit2 size={14} className="text-monastery-text-muted shrink-0" />
                            <span className="truncate">{proj.name}</span>
                            {currentProject?.id === proj.id && (
                              <span className="ml-auto w-2 h-2 rounded-full bg-status-success shrink-0" />
                            )}
                          </div>
                          {proj.description && (
                            <div className="text-xs text-monastery-text-muted mt-0.5 truncate pl-6">
                              {proj.description}
                            </div>
                          )}
                        </button>
                        {/* Delete: wipes local files so a repo/branch can be re-cloned fresh */}
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteProject(proj); }}
                          disabled={deletingProjectId === proj.id}
                          className="p-2 mt-1 mr-1 rounded text-monastery-text-muted opacity-0 group-hover:opacity-100 hover:text-status-error hover:bg-monastery-dark-surface transition-all disabled:opacity-50 shrink-0"
                          title={`Delete "${proj.name}" (local files, sessions, and snapshots)`}
                        >
                          <Trash2 size={13} className={deletingProjectId === proj.id ? 'animate-pulse' : ''} />
                        </button>
                      </div>
                    ))}
                    <div className="border-t border-monastery-dark-border mt-1 pt-1">
                      <button
                        onClick={() => { setCreateError(null); setNewProjectOpen(true); setProjectDropdownOpen(false); }}
                        className="w-full text-left px-3 py-2 text-sm text-monastery-lantern hover:bg-monastery-dark-tertiary transition-colors flex items-center gap-2"
                      >
                        <Plus size={14} /> New Project
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
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
                onClick={handleGitDropdownToggle}
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
                    
                    {/* Snapshot History */}
                    {snapshots.length > 0 && (
                      <>
                        <div className="border-t border-monastery-dark-border my-1" />
                        <div className="px-3 py-1 text-xs text-monastery-text-muted font-medium uppercase tracking-wider">
                          History
                        </div>
                        {snapshots.map((snap: any) => (
                          <div key={snap.id} className="flex items-center gap-2 px-3 py-1.5 text-sm text-monastery-text-secondary hover:bg-monastery-dark-tertiary transition-colors">
                            <div className="flex-1 min-w-0">
                              <div className="text-xs truncate">{snap.name}</div>
                              <div className="text-[10px] text-monastery-text-muted">
                                {new Date(snap.created_at).toLocaleString()} · {snap.files_count} files
                              </div>
                            </div>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleRestoreSnapshot(snap.id); }}
                              disabled={restoringId === snap.id}
                              className="px-2 py-0.5 text-[10px] bg-monastery-dark-tertiary hover:bg-monastery-lantern hover:text-monastery-dark-bg rounded transition-colors disabled:opacity-50"
                              title="Revert project to this snapshot"
                            >
                              {restoringId === snap.id ? '...' : 'Revert'}
                            </button>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Pull Button — appears when the branch is behind the remote (another contributor
              pushed). Rebases local edits on top; snapshots first so it's revertible. */}
          {gitStatus && currentProject && gitStatus.behind > 0 && (
            <button
              onClick={handlePull}
              disabled={pulling}
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-monastery-dark-surface border border-amber-500/40 hover:border-amber-400 text-amber-300 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
              title={`origin/${gitStatus.branch} has ${gitStatus.behind} new commit(s) — pull them into your local copy`}
            >
              {pulling ? (
                <span className="w-3 h-3 border border-amber-300 border-t-transparent rounded-full animate-spin" />
              ) : (
                <ArrowDown size={12} />
              )}
              {pulling ? 'Pulling...' : `Pull ${gitStatus.behind}`}
            </button>
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
            onClick={onOpenWizard}
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

      {/* New Project modal */}
      {newProjectOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => { if (!creatingProject) setNewProjectOpen(false); }}
        >
          <div
            className="bg-monastery-dark-surface rounded-lg w-full max-w-sm p-5 shadow-xl border border-monastery-dark-border"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <FolderGit2 size={16} className="text-monastery-lantern" /> New Project
            </h3>
            <label className="block text-xs text-monastery-text-secondary mb-1">Name</label>
            <input
              autoFocus
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject(); }}
              placeholder="my-app"
              className="w-full mb-3 px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-sm text-monastery-text-primary placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
            />
            <label className="block text-xs text-monastery-text-secondary mb-1">Description (optional)</label>
            <input
              value={newProjectDesc}
              onChange={(e) => setNewProjectDesc(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject(); }}
              placeholder="What is this project?"
              className="w-full mb-3 px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-sm text-monastery-text-primary placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
            />
            {createError && <p className="text-xs text-red-400 mb-2">{createError}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setNewProjectOpen(false)}
                disabled={creatingProject}
                className="px-3 py-1.5 text-sm text-monastery-text-secondary hover:text-monastery-text-primary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                disabled={creatingProject || !newProjectName.trim()}
                className="px-3 py-1.5 text-sm bg-monastery-pine text-white rounded-lg hover:bg-monastery-forest disabled:opacity-50 flex items-center gap-1.5"
              >
                {creatingProject ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
