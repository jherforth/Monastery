import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { fetcher, apiPost } from '../lib/fetch';

export type Stage = 'plan' | 'implement' | 'verify' | 'review' | 'done';

export interface ExitState {
  stage: string;
  status: string;        // complete | failed | in_progress
  exit_state: string;
  evidence?: string | null;
  at: string;
}

export interface TaskMeta {
  id: string;
  title: string;
  stage: Stage;
  affected_files: string[];
  exit_states: ExitState[];
  verify_command?: string | null;
  session_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface VerifyResult {
  passed: boolean;
  exit_code: number;
  command: string;
  evidence: string;
  log: string;
}

export const STAGES: Stage[] = ['plan', 'implement', 'verify', 'review', 'done'];

/** Agent-role ids that map onto workflow stages (plan/implement/verify/review). When a task is
 *  active these roles are driven by the workflow, so the ad-hoc chat chips for them are hidden to
 *  avoid two parallel "pick a role" mechanisms. Extras (documenter, deployer) are not stages. */
export const WORKFLOW_ROLE_IDS = ['architect', 'coder', 'tester', 'reviewer'];

/** A spec is "ready" once it has at least one filled-in Acceptance Criteria and Definition of Done
 *  bullet — the Stop-the-Line gate before implementation may begin. */
export function specHasAcDod(spec: string): boolean {
  const section = (name: string) => {
    const m = spec.match(new RegExp(`##\\s*${name}([\\s\\S]*?)(?:\\n##\\s|$)`, 'i'));
    if (!m) return false;
    // at least one checkbox/bullet with non-whitespace content after it
    return /[-*]\s*(\[.\]\s*)?\S/.test(m[1]);
  };
  return section('Acceptance Criteria') && section('Definition of Done');
}

/** The most recent verify exit state, if any. */
export function latestVerify(task: TaskMeta | null): ExitState | undefined {
  if (!task) return undefined;
  return [...task.exit_states].reverse().find((e) => e.stage === 'verify');
}

export function useWorkflow(projectId?: string) {
  const { data: tasks, mutate } = useSWR<TaskMeta[]>(
    projectId ? `/api/projects/${projectId}/tasks` : null,
    fetcher,
  );
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [spec, setSpec] = useState<string>('');

  const activeTask = (tasks || []).find((t) => t.id === activeTaskId) || null;

  const createTask = useCallback(async (title: string, sessionId?: string, spec?: string) => {
    const res: TaskMeta = await apiPost(`/api/projects/${projectId}/tasks`, { title, session_id: sessionId, spec }, 'Failed to create task');
    await mutate();
    setActiveTaskId(res.id);
    setSpec(spec || '');
    return res;
  }, [projectId, mutate]);

  const loadTask = useCallback(async (id: string) => {
    const r = await fetch(`/api/projects/${projectId}/tasks/${id}`).then((x) => x.json());
    setActiveTaskId(id);
    setSpec(r.spec || '');
    return r as { meta: TaskMeta; spec: string };
  }, [projectId]);

  const patchTask = useCallback(async (id: string, patch: Record<string, unknown>) => {
    const r = await fetch(`/api/projects/${projectId}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((x) => x.json());
    await mutate();
    return r as TaskMeta;
  }, [projectId, mutate]);

  const verify = useCallback(async (id: string, command?: string): Promise<VerifyResult> => {
    const r = await fetch(`/api/projects/${projectId}/tasks/${id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'Verify failed' }));
      throw new Error(err.error || 'Verify failed');
    }
    const res = await r.json();
    await mutate();
    return res;
  }, [projectId, mutate]);

  /** Append an exit state and (optionally) advance the stage. */
  const recordExit = useCallback(async (id: string, exit: Omit<ExitState, 'at'>, nextStage?: Stage) => {
    return patchTask(id, {
      exit_state: { ...exit, at: new Date().toISOString() },
      ...(nextStage ? { stage: nextStage } : {}),
    });
  }, [patchTask]);

  return {
    tasks: tasks || [],
    activeTask,
    activeTaskId,
    setActiveTaskId,
    spec,
    setSpec,
    createTask,
    loadTask,
    patchTask,
    verify,
    recordExit,
    refresh: mutate,
  };
}
