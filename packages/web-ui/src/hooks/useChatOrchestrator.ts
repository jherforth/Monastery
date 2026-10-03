import { useState, useCallback, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { buildSkillInstructions } from '../lib/skills';
import { parseSSEStream } from '../lib/sse';
import { runCommandBlock } from '../lib/commands';
import { Message, Project, FileChange } from '../types';
import type { EditorTab } from './useEditorTabs';

/** Build writes files; Discuss answers questions and plans, and never touches the project. */
export type ChatMode = 'build' | 'discuss';

interface ChatOrchestratorDeps {
  currentProject: Project | null;
  currentSession: { id: string } | null;
  createSession: (init?: { title?: string }) => Promise<{ id: string } | null | undefined>;
  addMessage: (m: { role: string; content: string }) => Promise<unknown>;
  availableModels: Array<{ id: string }>;
  /** Configured Pocketbase connection (or undefined) — its URL feeds the pocketbase skill. */
  pocketbaseBaseUrl?: string;
  setProjectFiles: (files: any[]) => void;
  currentFile: string;
  activeTab: EditorTab | undefined;
  isImagePath: (p: string) => boolean;
  updateTabContentByPath: (path: string, content: string) => void;
}

const NO_MODEL_MSG =
  '⚠️ No model is available from the active endpoint. Open the LLM menu in the top bar to pick a model, ' +
  'or validate the endpoint in Settings → Models (its /v1/models list may be empty or unreachable).';

const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * The chat, as a renderer. Each turn is one `POST /api/projects/:id/chat`: the server builds the
 * context from disk, streams the reply, applies `<file>`/`<edit>` tags as they close (after one
 * safety snapshot), continues past the output limit, serves `<read>` requests and retries a failed
 * edit — and reports all of it as SSE events (see crates/harness-api/src/chat/mod.rs). This hook
 * turns those events into chat messages and keeps the editor tabs and preview in step.
 */
export function useChatOrchestrator(deps: ChatOrchestratorDeps) {
  const {
    currentProject, currentSession, createSession, addMessage, availableModels, pocketbaseBaseUrl,
    setProjectFiles, currentFile, activeTab, isImagePath, updateTabContentByPath,
  } = deps;

  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [chatMode, setChatMode] = useState<ChatMode>('build');
  // Toggle-triggered skills the user has switched on (see lib/skills.ts).
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
  const toggleSkill = useCallback((id: string, on?: boolean) => {
    setActiveSkillIds(ids => {
      const has = ids.includes(id);
      const want = on ?? !has;
      if (want === has) return ids;
      return want ? [...ids, id] : ids.filter(x => x !== id);
    });
  }, []);
  // Files the model `<read>` this session; sent back so large projects keep them in context.
  const workingSetRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  // The user's persisted model pick when the active endpoint still serves it (or can't list
  // models at all — "Custom model…" exists for those), else the endpoint's first model.
  const resolveModelId = useCallback((): string | null => {
    const selected = useAppStore.getState().selectedModelId;
    if (selected && (availableModels.length === 0 || availableModels.some(m => m.id === selected))) return selected;
    return availableModels[0]?.id ?? null;
  }, [availableModels]);

  const post = (m: Omit<Message, 'id' | 'timestamp'>) =>
    setMessages(prev => [...prev, { id: newId(m.role), timestamp: Date.now(), ...m }]);
  const patch = (id: string, fn: (m: Message) => Partial<Message>) =>
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...fn(m) } : m)));

  /**
   * Run one turn and render its events. `targetId` = an existing (cut-off) assistant message to
   * append to; otherwise a new bubble is created.
   */
  const runTurn = useCallback(async (
    body: Record<string, unknown>, mode: ChatMode, targetId?: string, sessionId?: string,
  ) => {
    if (!currentProject?.id) return;
    const pid = currentProject.id;
    const modelId = resolveModelId();
    if (!modelId) { post({ role: 'system', content: NO_MODEL_MSG }); return; }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);

    const msgMode = mode === 'discuss' ? 'discuss' as const : undefined;
    const startBubble = () => {
      const id = newId('assistant');
      setMessages(prev => [...prev, { id, role: 'assistant', content: '', timestamp: Date.now(), mode: msgMode }]);
      return id;
    };
    let bubble = targetId ?? startBubble();
    const written: Record<string, string> = {}; // bubble id → text received this turn
    const changes = new Map<string, FileChange>();
    let snapshotId: string | null = null;

    const openFile = currentFile && activeTab && !isImagePath(currentFile)
      ? { path: currentFile, content: activeTab.content } : undefined;
    try {
      const res = await fetch(`/api/projects/${pid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          mode,
          model: modelId,
          endpoint_id: useAppStore.getState().activeEndpoint?.id,
          instructions: buildSkillInstructions(activeSkillIds, { pocketbaseUrl: pocketbaseBaseUrl }),
          open_file: openFile,
          working_set: [...workingSetRef.current],
          ...body,
        }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        let detail = text;
        try { detail = JSON.parse(text).error || text; } catch { /* raw */ }
        throw new Error(`Chat request failed (HTTP ${res.status}): ${String(detail).slice(0, 300)}`);
      }

      for await (const { eventType, data } of parseSSEStream(res.body.getReader())) {
        let d: any;
        try { d = JSON.parse(data); } catch { continue; }
        switch (eventType) {
          case 'text':
            written[bubble] = (written[bubble] ?? '') + d.text;
            patch(bubble, m => ({ content: m.content + d.text }));
            break;
          case 'reasoning':
            patch(bubble, m => ({ reasoning: (m.reasoning ?? '') + d.text }));
            break;
          case 'segment':
            bubble = startBubble();
            break;
          case 'status':
            post({ role: 'system', kind: 'activity', content: d.text });
            break;
          case 'notice':
            post({ role: 'system', content: d.text });
            break;
          case 'snapshot':
            snapshotId = d.id;
            break;
          case 'file': {
            // Several changes to one file in a turn collapse to one card: first before, last after.
            const prev = changes.get(d.path);
            changes.set(d.path, {
              path: d.path,
              kind: prev?.kind === 'write' ? 'write' : d.kind,
              before: prev ? prev.before : d.before,
              after: d.after,
            });
            updateTabContentByPath(d.path, d.after);
            window.dispatchEvent(new CustomEvent('monastery:files-written'));
            break;
          }
          case 'edit_failed':
            post({ role: 'system', content: `❌ ${d.message}` });
            break;
          case 'read':
            (d.paths as string[]).forEach(p => workingSetRef.current.add(p));
            break;
          case 'truncated':
            patch(bubble, () => ({ truncated: true }));
            break;
          case 'usage':
            if (d.total_tokens) patch(bubble, () => ({ usage: d }));
            break;
          case 'error':
            post({ role: 'system', content: `⚠️ ${d.message}` });
            break;
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // Stopped: keep what arrived and let the manual Continue button resume it.
        patch(bubble, m => ({ truncated: !!m.content }));
      } else {
        post({ role: 'system', content: `⚠️ ${err?.message || 'Request failed'}` });
      }
    } finally {
      // Drop an assistant bubble that never received anything.
      setMessages(prev => prev.filter(m => !(m.role === 'assistant' && !m.content && !m.reasoning)));
      if (sessionId) {
        Object.values(written).filter(t => t.trim())
          .forEach(content => addMessage({ role: 'assistant', content }).catch(console.error));
      }
      if (changes.size > 0) {
        const all = [...changes.values()];
        const list = (kind: 'write' | 'edit') => all.filter(c => c.kind === kind).map(c => `\`${c.path}\``);
        const notes = [
          list('write').length ? `✅ Wrote ${list('write').join(', ')}` : '',
          list('edit').length ? `✏️ Edited ${list('edit').join(', ')}` : '',
          snapshotId ? '🛟 The previous state was snapshotted first — you can abandon these changes below.' : '',
        ].filter(Boolean);
        post({
          role: 'system', content: notes.join('\n\n'), fileChanges: all,
          // A snapshot id in `model` gives the message its one-click restore button.
          model: snapshotId ?? undefined, revertLabel: snapshotId ? 'Abandon these changes' : undefined,
        });
        fetch(`/api/projects/${pid}/files`).then(r => r.json()).then(setProjectFiles).catch(() => {});
      }
      setIsGenerating(false);
    }
  }, [currentProject?.id, resolveModelId, activeSkillIds, pocketbaseBaseUrl, currentFile, activeTab, isImagePath, updateTabContentByPath, setProjectFiles, addMessage]);

  // The history the server needs: the conversation, minus activity rows.
  const historyOf = (msgs: Message[]) =>
    msgs.filter(m => m.kind !== 'activity' && m.content.trim()).map(m => ({ role: m.role, content: m.content }));

  // `options.mode` overrides the composer's mode for this one send ("Build this plan", "Fix it"
  // and build-error fixes always build).
  const handleSendMessage = useCallback(async (content: string, attachments?: any[], options?: { mode?: ChatMode }) => {
    if (!currentProject?.id) {
      post({ role: 'system', content: 'Select or create a project first.' });
      return;
    }
    const mode = options?.mode ?? chatMode;
    const sessionId = currentSession?.id ?? (await createSession({ title: content.slice(0, 50) }))?.id;
    const history = historyOf(messages);
    post({ role: 'user', content, attachments, mode: mode === 'discuss' ? 'discuss' : undefined });
    if (sessionId) addMessage({ role: 'user', content }).catch(console.error);
    await runTurn({ message: content, history }, mode, undefined, sessionId);
  }, [currentProject?.id, chatMode, currentSession?.id, createSession, messages, addMessage, runTurn]);

  // Manually continue a reply that is still cut off after the server's automatic continuations
  // (or was stopped). Appends onto the same bubble; a Discuss reply continues as Discuss.
  const handleContinueGeneration = useCallback(async (msgId: string) => {
    const index = messages.findIndex(m => m.id === msgId);
    if (index === -1) return;
    patch(msgId, () => ({ truncated: false }));
    await runTurn(
      { continue_last: true, history: historyOf(messages.slice(0, index + 1)) },
      messages[index].mode === 'discuss' ? 'discuss' : 'build', msgId, currentSession?.id,
    );
  }, [messages, currentSession?.id, runTurn]);

  // Hand a failed deployment's build log to the model to fix (from the Self-Host Wizard).
  const handleFixBuildError = useCallback((logs: string, appName: string, opts?: { fallback?: boolean; status?: string }) => {
    const prompt = (opts?.fallback || !logs.trim())
      // The platform couldn't return the build log (e.g. Dokploy's readLogs is broken for remote
      // deploy servers); the model still sees the project, so ask it to review.
      ? `The deployment of "${appName}" failed (status: ${opts?.status || 'error'}), but the build log could not be retrieved from the hosting platform. Review this project's Dockerfile and build configuration for the most likely causes of a failed Docker build and fix them — check files referenced by COPY/ADD that may not exist, the base image, the build/start commands, EXPOSE vs the port the server listens on, and the dependency-install steps. Briefly explain what you changed.`
      : `The deployment of "${appName}" failed during the build. Here is the build log:\n\n\`\`\`\n${logs}\n\`\`\`\n\nDiagnose the root cause and fix it in the project files (Dockerfile, package.json, build config, or source). Keep changes minimal and focused on making the build succeed.`;
    handleSendMessage(prompt, undefined, { mode: 'build' });
  }, [handleSendMessage]);

  // "Build this plan": hand a Discuss-mode plan to Build mode, and leave the composer in Build so
  // follow-up tweaks keep building.
  const buildPlan = useCallback((plan: string) => {
    setChatMode('build');
    const start = plan.search(/^#{1,3}\s+The Plan\b/mi);
    const body = (start >= 0 ? plan.slice(start) : plan).trim();
    handleSendMessage(`Implement this plan now, completing every step in this response:\n\n${body}`, undefined, { mode: 'build' });
  }, [handleSendMessage]);

  // A command block the user clicked "Run" on. Each result is posted to the chat, so the model
  // sees the output on the next turn.
  const runShellCommand = useCallback(async (block: string) => {
    if (!currentProject?.id) return;
    const pid = currentProject.id;
    const { notes, anyRan } = await runCommandBlock(pid, block);
    notes.forEach(content => post({ role: 'system', content }));
    if (anyRan) {
      fetch(`/api/projects/${pid}/files`).then(r => r.json()).then(setProjectFiles).catch(() => {});
      window.dispatchEvent(new CustomEvent('monastery:files-written'));
    }
  }, [currentProject?.id, setProjectFiles]);

  const handleStopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setIsGenerating(false);
  }, []);

  return {
    messages,
    setMessages,
    isGenerating,
    chatMode,
    setChatMode,
    activeSkillIds,
    toggleSkill,
    handleSendMessage,
    handleContinueGeneration,
    handleStopGeneration,
    handleFixBuildError,
    buildPlan,
    runShellCommand,
  };
}
