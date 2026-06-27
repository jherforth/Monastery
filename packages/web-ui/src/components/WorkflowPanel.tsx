import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Play, Bot, FlaskConical, CheckCircle2, XCircle, Loader2, ArrowRight, X } from 'lucide-react';
import { useWorkflow, STAGES, specHasAcDod, latestVerify, type Stage } from '../hooks/useWorkflow';
import { availableTemplates, getTemplate, type TaskTemplateContext } from '../lib/taskTemplates';

const HINT_KEY = 'monastery.workflowHintSeen';

interface WorkflowPanelProps {
  projectId?: string;
  workflow: ReturnType<typeof useWorkflow>;
  /** Run a stage through the chat flow (preferHermes hands it to the Hermes agent). */
  onRunStage: (stage: Stage) => void;
  onHandToHermes: (stage: Stage) => void;
  hermesAvailable: boolean;
  /** Enable skills suggested by a task template (e.g. Pocketbase). */
  onApplySkills?: (skillIds: string[]) => void;
  /** Context for filtering which templates are offered. */
  templateCtx: TaskTemplateContext;
}

const STAGE_LABEL: Record<Stage, string> = {
  plan: '🏗️ Plan', implement: '💻 Implement', verify: '🧪 Verify', review: '🔍 Review', done: '✅ Done',
};

