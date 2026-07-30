import { useState, useEffect } from 'react';
import { GitBranch, ArrowUp, ArrowDown, Upload, X, Rocket, History, FileDiff, FolderGit2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useGitForge } from '../hooks/useGitForge';
import { useSnapshots } from '../hooks/useSnapshots';
import { useDialogs } from './ui/dialogs';

interface SourceShipDrawerProps {
  open: boolean;
  onClose: () => void;
  onCommitComplete?: (message: string, snapshotId?: string, wasRestore?: boolean) => void;
  onRestoreComplete?: () => void;
  /** Called after a successful pull so the app can reload files + LLM context. */
  onPullComplete?: (message: string) => void;
  /** Launch the deploy flow (Self-Host Wizard). */
  onOpenWizard?: () => void;
}

/**
 * Source & Ship: the one home for getting work out of the workbench — branch status and
 * changed files, pull / commit & push, the snapshot timeline, and deployment. New ship
 * targets get a row here instead of another top-bar button.
 */
export function SourceShipDrawer({ open, onClose, onCommitComplete, onRestoreComplete, onPullComplete, onOpenWizard }: SourceShipDrawerProps) {
  const currentProject = useAppStore(s => s.currentProject);
  const lastRestoredSnapshotId = useAppStore(s => s.lastRestoredSnapshotId);
  const setLastRestoredSnapshotId = useAppStore(s => s.setLastRestoredSnapshotId);
  const { gitStatus, pullProject } = useGitForge(currentProject?.id);
  const { listSnapshots, restoreSnapshot } = useSnapshots();
  const { notice } = useDialogs();

  const [committing, setCommitting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // Load the snapshot timeline each time the drawer opens.
  useEffect(() => {
    if (!open || !currentProject?.id) return;
    listSnapshots().then(result => {
      if (result?.snapshots) setSnapshots(result.snapshots);
    }).catch(() => {});
  }, [open, currentProject?.id]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

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
        // Surface the real reason — e.g. a diverged remote that needs a Pull first.
        console.error('Commit/push failed:', data.error);
        notice({ title: 'Commit & Push failed', message: String(data.error || 'Unknown error') });
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
      notice({ title: 'Pull failed', message: String(e?.message || 'Unknown error') });
    } finally {
      setPulling(false);
    }
  };

  const handleRestoreSnapshot = async (snapshotId: string) => {
    setRestoringId(snapshotId);
    try {
      await restoreSnapshot(snapshotId, { create_backup: true });
      setLastRestoredSnapshotId(snapshotId);
      onRestoreComplete?.();
    } catch (e) {
      console.error('Restore failed:', e);
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-40 w-[24rem] max-w-full bg-monastery-dark-bg border-l border-monastery-dark-border shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-monastery-dark-border shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-monastery-text-primary">Source &amp; Ship</h3>
            <p className="text-[11px] text-monastery-text-muted">Sync with git, roll back snapshots, deploy.</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-monastery-dark-surface rounded-lg text-monastery-text-secondary" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>

        {/* Fixed column: git status/actions pinned top, Ship pinned bottom — ONLY the
            snapshot list scrolls, so Ship can never be pushed below the fold. */}
        <div className="flex-1 flex flex-col min-h-0 p-4 gap-5">
          {/* Branch & changes */}
          {gitStatus ? (
            <section className="shrink-0">
              <div className="flex items-center gap-2 text-sm text-monastery-text-primary">
                <GitBranch size={14} className={gitStatus.is_clean ? 'text-green-400' : 'text-amber-400'} />
                <span className="font-medium">{gitStatus.branch}</span>
                <span className={`text-xs ${gitStatus.is_clean ? 'text-green-400' : 'text-amber-400'}`}>
                  {gitStatus.is_clean ? 'clean' : `${gitStatus.changed_files.length} changed`}
                </span>
                {gitStatus.ahead > 0 && (
                  <span className="flex items-center text-xs text-green-400"><ArrowUp size={10} />{gitStatus.ahead}</span>
                )}
                {gitStatus.behind > 0 && (
                  <span className="flex items-center text-xs text-amber-400"><ArrowDown size={10} />{gitStatus.behind}</span>
                )}
              </div>
              {gitStatus.changed_files.length > 0 && (
                <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-monastery-dark-border bg-monastery-dark-surface p-2 space-y-0.5">
                  {gitStatus.changed_files.map((f: string) => (
                    <div key={f} className="flex items-center gap-1.5 text-xs text-monastery-text-secondary">
                      <FileDiff size={11} className="text-amber-400 shrink-0" />
                      <span className="truncate">{f}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* No remote yet → the one action that helps is creating the repo. Pull /
                  Commit & Push need a remote and would only error. */}
              {!gitStatus.has_remote && (
                <div className="mt-3">
                  <button
                    onClick={() => {
                      onClose();
                      window.dispatchEvent(new CustomEvent('monastery:open-settings', { detail: { tab: 'git' } }));
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-monastery-dark-border text-monastery-text-secondary hover:border-monastery-pine hover:text-monastery-text-primary transition-colors"
                  >
                    <FolderGit2 size={14} className="text-monastery-lantern" />
                    <span className="flex-1 text-left">Create repo on your forge &amp; push this project</span>
                  </button>
                  <p className="mt-1.5 text-[11px] text-monastery-text-muted">
                    No remote yet. In Git Forges, use the <Upload size={10} className="inline" /> push
                    action on your connection — it creates the repo and pushes this project in one step.
                  </p>
                </div>
              )}

              {/* Sync actions — shown once a remote exists, enabled by state */}
              {gitStatus.has_remote && (
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={handlePull}
                  disabled={pulling || gitStatus.behind === 0}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-monastery-dark-border text-monastery-text-secondary hover:border-amber-400 hover:text-amber-300 transition-colors disabled:opacity-40 disabled:hover:border-monastery-dark-border"
                  title={gitStatus.behind > 0
                    ? `origin/${gitStatus.branch} has ${gitStatus.behind} new commit(s) — pull them in (snapshots first)`
                    : 'Nothing to pull — up to date with the remote'}
                >
                  {pulling
                    ? <span className="w-3 h-3 border border-amber-300 border-t-transparent rounded-full animate-spin" />
                    : <ArrowDown size={13} />}
                  {pulling ? 'Pulling…' : `Pull${gitStatus.behind > 0 ? ` (${gitStatus.behind})` : ''}`}
                </button>
                <button
                  onClick={handleCommitPush}
                  disabled={committing || gitStatus.is_clean}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-monastery-pine hover:bg-monastery-forest text-white font-medium transition-colors disabled:opacity-40"
                  title={gitStatus.is_clean ? 'No local changes to commit' : 'Commit all changes and push to remote'}
                >
                  {committing
                    ? <span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                    : <Upload size={13} />}
                  {committing ? 'Pushing…' : 'Commit & Push'}
                </button>
              </div>
              )}
            </section>
          ) : (
            <div>
              <button
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new CustomEvent('monastery:open-settings', { detail: { tab: 'git' } }));
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-monastery-dark-border text-monastery-text-secondary hover:border-monastery-pine hover:text-monastery-text-primary transition-colors"
              >
                <FolderGit2 size={14} className="text-monastery-lantern" />
                <span className="flex-1 text-left">Create repo on your forge &amp; push this project</span>
              </button>
              <p className="mt-1.5 text-[11px] text-monastery-text-muted">
                This project isn't a git repo yet. The repo doesn't need to exist first — the push
                action on your forge connection creates it and pushes in one step.
              </p>
            </div>
          )}

          {/* Snapshots — the one flexible region; its LIST scrolls internally */}
          <section className="flex-1 flex flex-col min-h-0">
            <h4 className="flex items-center gap-1.5 text-xs font-medium text-monastery-text-secondary uppercase tracking-wider mb-2 shrink-0">
              <History size={12} /> Snapshots
            </h4>
            {snapshots.length === 0 ? (
              <p className="text-xs text-monastery-text-muted italic">
                No snapshots yet. One is taken automatically before every AI edit, pull, and restore.
              </p>
            ) : (
              <div className="space-y-1 overflow-y-auto min-h-0">
                {snapshots.map((snap: any) => (
                  <div key={snap.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-monastery-dark-surface transition-colors text-sm text-monastery-text-secondary">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs truncate">{snap.name}</div>
                      <div className="text-[11px] text-monastery-text-muted">
                        {new Date(snap.created_at).toLocaleString()} · {snap.files_count} files
                      </div>
                    </div>
                    <button
                      onClick={() => handleRestoreSnapshot(snap.id)}
                      disabled={restoringId === snap.id}
                      className="px-2 py-0.5 text-[11px] bg-monastery-dark-tertiary hover:bg-monastery-lantern hover:text-monastery-dark-bg rounded transition-colors disabled:opacity-50 shrink-0"
                      title="Revert project to this snapshot"
                    >
                      {restoringId === snap.id ? '...' : 'Revert'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Ship — pinned to the drawer bottom, always visible */}
          {onOpenWizard && (
            <section className="border-t border-monastery-dark-border pt-4 shrink-0 mt-auto">
              <h4 className="flex items-center gap-1.5 text-xs font-medium text-monastery-text-secondary uppercase tracking-wider mb-2">
                <Rocket size={12} /> Ship
              </h4>
              <button
                onClick={() => { onClose(); onOpenWizard(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-monastery-dark-border text-monastery-text-secondary hover:border-monastery-pine hover:text-monastery-text-primary transition-colors"
              >
                <Rocket size={14} className="text-monastery-lantern" />
                <span className="flex-1 text-left">Deploy with the Self-Host Wizard</span>
              </button>
              <p className="mt-1.5 text-[11px] text-monastery-text-muted">
                Builds and deploys this project to your Dokploy or Coolify instance (Ctrl+Shift+D).
              </p>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