export function WorkflowPanel({ projectId, workflow, onRunStage, onHandToHermes, hermesAvailable, onApplySkills, templateCtx }: WorkflowPanelProps) {
  const { tasks, activeTask, spec, setSpec, createTask, loadTask, patchTask, verify, recordExit, refresh } = workflow;
  const [open, setOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [templateId, setTemplateId] = useState('feature');
  const [busy, setBusy] = useState<string | null>(null);
  const [verifyOut, setVerifyOut] = useState<string | null>(null);
  const [hintSeen, setHintSeen] = useState(() => {
    try { return !!localStorage.getItem(HINT_KEY); } catch { return true; }
  });
  const dismissHint = () => {
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ }
    setHintSeen(true);
  };

  if (!projectId) return null;

  const templates = availableTemplates(templateCtx);

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setBusy('create');
    try {
      const tmpl = getTemplate(templateId);
      const t = await createTask(title, undefined, tmpl?.spec(title));
      await loadTask(t.id);
      if (tmpl?.suggestedSkills?.length) onApplySkills?.(tmpl.suggestedSkills);
      setNewTitle('');
    } finally { setBusy(null); }
  };

  const gateReady = specHasAcDod(spec);
  const verified = latestVerify(activeTask)?.status === 'complete';
  const stage: Stage = activeTask?.stage || 'plan';

  const saveSpec = async () => {
    if (!activeTask) return;
    setBusy('spec');
    try { await patchTask(activeTask.id, { spec }); } finally { setBusy(null); }
  };

  const runVerify = async () => {
    if (!activeTask) return;
    setBusy('verify'); setVerifyOut(null);
    try {
      const r = await verify(activeTask.id, activeTask.verify_command || undefined);
      setVerifyOut(`${r.passed ? '✅ passed' : '❌ failed'} (exit ${r.exit_code})\n\n${r.log}`);
    } catch (e: any) {
      setVerifyOut(`⚠️ ${e.message || 'verify failed'}`);
    } finally { setBusy(null); }
  };

  const advance = async (from: Stage, exitState: string, next: Stage) => {
    if (!activeTask) return;
    setBusy('advance');
    try { await recordExit(activeTask.id, { stage: from, status: 'complete', exit_state: exitState }, next); }
    finally { setBusy(null); }
  };

  return (
    <div className="border-b border-monastery-dark-border bg-monastery-dark-bg">
      {/* Collapsed strip */}
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-4 py-2 text-xs text-monastery-text-secondary hover:text-monastery-text-primary">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">🛠 Workflow</span>
        {activeTask ? (
          <span className="text-monastery-text-muted truncate">· {activeTask.title} · <span className="text-monastery-lantern">{STAGE_LABEL[stage]}</span></span>
        ) : (
          <span className="text-monastery-text-muted">· no active task</span>
        )}
      </button>

      {/* First-use hint — shown once, only when there are no tasks yet. */}
      {!open && tasks.length === 0 && !hintSeen && (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-monastery-lantern/40 bg-monastery-lantern/10 px-3 py-2 text-[11px] text-monastery-text-secondary">
          <span className="flex-1">
            <span className="text-monastery-lantern font-medium">New — structured tasks.</span>{' '}
            Drive coding as <b>Plan → Implement → Verify → Review</b> with a spec, gates, and a scoped
            (token-frugal) context. Click <b>🛠 Workflow</b> above to start one.
          </span>
          <button onClick={dismissHint} className="shrink-0 hover:text-monastery-text-primary" title="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}

      {open && (
        <div className="px-4 pb-3 space-y-3">
          {/* Task selector + create */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={activeTask?.id || ''}
              onChange={(e) => e.target.value && loadTask(e.target.value)}
              className="bg-monastery-dark-surface border border-monastery-dark-border rounded-lg px-2 py-1 text-xs max-w-[220px]"
            >
              <option value="">— select task —</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.title} ({t.stage})</option>)}
            </select>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="New task title"
              className="flex-1 min-w-[140px] bg-monastery-dark-surface border border-monastery-dark-border rounded-lg px-2 py-1 text-xs"
            />
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              title="Task template — seeds the spec"
              className="bg-monastery-dark-surface border border-monastery-dark-border rounded-lg px-2 py-1 text-xs"
            >
              {templates.map((t) => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
            </select>
            <button
              type="button"
              disabled={!newTitle.trim() || busy === 'create'}
              onClick={handleCreate}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-monastery-lantern text-monastery-dark-bg font-medium disabled:opacity-50"
            >
              <Plus size={12} /> New
            </button>
          </div>

          {activeTask && (
            <>
              {/* Stage stepper */}
              <div className="flex items-center gap-1 text-[11px] flex-wrap">
                {STAGES.map((s, i) => (
                  <span key={s} className="flex items-center gap-1">
                    <span className={`px-1.5 py-0.5 rounded ${s === stage ? 'bg-monastery-lantern text-monastery-dark-bg font-medium' : 'text-monastery-text-muted'}`}>{STAGE_LABEL[s]}</span>
                    {i < STAGES.length - 1 && <ChevronRight size={10} className="text-monastery-text-muted" />}
                  </span>
                ))}
              </div>

              {/* Gate badges */}
              <div className="flex items-center gap-3 text-[11px]">
                <span className={gateReady ? 'text-green-400' : 'text-amber-400'}>
                  {gateReady ? <CheckCircle2 size={11} className="inline mr-1" /> : <XCircle size={11} className="inline mr-1" />}
                  AC/DoD {gateReady ? 'ready' : 'missing'}
                </span>
                <span className={verified ? 'text-green-400' : 'text-monastery-text-muted'}>
                  {verified ? <CheckCircle2 size={11} className="inline mr-1" /> : <FlaskConical size={11} className="inline mr-1" />}
                  Verify {verified ? 'passed' : 'pending'}
                </span>
              </div>

              {/* Spec editor (the system of record) */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-monastery-text-muted">spec.md (Acceptance Criteria + Definition of Done gate implementation)</span>
                  <button onClick={saveSpec} disabled={busy === 'spec'} className="text-[11px] underline text-monastery-text-muted hover:text-monastery-text-primary disabled:opacity-50">Save spec</button>
                </div>
                <textarea
                  value={spec}
                  onChange={(e) => setSpec(e.target.value)}
                  rows={6}
                  className="w-full bg-monastery-dark-surface border border-monastery-dark-border rounded-lg px-2 py-1.5 text-xs font-mono resize-y"
                  placeholder="Run the Plan stage to draft the spec, or write it here."
                />
              </div>

              {/* Stage actions */}
              <div className="flex items-center gap-2 flex-wrap">
                {stage === 'verify' ? (
                  <button onClick={runVerify} disabled={busy === 'verify'} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg border border-monastery-dark-border hover:border-monastery-pine">
                    {busy === 'verify' ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} Run verify
                  </button>
                ) : stage !== 'done' && (
                  <>
                    <button
                      onClick={() => onRunStage(stage)}
                      disabled={stage === 'implement' && !gateReady}
                      title={stage === 'implement' && !gateReady ? 'Plan gate: add Acceptance Criteria + Definition of Done first' : undefined}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg border border-monastery-dark-border hover:border-monastery-pine disabled:opacity-40"
                    >
                      <Play size={12} /> Run {STAGE_LABEL[stage]}
                    </button>
                    {hermesAvailable && (
                      <button
                        onClick={() => onHandToHermes(stage)}
                        disabled={stage === 'implement' && !gateReady}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg border border-monastery-dark-border hover:border-monastery-pine disabled:opacity-40"
                      >
                        <Bot size={12} /> Hand to Hermes
                      </button>
                    )}
                  </>
                )}

                {/* Advance / gate transitions */}
                {stage === 'plan' && (
                  <button onClick={() => advance('plan', 'Spec ready', 'implement')} disabled={!gateReady || busy === 'advance'} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-monastery-pine/30 disabled:opacity-40">Mark planned <ArrowRight size={12} /></button>
                )}
                {stage === 'implement' && (
                  <button onClick={() => advance('implement', 'Ready for Verify', 'verify')} disabled={busy === 'advance'} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-monastery-pine/30">Ready for verify <ArrowRight size={12} /></button>
                )}
                {stage === 'verify' && (
                  <button onClick={() => advance('verify', 'Verified', 'review')} disabled={!verified || busy === 'advance'} title={!verified ? 'Verify gate: a passing build/test is required' : undefined} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-monastery-pine/30 disabled:opacity-40">To review <ArrowRight size={12} /></button>
                )}
                {stage === 'review' && (
                  <button onClick={() => advance('review', 'Approved (HITL)', 'done')} disabled={busy === 'advance'} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-monastery-lantern text-monastery-dark-bg font-medium">Approve &amp; done <CheckCircle2 size={12} /></button>
                )}
              </div>

              {verifyOut && (
                <pre className="text-[10px] bg-monastery-dark-surface border border-monastery-dark-border rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap">{verifyOut}</pre>
              )}

              {/* Exit-state chain (chain of custody) */}
              {activeTask.exit_states.length > 0 && (
                <div className="text-[10px] text-monastery-text-muted space-y-0.5">
                  {activeTask.exit_states.map((e, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <span className={e.status === 'failed' ? 'text-red-400' : 'text-green-400'}>{e.status === 'failed' ? '✗' : '✓'}</span>
                      <span className="text-monastery-text-secondary">{e.stage}:</span> {e.exit_state}
                      {e.evidence && <span className="text-monastery-text-muted">({e.evidence})</span>}
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => refresh()} className="text-[10px] underline text-monastery-text-muted hover:text-monastery-text-primary">refresh</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
