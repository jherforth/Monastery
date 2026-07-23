import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { buildSkillInstructions } from '../lib/skills';
import { useWorkflow, WORKFLOW_ROLE_IDS, type Stage, type TaskMeta } from './useWorkflow';
import { parseSSEStream } from '../lib/sse';
import { Message, Project, FileChange } from '../types';
import type { EditorTab } from './useEditorTabs';

// Below this total corpus size the whole project is sent as context; above it, only the
// active file + working set (scoped mode).
const SMALL_PROJECT_LIMIT = 96_000; // ~24K tokens
// The workflow nudge is deliberately much higher and decoupled from context scoping — it should
// only fire for GENUINELY large projects, not a single sizable HTML/CSS page. Suppressible too.
const WORKFLOW_NUDGE_LIMIT = 400_000; // ~100K tokens
export const WORKFLOW_NUDGE_SUPPRESS_KEY = 'monastery.suppressWorkflowNudge';

// Active agent role(s) — a persistent "lens" applied to chat messages. Capped to keep focus.
export const MAX_ACTIVE_ROLES = 2;

// Auto-continue a response that hits the model's output-token cap (finish_reason="length"),
// up to MAX_AUTO_CONTINUE times, then fall back to the manual Continue button. Capped on
// purpose: unbounded auto-continue can burn cloud (e.g. DeepSeek) tokens on verbose models.
const MAX_AUTO_CONTINUE = 5;
// Same idea, separate cap: rounds where the model asked for context via `@read`/`@search`
// and got results auto-fed back in. Kept small and distinct from MAX_AUTO_CONTINUE since
// each round is a full extra request (not just an appended chunk). 4 allows the full
// discovery chain in a complex project: search → read → (read more) → edit.
const MAX_AUTO_READ_ROUNDS = 4;

// Format one file for the PROJECT FILE CONTENTS context block.
const fmtFile = (path: string, content: string) => {
  const ext = path.split('.').pop() || '';
  return `### ${path}\n\`\`\`${ext}\n${content}\n\`\`\``;
};

type EditHunk = { search: string; replace: string };

// Parse SEARCH/REPLACE edit blocks out of a code-block body. Their presence means the model
// wants a targeted in-place edit (modify a section) rather than a full-file replace — which is
// what prevents a section from clobbering the whole file.
const parseEditBlocks = (code: string): EditHunk[] => {
  const re = /<<<<<<<+[ \t]*SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n=======[ \t]*\r?\n([\s\S]*?)\r?\n>>>>>>>+[ \t]*REPLACE/g;
  const out: EditHunk[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push({ search: m[1], replace: m[2] });
  return out;
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Extract the code-block body for a specific file path from an assistant response (the first
// ```lang:path\n…\n``` block whose path matches). Used by the edit-recovery retry.
const extractFileBlock = (response: string, path: string): string | null => {
  const re = new RegExp('```[\\w.]*\\s*:\\s*' + escapeRegExp(path) + '\\s*\\n([\\s\\S]*?)\\n```');
  const m = response.match(re);
  return m ? m[1] : null;
};

// Replace fenced code blocks in OLDER assistant messages with short placeholders before
// sending history to the LLM. Without this, history accumulates multiple stale versions of
// each file that compete with the current PROJECT FILE CONTENTS in the system message —
// models routinely copy from their own outdated output and "overwrite" newer work.
// (The in-flight response being continued is never stripped — the model needs its own text.)
const stripHistoryCodeBlocks = (text: string): string =>
  text.replace(/```([^\n]*)\n[\s\S]*?```/g, (_m, info) => {
    const path = String(info).includes(':') ? String(info).split(':').slice(1).join(':').trim() : '';
    return path
      ? `[previous version of \`${path}\` omitted — the CURRENT contents are in PROJECT FILE CONTENTS]`
      : '[code block omitted]';
  });

// Repair the seam where a continuation resumes a response that was cut off INSIDE a code
// block. Despite the "continue exactly where you left off" instruction, models often restart
// with a duplicate fence opener (```css:styles.css) and/or repeat their last lines — which
// unbalances the fences and permanently breaks both the chat's code-block rendering and the
// file-apply parser. Called with the accumulated continuation on every chunk, so the live
// render stays balanced too. A bare ``` at the start is a legitimate CLOSER and is kept —
// only openers (fence + info string) are stripped.
const stitchContinuation = (base: string, cont: string): string => {
  let out = cont;
  const insideBlock = ((base.match(/```/g) || []).length) % 2 === 1;
  if (insideBlock) {
    const opener = out.match(/^\s*```[^\s`][^\n]*\n/);
    if (opener) out = out.slice(opener[0].length);
  }
  // Drop text the model repeated from the end of the base (longest suffix of base, ≥16
  // chars, that the continuation starts with).
  const tail = base.slice(-240);
  for (let len = tail.length; len >= 16; len--) {
    if (out.startsWith(tail.slice(tail.length - len))) {
      out = out.slice(len);
      break;
    }
  }
  return out;
};

interface AgentLike {
  name: string;
  role: string;
  description: string;
  icon: string;
}

interface ChatOrchestratorDeps {
  currentProject: Project | null;
  currentSession: { id: string } | null;
  createSession: (init?: { title?: string }) => Promise<{ id: string } | null | undefined>;
  addMessage: (m: { role: string; content: string }) => Promise<unknown>;
  availableModels: Array<{ id: string }>;
  /** Default Hermes connection (or null) — enables Agent-mode routing. */
  hermesConnection: unknown;
  /** Configured Pocketbase connection (or undefined) — its URL feeds the pocketbase skill. */
  pocketbaseBaseUrl?: string;
  workflow: ReturnType<typeof useWorkflow>;
  getAgent: (id: string) => AgentLike | undefined;
  projectFiles: any[];
  setProjectFiles: (files: any[]) => void;
  allFileContents: Record<string, string>;
  setAllFileContents: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  currentFile: string;
  activeTab: EditorTab | undefined;
  isImagePath: (p: string) => boolean;
  updateTabContentByPath: (path: string, content: string) => void;
}

/**
 * Everything about talking to the model lives here: building system context, streaming,
 * auto-continue, the @read/@search context-pull loop, applying returned code blocks to disk,
 * and the escalating recovery for edit hunks that don't match. The UI (App) consumes the
 * returned messages/handlers and stays presentational.
 */
export function useChatOrchestrator(deps: ChatOrchestratorDeps) {
  const {
    currentProject,
    currentSession,
    createSession,
    addMessage,
    availableModels,
    hermesConnection,
    pocketbaseBaseUrl,
    workflow,
    getAgent,
    projectFiles,
    setProjectFiles,
    allFileContents,
    setAllFileContents,
    currentFile,
    activeTab,
    isImagePath,
    updateTabContentByPath,
  } = deps;

  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  // When on, chat messages are routed to the Hermes agent instead of plain LLM streaming.
  // Only selectable when a default Hermes connection is configured.
  const [agentMode, setAgentModeRaw] = useState(false);
  // Toggle-triggered skills the user has switched on (see lib/skills.ts) — e.g. 'pocketbase'
  // injects backend + deployment instructions into the LLM context. Registry-driven: the
  // composer renders whatever skills exist, so new domains need no UI changes.
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
  const toggleSkill = useCallback((id: string, on?: boolean) => {
    setActiveSkillIds(ids => {
      const has = ids.includes(id);
      const want = on ?? !has;
      if (want === has) return ids;
      return want ? [...ids, id] : ids.filter(x => x !== id);
    });
  }, []);
  const [autoContinue, setAutoContinue] = useState(true);
  // Context discipline: in large projects we don't dump the whole repo into every message. The
  // "working set" is the subset of files (beyond the active file) currently included in context —
  // seeded by a task spec's affected-files later, and grown when the model emits `@read <path>`.
  const [workingSetPaths, setWorkingSetPaths] = useState<string[]>([]);
  const [activeAgentIds, setActiveAgentIds] = useState<string[]>([]);
  const toggleActiveAgent = useCallback((id: string) => {
    setActiveAgentIds(ids =>
      ids.includes(id)
        ? ids.filter(x => x !== id)
        : ids.length < MAX_ACTIVE_ROLES ? [...ids, id] : ids
    );
  }, []);
  // Roles live under Agent mode in the UI; clear them when it's switched off so an
  // active role can't keep silently injecting once its chips are hidden.
  const setAgentMode = useCallback((on: boolean) => {
    setAgentModeRaw(on);
    if (!on) setActiveAgentIds([]);
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  // Workflow nudge: suggested at most once per session/project (reset below) when a freeform
  // request hits a large project without an active task.
  const workflowNudgeShownRef = useRef(false);
  // Holds the latest recoverFailedEdits so applyAssistantOutput (defined earlier) can invoke it
  // without a forward reference in its dependency array.
  const recoverFailedEditsRef = useRef<((failed: Array<{ path: string; hunks: EditHunk[] }>) => void) | null>(null);
  // Live view of the context map for applyAssistantOutput's before/after diff capture —
  // allFileContents isn't in that callback's deps, so a ref avoids stale closure reads.
  const allFileContentsRef = useRef(allFileContents);
  allFileContentsRef.current = allFileContents;

  // When a task is active, its stage roles are driven by the Workflow panel — drop any active
  // stage-role chips so a now-hidden role can't keep silently injecting into context.
  useEffect(() => {
    if (workflow.activeTask) {
      setActiveAgentIds(ids => ids.filter(id => !WORKFLOW_ROLE_IDS.includes(id)));
    }
  }, [workflow.activeTask?.id]);

  // A new session or project gets one fresh chance to show the workflow nudge.
  useEffect(() => {
    workflowNudgeShownRef.current = false;
  }, [currentProject?.id, currentSession?.id]);

  // Parse an assistant response for code blocks / shell commands and apply them to
  // the project on disk. Shared by the initial send and the manual "Continue" action
  // so both paths write files identically.
  const applyAssistantOutput = useCallback((fullContent: string) => {
    if (!currentProject?.id) return;

    type WriteResult = { path: string; ok: boolean; error?: string; kind?: 'write' | 'edit'; applied?: number; failedHunks?: number };
    // Collect everything to apply first — the fetches only fire AFTER the safety
    // checkpoint below, so a bad response can't destroy un-snapshotted work.
    const fileWrites: Array<{ path: string; content: string }> = [];
    const fileEdits: Array<{ path: string; edits: EditHunk[] }> = [];
    const modifiedFiles: string[] = [];

    // --- Code block parser ---
    // Pattern 1: language:path/to/file on the opening fence line
    const pattern1 = /```(\w*)\s*:\s*(\S+)\s*\n([\s\S]*?)\n```/gm;
    // Pattern 2: file path on line immediately before code block
    const pattern2 = /(?:^|\n)\s*([\/\w\-\.]+\.\w+):?\s*\n+```(\w*)\n([\s\S]*?)\n```/gm;
    // (Former pattern 3 — prose like "update index.html" followed by ANY code block — was
    // removed: it routinely matched explanatory snippets and replaced whole files with them.)
    // Pattern 4: file comment on first line inside code block
    const pattern4 = /```(\w*)\n(?:\/\/|#|<!--)\s*(?:file:?|filename:?)\s*([\/\w\-\.]+\.\w+).*?\n([\s\S]*?)\n```/gi;
    // Pattern 5: ### filename heading or **filename** followed by code block
    const pattern5 = /(?:^|\n)(?:#{1,3}\s*|(?:\*\*)(.+?)(?:\*\*)\s*\n)(?:File:?\s*)?([\/\w\-\.]+\.\w+)\s*\n+```(\w*)\n([\s\S]*?)\n```/gmi;

    const allPatterns = [pattern1, pattern2, pattern4, pattern5];
    const seenPaths = new Set<string>();

    for (const pattern of allPatterns) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(fullContent)) !== null) {
        let filePath: string;
        let code: string;

        if (pattern === pattern1) {
          filePath = match[2];
          code = match[3];
        } else if (pattern === pattern4) {
          filePath = match[2];
          code = match[3];
        } else if (pattern === pattern5) {
          filePath = match[2];
          code = match[4];
        } else {
          filePath = match[1];
          code = match[3];
        }

        if (!filePath || seenPaths.has(filePath)) continue;
        seenPaths.add(filePath);

        // Skip writing raw diff output — diffs should be applied, not stored as file content
        const lang = (pattern === pattern1 || pattern === pattern4) ? match[1]?.toLowerCase()
          : (pattern === pattern5) ? match[3]?.toLowerCase()
          : match[2]?.toLowerCase();
        if (lang === 'diff') continue;

        // SEARCH/REPLACE block(s) → targeted in-place edit; otherwise a full-file write.
        const edits = parseEditBlocks(code);
        if (edits.length > 0) {
          modifiedFiles.push(filePath);
          fileEdits.push({ path: filePath, edits });
          continue;
        }

        const cleanCode = code.trimEnd() + '\n';
        if (!cleanCode.trim()) continue; // skip empty blocks

        modifiedFiles.push(filePath);
        fileWrites.push({ path: filePath, content: cleanCode });
      }
    }

    // --- Shell command detection ---
    const shellRegex = /```(?:shell|bash|sh|zsh)\s*\n([\s\S]*?)\n```/gi;
    let shellMatch;
    const shellCommands: string[] = [];
    while ((shellMatch = shellRegex.exec(fullContent)) !== null) {
      const cmd = shellMatch[1].trim();
      if (cmd) shellCommands.push(cmd);
    }

    if (fileWrites.length === 0 && fileEdits.length === 0 && shellCommands.length === 0) return;

    // Pre-apply contents, for the per-file diff cards on the feedback message.
    const beforeContents: Record<string, string> = {};
    for (const p of modifiedFiles) beforeContents[p] = allFileContentsRef.current[p] ?? '';

    (async () => {
      // Safety checkpoint: snapshot the project's on-disk state BEFORE applying anything,
      // so even the first AI edit in a session is revertible. The snapshot id is attached to
      // the write-feedback message below so the chat shows an inline "Abandon" button.
      // A checkpoint failure logs a warning but doesn't block the apply.
      let checkpointSnapshotId: string | null = null;
      try {
        const cpRes = await fetch(`/api/projects/${currentProject.id}/snapshots/checkpoint`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Auto: before AI edit' }),
        });
        const cp = cpRes.ok ? await cpRes.json().catch(() => null) : null;
        checkpointSnapshotId = cp?.snapshot_id || null;
      } catch (e) {
        console.warn('Safety checkpoint failed:', e);
      }

      // Whole-file writes carry guard_partial_overwrite so the backend refuses to replace an
      // existing file with what is really just a section of it (the "section clobbered the whole
      // file" bug) — the model should use a SEARCH/REPLACE edit block for that instead.
      const editedContents: Record<string, string> = {};
      // Hunks that didn't match, per file — fed to the escalating recovery below.
      const failedHunksByFile: Record<string, EditHunk[]> = {};
      const writes: Promise<WriteResult | void>[] = fileWrites.map(({ path: filePath, content: cleanCode }) =>
        fetch(`/api/projects/${currentProject.id}/files/write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content: cleanCode, guard_partial_overwrite: true }),
        }).then(async r => {
          if (!r.ok) {
            const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
            const msg = typeof err === 'object' && err !== null && 'error' in err
              ? String(err.error) : `HTTP ${r.status}`;
            console.error(`Failed to write ${filePath}: ${msg}`);
            return { path: filePath, ok: false, error: msg, kind: 'write' as const };
          }
          console.log(`Wrote ${filePath} (${cleanCode.length} bytes)`);
          editedContents[filePath] = cleanCode;
          return { path: filePath, ok: true, kind: 'write' as const };
        }).catch(e => {
          console.error(`Write error for ${filePath}:`, e);
          return { path: filePath, ok: false, error: String(e), kind: 'write' as const };
        })
      );

      // Targeted SEARCH/REPLACE edits — applied against the on-disk file server-side.
      for (const { path: filePath, edits } of fileEdits) {
        writes.push(
          fetch(`/api/projects/${currentProject.id}/files/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, edits }),
          }).then(async r => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
              const msg = data?.error || `HTTP ${r.status}`;
              console.error(`Failed to edit ${filePath}: ${msg}`);
              return { path: filePath, ok: false, error: String(msg), kind: 'edit' as const };
            }
            const applied = data?.applied || 0;
            const failedList: EditHunk[] = Array.isArray(data?.failed) ? data.failed : [];
            if (failedList.length > 0) failedHunksByFile[filePath] = failedList;
            if (typeof data?.content === 'string') editedContents[filePath] = data.content;
            return { path: filePath, ok: applied > 0, kind: 'edit' as const, applied, failedHunks: failedList.length,
              error: applied === 0 ? 'no SEARCH text matched' : undefined };
          }).catch(e => {
            console.error(`Edit error for ${filePath}:`, e);
            return { path: filePath, ok: false, error: String(e), kind: 'edit' as const };
          })
        );
      }

      for (const cmd of shellCommands) {
        writes.push(
          fetch(`/api/projects/${currentProject.id}/shell`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd }),
          }).then(async r => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) console.error(`Shell failed: ${data.error || cmd}`);
          }).catch(e => console.error(`Shell error:`, e))
        );
      }

      Promise.all(writes).then((results) => {
        // Refresh open file if it was modified
        if (currentFile) {
          fetch(`/api/projects/${currentProject.id}/files/read?path=${encodeURIComponent(currentFile)}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data?.content) updateTabContentByPath(currentFile, data.content); })
            .catch(() => {});
        }
        // Refresh file tree
        fetch(`/api/projects/${currentProject.id}/files`)
          .then(r => r.json()).then(f => setProjectFiles(f)).catch(() => {});

        // Keep the LLM's context fresh: fold successful writes AND edits into allFileContents so
        // the next turn's PROJECT FILE CONTENTS matches the disk. (This map previously went stale
        // after the first AI edit, making the model regenerate from outdated file state.) Edits
        // use the server-returned post-edit content; writes use the content we sent.
        const okResults = results.filter((r): r is WriteResult => !!r && r.ok);
        if (okResults.length > 0) {
          setAllFileContents(prev => {
            const next = { ...prev };
            for (const r of okResults) if (editedContents[r.path] !== undefined) next[r.path] = editedContents[r.path];
            return next;
          });
        }
        // Shell commands can touch arbitrary files — re-read everything to be safe.
        if (shellCommands.length > 0) {
          fetch(`/api/projects/${currentProject.id}/files/read-all`)
            .then(r => r.json()).then(d => setAllFileContents(d.files || {})).catch(() => {});
        }

        // Anything on disk may have changed — the live preview listens for this and reloads.
        if (okResults.length > 0 || shellCommands.length > 0) {
          window.dispatchEvent(new CustomEvent('monastery:files-written'));
        }

        // Feedback: separate whole-file writes, targeted edits, and failures.
        const wroteFiles = okResults.filter(r => r.kind !== 'edit').map(r => r.path);
        const editedResults = okResults.filter(r => r.kind === 'edit');
        const failFiles = results.filter((r): r is WriteResult => !!r && !r.ok);
        if (wroteFiles.length > 0 || editedResults.length > 0 || failFiles.length > 0) {
          let note = '';
          if (wroteFiles.length > 0) {
            note += `✅ Wrote **${wroteFiles.length}** file${wroteFiles.length > 1 ? 's' : ''}: ${wroteFiles.map(f => `\`${f}\``).join(', ')}`;
          }
          if (editedResults.length > 0) {
            const parts = editedResults.map(r => {
              const hunks = `${r.applied} hunk${(r.applied ?? 0) > 1 ? 's' : ''}`;
              const miss = r.failedHunks ? `, ${r.failedHunks} unmatched` : '';
              return `\`${r.path}\` (${hunks}${miss})`;
            });
            note += (note ? '\n\n' : '') + `✏️ Edited **${editedResults.length}** file${editedResults.length > 1 ? 's' : ''}: ${parts.join(', ')}`;
          }
          if (wroteFiles.length > 0 || editedResults.length > 0) {
            note += checkpointSnapshotId
              ? '\n\n🛟 The previous state was snapshotted first — you can abandon these changes below.'
              : '\n\n⚠️ Safety snapshot could not be created before these changes.';
          }
          if (failFiles.length > 0) {
            note += (note ? '\n\n' : '') + `❌ Failed **${failFiles.length}** file${failFiles.length > 1 ? 's' : ''}: ${failFiles.map(f => `\`${f.path}\` (${f.error})`).join(', ')}`;
          }
          const anyChange = wroteFiles.length > 0 || editedResults.length > 0;
          // Per-file before/after for the diff cards (successful writes/edits only).
          const fileChanges: FileChange[] = okResults
            .filter(r => editedContents[r.path] !== undefined)
            .map(r => ({
              path: r.path,
              kind: r.kind === 'edit' ? 'edit' as const : 'write' as const,
              before: beforeContents[r.path] ?? '',
              after: editedContents[r.path],
            }));
          if (note) {
            setMessages(prev => [...prev, {
              id: `write-feedback-${Date.now()}`,
              role: 'system' as const,
              content: note,
              timestamp: Date.now(),
              fileChanges: fileChanges.length > 0 ? fileChanges : undefined,
              // Carrying the snapshot id makes ChatPane render its restore button inline,
              // so abandoning an AI edit is one click on the message itself.
              model: (anyChange && checkpointSnapshotId) || undefined,
              revertLabel: anyChange && checkpointSnapshotId ? 'Abandon these changes' : undefined,
            }]);
          }
        }

        // Escalating recovery for edit hunks that didn't match (see recoverFailedEdits).
        const stillFailed = Object.entries(failedHunksByFile)
          .filter(([, hunks]) => hunks.length > 0)
          .map(([path, hunks]) => ({ path, hunks }));
        if (stillFailed.length > 0) {
          recoverFailedEditsRef.current?.(stillFailed);
        }
      });
    })();
  }, [currentProject?.id, currentFile, updateTabContentByPath, setProjectFiles, setAllFileContents]);

  // Build the per-request system context: agent roles, editing rules, skills, task spec,
  // file tree, and file contents. Shared by handleSendMessage AND the manual Continue path,
  // so every request that can write files carries the same project grounding.
  const buildSystemContext = useCallback((userMessageContent: string, extraPaths: string[] = []): string | null => {
    const contextParts: string[] = [];
    // Inject the active agent role(s) silently as a leading system instruction.
    const activeAgents = activeAgentIds
      .map(id => getAgent(id))
      .filter((a): a is NonNullable<typeof a> => !!a);
    if (activeAgents.length === 1) {
      const a = activeAgents[0];
      contextParts.push(`AGENT ROLE: You are acting as the ${a.name} (${a.role}). ${a.description}. Approach the user's request in that capacity.`);
    } else if (activeAgents.length > 1) {
      const list = activeAgents.map(a => `${a.name} (${a.role}) — ${a.description}`).join('; ');
      contextParts.push(`AGENT ROLES: Combine the perspectives of: ${list}. Address the user's request considering all of these roles.`);
    }
    if (currentProject) {
      contextParts.push(`You are an expert coding assistant. You have full access to the project "${currentProject.name}". You can freely read, create, and modify any file. Your changes are automatically applied.`);
    }
    contextParts.push(`FILE EDITING RULES — read carefully, choose the right mode:

1. EDITING part of an EXISTING file → use one or more SEARCH/REPLACE blocks inside a path-tagged code block. The SEARCH text must be copied EXACTLY from the file's current contents (enough surrounding lines to be unique); it is found and replaced in place, leaving the rest of the file untouched. This is the ONLY safe way to change a section — do NOT paste just the changed section as a whole-file block.

   \`\`\`html:index.html
   <<<<<<< SEARCH
     <h1>Old title</h1>
   =======
     <h1>New title</h1>
   >>>>>>> REPLACE
   \`\`\`

   Use several SEARCH/REPLACE blocks in the same code block for multiple edits to one file.

2. CREATING a new file, or intentionally REWRITING a whole file → a path-tagged code block with the file's COMPLETE contents (no SEARCH/REPLACE markers):

   \`\`\`tsx:src/NewThing.tsx
   <full file contents>
   \`\`\`

CRITICAL: a plain path-tagged block (no SEARCH/REPLACE) REPLACES the file's ENTIRE contents. NEVER put just a section, fragment, or "…rest unchanged…" in one — the omitted parts are permanently deleted. If you are changing only part of a file, you MUST use mode 1. Monastery will reject a whole-file block that is only a slice of the existing file.
- The path after the colon determines where the code is written; you can edit/create multiple files in one response.
- For illustrative snippets you do NOT want saved to disk, use a plain code block with NO file path.`);

    // Skills (lazy-loaded expertise) — only the active ones are injected (see lib/skills.ts).
    // The Pocketbase "toggle" is now skill #1; new domains can be added declaratively.
    buildSkillInstructions(
      activeSkillIds,
      { pocketbaseUrl: pocketbaseBaseUrl, userMessage: userMessageContent },
    ).forEach(block => contextParts.push(block));

    // Active task spec — the workflow "system of record", referenced instead of re-derived.
    if (workflow.activeTask && workflow.spec.trim()) {
      contextParts.push(`CURRENT TASK [${workflow.activeTask.stage.toUpperCase()}] — "${workflow.activeTask.title}"\nThis spec is the source of truth; work to its Acceptance Criteria and Definition of Done:\n\n${workflow.spec}`);
    }

    // The file tree (names only) is always cheap and tells the model what exists so it can
    // request files by path.
    if (projectFiles.length > 0) {
      const fileList = projectFiles.map((f: any) => `  ${f.type === 'directory' ? '📁' : '📄'} ${f.path || f.name}`).join('\n');
      contextParts.push(`PROJECT FILE TREE:\n${fileList}`);
    }

    // Context discipline (the token win): small projects still send everything; large projects
    // send ONLY the active file + the working set (files pulled in via the spec or `@read`),
    // instead of dumping the whole repo into every turn and exhausting the context window.
    // In BOTH branches the active file's content is overridden with the live editor buffer,
    // so the model always sees what the user is looking at (including unsaved edits).
    const withEditorOverride = (p: string, c: string) =>
      (p === currentFile && activeTab && !isImagePath(p) ? activeTab.content : c);
    const fileEntries = Object.entries(allFileContents).filter(([, c]) => c.trim().length > 0);
    const corpusSize = fileEntries.reduce((n, [, c]) => n + c.length, 0);
    if (fileEntries.length > 0 && corpusSize <= SMALL_PROJECT_LIMIT) {
      const all = fileEntries.map(([p, c]) => fmtFile(p, withEditorOverride(p, c))).join('\n\n');
      contextParts.push(`PROJECT FILE CONTENTS:\n${all}`);
    } else if (fileEntries.length > 0) {
      const include = new Set<string>();
      if (currentFile) include.add(currentFile);
      workingSetPaths.forEach(p => include.add(p));
      extraPaths.forEach(p => include.add(p));
      // The task spec's affected files seed the working set — this is what lets the staged
      // workflow pre-scope context so the model rarely needs to @read.
      (workflow.activeTask?.affected_files || []).forEach(p => include.add(p));
      const picked = fileEntries
        .filter(([p]) => include.has(p))
        .map(([p, c]) => [p, withEditorOverride(p, c)] as const);
      const body = picked.map(([p, c]) => fmtFile(p, c)).join('\n\n');
      contextParts.push(
        `PROJECT FILE CONTENTS (scoped — large project, so only the active file and files in the working set are shown):\n${body || '(none yet)'}\n\n` +
        `If you need a file from the tree that isn't shown above, output a line \`@read path/to/file\` (one per line) — its contents will be provided to you.\n` +
        `If you don't know WHICH file is relevant (e.g. "fix the login button" in a large project), output \`@search <text, selector, or identifier>\` (one per line) to grep the whole project — you'll get back path:line matches, then @read the files you need.\n` +
        `NEVER rewrite, edit, or guess the contents of a file that is not shown above — @search/@read first and wait for the results. Writing a file you haven't seen will destroy the user's real file.`,
      );
    }
    return contextParts.length > 0 ? contextParts.join('\n\n') : null;
  }, [activeAgentIds, getAgent, currentProject, activeSkillIds, pocketbaseBaseUrl, workflow.activeTask, workflow.spec, projectFiles, allFileContents, currentFile, activeTab, isImagePath, workingSetPaths]);

  // Minimal one-shot LLM call that returns the full text (no UI message). Used by edit recovery.
  const streamChat = useCallback(async (chatMessages: Array<{ role: string; content: string }>): Promise<string> => {
    const activeEndpoint = useAppStore.getState().activeEndpoint;
    const params = new URLSearchParams();
    if (activeEndpoint?.id) params.set('endpoint_id', activeEndpoint.id);
    const modelId = availableModels[0]?.id || 'deepseek-chat';
    const res = await fetch(`/api/models/${modelId}/chat?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatMessages }),
    });
    if (!res.ok) throw new Error(`LLM request failed (HTTP ${res.status})`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    let full = '';
    for await (const { eventType, data } of parseSSEStream(reader)) {
      if (eventType !== 'finish_reason' && eventType !== 'usage' && eventType !== 'reasoning') full += data;
    }
    return full;
  }, [availableModels]);

  // Apply one file's correction from an LLM retry response: SEARCH/REPLACE → edit endpoint,
  // otherwise a full-file block → write endpoint. Returns true if the file was changed.
  const applyCorrectionForFile = useCallback(async (path: string, response: string): Promise<boolean> => {
    if (!currentProject?.id) return false;
    const body = extractFileBlock(response, path);
    if (!body) return false;
    const hunks = parseEditBlocks(body);
    try {
      if (hunks.length > 0) {
        const r = await fetch(`/api/projects/${currentProject.id}/files/edit?loose=true`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, edits: hunks }),
        });
        const d = await r.json().catch(() => ({}));
        if ((d?.applied || 0) > 0) { if (typeof d.content === 'string') setAllFileContents(prev => ({ ...prev, [path]: d.content })); return true; }
        return false;
      }
      // Full-file replacement — no guard here (this is an explicit, user-visible correction).
      const clean = body.trimEnd() + '\n';
      const r = await fetch(`/api/projects/${currentProject.id}/files/write`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: clean }),
      });
      if (r.ok) { setAllFileContents(prev => ({ ...prev, [path]: clean })); return true; }
      return false;
    } catch { return false; }
  }, [currentProject?.id, setAllFileContents]);

  // Escalating recovery when SEARCH/REPLACE hunks fail to match, in three visible stages:
  //   1. "digging deeper"    — retry the same hunks with the looser backend matcher (no LLM)
  //   2. "double checking"   — re-read each file fresh, ask the model to redo the edit against it
  //   3. "need more info"    — give up gracefully and ask the user to clarify
  const recoverFailedEdits = useCallback(async (failed: Array<{ path: string; hunks: EditHunk[] }>) => {
    if (!currentProject?.id || failed.length === 0) return;
    const pid = currentProject.id;
    // Recovery status chatter renders as compact activity rows; only the final
    // "need more information" ask (which requires the user) gets a full bubble.
    const post = (content: string, kind?: 'activity') => setMessages(prev => [...prev, {
      id: `edit-recover-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'system' as const, kind, content, timestamp: Date.now(),
    }]);
    const refreshFile = (path: string) => {
      fetch(`/api/projects/${pid}/files/read?path=${encodeURIComponent(path)}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (typeof d?.content === 'string') { setAllFileContents(prev => ({ ...prev, [path]: d.content })); updateTabContentByPath(path, d.content); } })
        .catch(() => {});
    };

    // --- Stage 1: digging deeper (looser backend match) ---
    post('🔍 Digging deeper — retrying the change with a looser match…', 'activity');
    let remaining: Array<{ path: string; hunks: EditHunk[] }> = [];
    for (const { path, hunks } of failed) {
      try {
        const r = await fetch(`/api/projects/${pid}/files/edit?loose=true`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, edits: hunks }),
        });
        const d = await r.json().catch(() => ({}));
        const stillFailed: EditHunk[] = Array.isArray(d?.failed) ? d.failed : hunks;
        if ((d?.applied || 0) > 0 && typeof d.content === 'string') { setAllFileContents(prev => ({ ...prev, [path]: d.content })); updateTabContentByPath(path, d.content); }
        if (stillFailed.length > 0) remaining.push({ path, hunks: stillFailed });
      } catch {
        remaining.push({ path, hunks });
      }
    }
    if (remaining.length === 0) { post('✅ Recovered on a looser match — the change is applied.', 'activity'); return; }

    // --- Stage 2: double checking files (LLM redo against fresh content) ---
    post('📂 Double checking files — re-reading them and asking the model to redo the change…', 'activity');
    const nextRemaining: Array<{ path: string; hunks: EditHunk[] }> = [];
    for (const { path, hunks } of remaining) {
      try {
        const fr = await fetch(`/api/projects/${pid}/files/read?path=${encodeURIComponent(path)}`);
        const fd = fr.ok ? await fr.json().catch(() => null) : null;
        const current = typeof fd?.content === 'string' ? fd.content : null;
        if (current == null) { nextRemaining.push({ path, hunks }); continue; }
        const intended = hunks.map((h, i) => `Intended change ${i + 1} — new text:\n${h.replace}`).join('\n\n');
        const sys = `You are editing files in the project "${currentProject.name}". To change part of a file, output a SEARCH/REPLACE block inside a path-tagged code block:\n\`\`\`:${path}\n<<<<<<< SEARCH\n<lines copied EXACTLY from the current file>\n=======\n<new lines>\n>>>>>>> REPLACE\n\`\`\`\nThe SEARCH text must match the current file character-for-character. If that's impractical, output the COMPLETE corrected file in a \`\`\`:${path}\` block instead. Output ONLY the code block.`;
        const user = `A previous SEARCH/REPLACE edit to \`${path}\` did not match and was not applied. Here is the EXACT current content of \`${path}\`:\n\n\`\`\`\n${current}\n\`\`\`\n\n${intended}\n\nRe-emit the change so it applies cleanly.`;
        const response = await streamChat([{ role: 'system', content: sys }, { role: 'user', content: user }]);
        const ok = await applyCorrectionForFile(path, response);
        if (ok) refreshFile(path); else nextRemaining.push({ path, hunks });
      } catch {
        nextRemaining.push({ path, hunks });
      }
    }
    if (nextRemaining.length === 0) { post('✅ Recovered after re-checking the files — the change is applied.', 'activity'); return; }

    // --- Stage 3: need more information ---
    const files = nextRemaining.map(f => `\`${f.path}\``).join(', ');
    post(`❓ I need more information. I couldn't confidently apply the change to ${files} — the section I was trying to edit doesn't line up with what's currently in the file. Could you point me at the exact lines to change (or paste them here)? Nothing was left half-applied, and you can still abandon the earlier changes above.`);
  }, [currentProject?.id, streamChat, applyCorrectionForFile, updateTabContentByPath, setAllFileContents]);

  // Keep the ref current so applyAssistantOutput (defined earlier) can call the latest version.
  recoverFailedEditsRef.current = recoverFailedEdits;

  const handleSendMessage = useCallback(async (content: string, attachments?: any[], options?: { preferHermes?: boolean }) => {
    // Auto-create a session if none exists
    let sessionId = currentSession?.id;
    if (!sessionId && currentProject?.id) {
      const session = await createSession({ title: content.slice(0, 50) });
      if (session) {
        sessionId = session.id;
      } else {
        // Fallback: still show messages locally even if session creation fails
        sessionId = undefined;
      }
    }

    // Resolve any active agent role(s) — applied as a silent system instruction and shown as chips.
    const activeAgents = activeAgentIds
      .map(id => getAgent(id))
      .filter((a): a is NonNullable<typeof a> => !!a);
    const agentLabels = activeAgents.map(a => `${a.icon} ${a.name}`);

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments,
      agentLabels: agentLabels.length ? agentLabels : undefined,
    };

    setMessages((prev) => [...prev, userMessage]);

    // Nudge toward the staged workflow: freeform one-shot edits on a GENUINELY large project are
    // where out-of-context mistakes happen. A task's Plan stage picks the affected files up front.
    // Fires at most once per session, only when no task is active, only above WORKFLOW_NUDGE_LIMIT,
    // and never once the user has clicked "Don't show again" (persisted in localStorage).
    const corpusSize = Object.values(allFileContents).reduce((n, c) => n + c.length, 0);
    const nudgeSuppressed = localStorage.getItem(WORKFLOW_NUDGE_SUPPRESS_KEY) === '1';
    if (!workflow.activeTask && corpusSize > WORKFLOW_NUDGE_LIMIT && !workflowNudgeShownRef.current && !nudgeSuppressed && currentProject?.id) {
      workflowNudgeShownRef.current = true;
      setMessages(prev => [...prev, {
        id: `wf-nudge-${Date.now()}`,
        role: 'system' as const,
        content: `💡 **Tip:** this project is large, so freeform edits only see part of it. For multi-file changes, the **staged workflow** is more reliable — an Architect first plans which files are affected, and that plan scopes every later step.`,
        timestamp: Date.now(),
        suggestTaskTitle: content.slice(0, 80),
      }]);
    }

    setIsGenerating(true);

    // Create abort controller for this request
    abortRef.current?.abort(); // abort any previous
    const controller = new AbortController();
    abortRef.current = controller;

    // Save user message to backend if we have a session
    if (sessionId) {
      addMessage({ role: 'user', content }).catch(console.error);
    }

    // Try real backend connection, fall back to simulation
    try {
      const activeEndpoint = useAppStore.getState().activeEndpoint;
      const endpointId = activeEndpoint?.id;

      const params = new URLSearchParams();
      if (endpointId) params.set('endpoint_id', endpointId);

      // Any project file the user names in their message gets pulled into this request's
      // context and persisted to the working set — so "fix the nav in styles.css" works in
      // large (scoped-context) projects without the model having to @read first.
      const mentioned = Object.keys(allFileContents).filter(p => {
        const base = p.split('/').pop() || p;
        return content.includes(p) || (base.length > 3 && content.toLowerCase().includes(base.toLowerCase()));
      }).slice(0, 8);
      if (mentioned.length > 0) {
        setWorkingSetPaths(prev => Array.from(new Set([...prev, ...mentioned])));
      }

      // Build system context from the current project (shared with the manual Continue path).
      const systemContent = buildSystemContext(content, mentioned);
      const systemMessage = systemContent ? { role: 'system' as const, content: systemContent } : null;

      // History goes out with older assistant code blocks collapsed to placeholders — the
      // system context above is the single source of truth for current file contents.
      const chatMessages = [
        ...(systemMessage ? [systemMessage] : []),
        ...messages.map(m => ({
          role: m.role,
          content: m.role === 'assistant' ? stripHistoryCodeBlocks(m.content) : m.content,
        })),
        { role: userMessage.role, content: userMessage.content },
      ];

      const modelId = availableModels[0]?.id || 'deepseek-chat';

      // Route to the Hermes agent when Agent mode is on, or an agent button forced it, and a
      // connection exists; otherwise use the standard LLM chat stream. Both endpoints emit the
      // same SSE event shape, so the streaming loop below is identical either way.
      const useHermes = (agentMode || options?.preferHermes || activeAgents.length > 0) && !!hermesConnection;

      // Create placeholder immediately so the user sees streaming output in real-time
      const aiMsgId = (Date.now() + 1).toString();
      setMessages(prev => [...prev, {
        id: aiMsgId,
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
        via: useHermes ? 'hermes' : 'llm',
      }]);

      let fullContent = '';
      let reasoningContent = '';

      const res = useHermes
        ? await fetch('/api/hermes/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: chatMessages, model: modelId, project_path: currentProject?.name }),
            signal: controller.signal,
          })
        : await fetch(`/api/models/${modelId}/chat?${params.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: chatMessages }),
            signal: controller.signal,
          });

      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error');
        console.error('Chat API returned', res.status, errText);
        // Try to extract a JSON { error } message; otherwise include the raw body snippet.
        let detail = errText;
        try { detail = JSON.parse(errText).error || errText; } catch { /* keep raw */ }
        throw new Error(`${useHermes ? 'Hermes' : 'LLM'} request failed (HTTP ${res.status}): ${String(detail).slice(0, 300)}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      let finishReason = '';
      let usage: Message['usage'] | undefined;
      // Accumulate token usage across the initial response + any auto-continuations.
      const mergeUsage = (raw: string) => {
        try {
          const u = JSON.parse(raw);
          usage = {
            prompt_tokens: (usage?.prompt_tokens || 0) + (u.prompt_tokens || 0),
            completion_tokens: (usage?.completion_tokens || 0) + (u.completion_tokens || 0),
            total_tokens: (usage?.total_tokens || 0) + (u.total_tokens || 0),
          };
        } catch { /* ignore malformed usage payloads */ }
      };
      for await (const { eventType, data } of parseSSEStream(reader)) {
        if (eventType === 'finish_reason') finishReason = data;
        else if (eventType === 'usage') mergeUsage(data);
        else if (eventType === 'reasoning') reasoningContent += data;
        else fullContent += data;
        setMessages(prev => prev.map(m =>
          m.id === aiMsgId
            ? { ...m, content: fullContent, reasoning: reasoningContent || undefined, usage }
            : m
        ));
      }

      // Auto-continue when the model stopped at its output-token cap (finish_reason="length"),
      // appending onto the SAME message bubble. Capped at MAX_AUTO_CONTINUE and abort-aware (the
      // Stop button halts it), so a verbose model can't run away with the user's cloud tokens.
      // When the cap is reached we leave `truncated` true so the manual Continue button takes over.
      let autoCount = 0;
      while (
        finishReason === 'length' &&
        autoContinue &&
        autoCount < MAX_AUTO_CONTINUE &&
        !controller.signal.aborted
      ) {
        autoCount++;
        setMessages(prev => prev.map(m =>
          m.id === aiMsgId ? { ...m, truncated: false, continuing: true, autoContinueCount: autoCount } : m
        ));
        finishReason = '';
        const contMessages = [
          ...chatMessages,
          { role: 'assistant' as const, content: fullContent },
          { role: 'user' as const, content: 'Continue exactly where you left off. Do not repeat any text you already wrote.' },
        ];
        let contRes: Response;
        try {
          contRes = useHermes
            ? await fetch('/api/hermes/run', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: contMessages, model: modelId, project_path: currentProject?.name }),
                signal: controller.signal,
              })
            : await fetch(`/api/models/${modelId}/chat?${params.toString()}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: contMessages }), signal: controller.signal,
              });
        } catch (e: any) {
          if (e?.name === 'AbortError') break;
          throw e;
        }
        if (!contRes.ok) break;
        const contReader = contRes.body?.getReader();
        if (!contReader) break;
        // Accumulate the continuation separately and re-stitch on every chunk, so duplicate
        // fence openers / repeated lines at the seam are stripped even while streaming.
        const contBase = fullContent;
        let contBuf = '';
        for await (const { eventType, data } of parseSSEStream(contReader)) {
          if (eventType === 'finish_reason') finishReason = data;
          else if (eventType === 'usage') mergeUsage(data);
          else if (eventType === 'reasoning') { /* ignore reasoning on continuation */ }
          else {
            contBuf += data;
            fullContent = contBase + stitchContinuation(contBase, contBuf);
          }
          setMessages(prev => prev.map(m =>
            m.id === aiMsgId ? { ...m, content: fullContent, usage } : m
          ));
        }
      }

      // Final flags: still "truncated" only if it ended on "length" (cap reached, or auto-continue
      // off) so the manual Continue button appears; clear the in-progress "continuing" status.
      setMessages(prev => prev.map(m =>
        m.id === aiMsgId
          ? { ...m, content: fullContent, truncated: finishReason === 'length', continuing: false, autoContinueCount: autoCount, usage }
          : m
      ));

      if (fullContent || reasoningContent) {
        if (sessionId) {
          addMessage({ role: 'assistant', content: fullContent }).catch(console.error);
        }
        applyAssistantOutput(fullContent);
      }

      // Context discipline: honor any `@read path` requests the model made (it asks for files it
      // wasn't given in scoped mode). Add them to the working set, feed their contents straight
      // back in, and let the model pick up where it left off — up to MAX_AUTO_READ_ROUNDS times —
      // instead of leaving the user to type "continue" themselves. Mirrors the token-cap
      // auto-continue above: same autoContinue toggle, same "never loop forever" guarantee.
      let pendingContent = fullContent;
      let pendingChatMessages = chatMessages;
      let readRounds = 0;
      while (!controller.signal.aborted && currentProject?.id) {
        const requestedRaw = [...pendingContent.matchAll(/^\s*@read\s+(.+?)\s*$/gm)]
          .map(m => m[1].trim().replace(/^['"`]|['"`]$/g, ''))
          .filter(Boolean);
        // `@search term` lets the model FIND the right file when neither it nor the user
        // knows the filename (complex projects) — results come from the project grep
        // endpoint, after which the model typically @reads the files it located.
        const searchQueries = [...pendingContent.matchAll(/^\s*@search\s+(.+?)\s*$/gm)]
          .map(m => m[1].trim().replace(/^['"`]|['"`]$/g, ''))
          .filter(Boolean)
          .slice(0, 3);
        if (requestedRaw.length === 0 && searchQueries.length === 0) break;

        // Resolve @read from DISK, not the in-memory map: the map can lag behind writes made
        // earlier in this same conversation, which used to silently drop those requests.
        const resolvedFiles: Array<[string, string]> = [];
        const missing: string[] = [];
        for (const p of requestedRaw) {
          try {
            const r = await fetch(`/api/projects/${currentProject.id}/files/read?path=${encodeURIComponent(p)}`);
            const d = r.ok ? await r.json().catch(() => null) : null;
            if (typeof d?.content === 'string') resolvedFiles.push([p, d.content]);
            else missing.push(p);
          } catch {
            missing.push(p);
          }
        }
        if (missing.length > 0) {
          setMessages(prev => [...prev, {
            id: `ctx-miss-${Date.now()}`,
            role: 'system' as const,
            kind: 'activity' as const,
            content: `⚠️ Requested file(s) not found: ${missing.join(', ')}`,
            timestamp: Date.now(),
          }]);
        }

        // Run @search queries against the project grep endpoint (ripgrep server-side).
        const searchBlocks: string[] = [];
        for (const q of searchQueries) {
          try {
            const r = await fetch(`/api/projects/${currentProject.id}/search?q=${encodeURIComponent(q)}&max=25`);
            const d = r.ok ? await r.json().catch(() => null) : null;
            const hits: Array<{ path: string; line: number; text: string }> = d?.matches || [];
            searchBlocks.push(
              hits.length > 0
                ? `Results for "${q}" (path:line: text):\n${hits.map(h => `- ${h.path}:${h.line}: ${h.text}`).join('\n')}`
                : `Results for "${q}": no matches.`
            );
          } catch {
            searchBlocks.push(`Results for "${q}": search failed.`);
          }
        }

        if (resolvedFiles.length === 0 && searchBlocks.length === 0) break;
        const requested = resolvedFiles.map(([p]) => p);
        if (requested.length > 0) {
          setWorkingSetPaths(prev => Array.from(new Set([...prev, ...requested])));
        }

        // Human-readable summary of what this round pulled in.
        const pulled = [
          requested.length > 0 ? `📎 Added to context: ${requested.join(', ')}` : '',
          searchQueries.length > 0 ? `🔎 Searched: ${searchQueries.map(q => `"${q}"`).join(', ')}` : '',
        ].filter(Boolean).join(' · ');

        if (!autoContinue || readRounds >= MAX_AUTO_READ_ROUNDS) {
          setMessages(prev => [...prev, {
            id: `ctx-${Date.now()}`,
            role: 'system' as const,
            kind: 'activity' as const,
            content: `${pulled} — send your next message (or "continue") and the results will be included.`,
            timestamp: Date.now(),
          }]);
          break;
        }

        readRounds++;
        setMessages(prev => [...prev, {
          id: `ctx-${Date.now()}`,
          role: 'system' as const,
          kind: 'activity' as const,
          content: `${pulled} — continuing automatically…`,
          timestamp: Date.now(),
        }]);

        const feedbackParts: string[] = [];
        if (resolvedFiles.length > 0) {
          feedbackParts.push(`Here are the file(s) you requested:\n\n${resolvedFiles.map(([p, c]) => fmtFile(p, c)).join('\n\n')}`);
        }
        if (searchBlocks.length > 0) {
          feedbackParts.push(`Search results:\n\n${searchBlocks.join('\n\n')}`);
        }
        pendingChatMessages = [
          ...pendingChatMessages,
          { role: 'assistant' as const, content: pendingContent },
          { role: 'user' as const, content: `${feedbackParts.join('\n\n')}\n\nContinue the task using this context. You may issue further \`@read\` or \`@search\` lines if you still need more.` },
        ];

        const roundMsgId = `${aiMsgId}-read${readRounds}`;
        setMessages(prev => [...prev, { id: roundMsgId, role: 'assistant' as const, content: '', timestamp: Date.now(), via: useHermes ? 'hermes' : 'llm' }]);

        let roundContent = '';
        let roundFinishReason = '';
        let roundUsage: Message['usage'] | undefined;
        try {
          const roundRes = useHermes
            ? await fetch('/api/hermes/run', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: pendingChatMessages, model: modelId, project_path: currentProject?.name }),
                signal: controller.signal,
              })
            : await fetch(`/api/models/${modelId}/chat?${params.toString()}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: pendingChatMessages }), signal: controller.signal,
              });
          if (!roundRes.ok) break;
          const roundReader = roundRes.body?.getReader();
          if (!roundReader) break;
          for await (const { eventType, data } of parseSSEStream(roundReader)) {
            if (eventType === 'finish_reason') roundFinishReason = data;
            else if (eventType === 'usage') {
              try {
                const u = JSON.parse(data);
                roundUsage = {
                  prompt_tokens: (roundUsage?.prompt_tokens || 0) + (u.prompt_tokens || 0),
                  completion_tokens: (roundUsage?.completion_tokens || 0) + (u.completion_tokens || 0),
                  total_tokens: (roundUsage?.total_tokens || 0) + (u.total_tokens || 0),
                };
              } catch { /* ignore malformed usage payloads */ }
            }
            else if (eventType === 'reasoning') { /* ignore reasoning on auto-read rounds */ }
            else roundContent += data;
            setMessages(prev => prev.map(m => m.id === roundMsgId ? { ...m, content: roundContent, usage: roundUsage } : m));
          }
        } catch (e: any) {
          if (e?.name === 'AbortError') break;
          throw e;
        }

        setMessages(prev => prev.map(m =>
          m.id === roundMsgId ? { ...m, content: roundContent, truncated: roundFinishReason === 'length', usage: roundUsage } : m
        ));
        if (roundContent) {
          if (sessionId) addMessage({ role: 'assistant', content: roundContent }).catch(console.error);
          applyAssistantOutput(roundContent);
        }
        pendingContent = roundContent;
      }

      // If a Plan-stage response wrote the task spec, reload it so the panel + context pick it up.
      if (workflow.activeTaskId && pendingContent.includes(`tasks/${workflow.activeTaskId}/spec.md`)) {
        workflow.loadTask(workflow.activeTaskId).catch(() => {});
      }

      setIsGenerating(false);
    } catch (err: any) {
      // Don't show an error if the user intentionally stopped generation. Clear any in-progress
      // auto-continuation status and leave the message resumable via the manual Continue button.
      if (err?.name === 'AbortError') {
        setMessages(prev => prev.map(m => m.continuing ? { ...m, continuing: false, truncated: true } : m));
        setIsGenerating(false);
        return;
      }
      console.error('Chat request failed:', err);
      // Surface the real error so the user can debug (e.g. a Hermes/LLM failure) instead of a
      // misleading "simulated response".
      setMessages((prev) => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'system' as const,
        content: `⚠️ Request failed: ${err?.message || 'Unknown error'}`,
        timestamp: Date.now(),
      }]);
      setIsGenerating(false);
    }
  }, [messages, currentSession, currentProject, createSession, addMessage, availableModels, applyAssistantOutput, agentMode, hermesConnection, activeAgentIds, getAgent, autoContinue, buildSystemContext, allFileContents, workflow.activeTaskId, workflow.loadTask]);

  // Manually continue a response that was cut off by the model's output-token limit.
  // Triggered by the user clicking "Continue" on a truncated message — never automatic,
  // so the user explicitly authorizes the additional token spend. Appends the new text
  // onto the existing (truncated) assistant message rather than creating a new bubble.
  const handleContinueGeneration = useCallback(async (truncatedMsgId: string) => {
    const targetIndex = messages.findIndex(m => m.id === truncatedMsgId);
    if (targetIndex === -1) return;
    const targetMsg = messages[targetIndex];

    setIsGenerating(true);
    setMessages(prev => prev.map(m => m.id === truncatedMsgId ? { ...m, truncated: false } : m));

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const activeEndpoint = useAppStore.getState().activeEndpoint;
      const params = new URLSearchParams();
      if (activeEndpoint?.id) params.set('endpoint_id', activeEndpoint.id);
      const modelId = availableModels[0]?.id || 'deepseek-chat';

      // Send the full system context (previously this path sent NONE — continuations had no
      // project files or editing rules), then the conversation up to and including the
      // truncated message. Older assistant code blocks are stripped like in handleSendMessage;
      // the truncated message itself stays intact — the model continues from its own text.
      const systemContent = buildSystemContext(targetMsg.content.slice(-2000));
      const priorMessages = messages.slice(0, targetIndex + 1).map((m, i) => ({
        role: m.role,
        content: m.role === 'assistant' && i < targetIndex ? stripHistoryCodeBlocks(m.content) : m.content,
      }));
      const chatMessages = [
        ...(systemContent ? [{ role: 'system' as const, content: systemContent }] : []),
        ...priorMessages,
        { role: 'user' as const, content: 'Continue exactly where you left off. Do not repeat any text you already wrote.' },
      ];

      const res = await fetch(`/api/models/${modelId}/chat?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatMessages }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Backend returned ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const contBase = targetMsg.content;
      let contBuf = '';
      let fullContent = contBase;
      let finishReason = '';
      let usage = targetMsg.usage;
      const mergeUsage = (raw: string) => {
        try {
          const u = JSON.parse(raw);
          usage = {
            prompt_tokens: (usage?.prompt_tokens || 0) + (u.prompt_tokens || 0),
            completion_tokens: (usage?.completion_tokens || 0) + (u.completion_tokens || 0),
            total_tokens: (usage?.total_tokens || 0) + (u.total_tokens || 0),
          };
        } catch { /* ignore malformed usage payloads */ }
      };
      for await (const { eventType, data } of parseSSEStream(reader)) {
        if (eventType === 'finish_reason') finishReason = data;
        else if (eventType === 'usage') mergeUsage(data);
        else if (eventType === 'reasoning') { /* ignore reasoning on continuation */ }
        else {
          // Re-stitch on every chunk — strips duplicate fence openers / repeated lines at
          // the seam so the code-block rendering stays balanced (see stitchContinuation).
          contBuf += data;
          fullContent = contBase + stitchContinuation(contBase, contBuf);
        }
        setMessages(prev => prev.map(m =>
          m.id === truncatedMsgId ? { ...m, content: fullContent, usage } : m
        ));
      }

      setMessages(prev => prev.map(m =>
        m.id === truncatedMsgId ? { ...m, content: fullContent, truncated: finishReason === 'length', usage } : m
      ));
      if (currentSession?.id) {
        addMessage({ role: 'assistant', content: fullContent }).catch(console.error);
      }
      applyAssistantOutput(fullContent);
    } catch (err: any) {
      if (err?.name !== 'AbortError') console.error('Continue failed:', err);
    } finally {
      setIsGenerating(false);
    }
  }, [messages, availableModels, currentSession?.id, addMessage, applyAssistantOutput, buildSystemContext]);

  // Shared agent trigger — used by ChatPane quick-actions and the editor toolbar. Agents run
  // through the same chat flow as a normal message (so they get full project context and their
  // returned code blocks are applied to files), and force routing to Hermes when connected.
  const triggerAgent = useCallback((agentId: string, task: string) => {
    if (!currentProject?.id) {
      setMessages(prev => [...prev, {
        id: `agent-guard-${Date.now()}`,
        role: 'system' as const,
        content: 'Select or create a project first — agents work on the active project.',
        timestamp: Date.now(),
      }]);
      return;
    }
    const agent = getAgent(agentId);
    const prompt = agent
      ? `${agent.icon} Act as the ${agent.name} (${agent.role}). ${task}`
      : task;
    // preferHermes routes to Hermes when a connection exists; falls back to the local LLM otherwise.
    handleSendMessage(prompt, undefined, { preferHermes: true });
  }, [currentProject?.id, getAgent, handleSendMessage]);

  // Hand a failed deployment's build log to the connected LLM to fix (from the Self-Host Wizard).
  // Posts the log into chat as a fix request; the LLM's returned code blocks are applied to files,
  // after which the user can redeploy.
  const handleFixBuildError = useCallback((logs: string, appName: string, opts?: { fallback?: boolean; status?: string }) => {
    const prompt = (opts?.fallback || !logs.trim())
      // Fallback: the platform couldn't return the build log (e.g. Dokploy's readLogs is broken for
      // remote-server deployments — it stores no serverId on the deployment row). The LLM still has
      // the full project (Dockerfile + files) in context, so ask it to review proactively.
      ? `The deployment of "${appName}" failed (status: ${opts?.status || 'error'}), but the build log could not be retrieved from the hosting platform (a known limitation reading logs from remote deploy servers). Without the log, carefully review THIS project's Dockerfile and build configuration for the most likely causes of a failed Docker build, and fix them. Check especially: files referenced by COPY/ADD that may not exist (e.g. package-lock.json, the build output/dist directory), the base image and the build/start commands, EXPOSE vs the port the server actually listens on, and the dependency-install steps. Apply concrete fixes as code blocks and briefly explain what you changed and why.`
      : `The deployment of "${appName}" failed during the build. Here is the build log:\n\n\`\`\`\n${logs}\n\`\`\`\n\nDiagnose the root cause and fix it directly in the project files (Dockerfile, package.json, build config, or source as appropriate). Apply the fixes as code blocks. Keep changes minimal and focused on making the build succeed.`;
    handleSendMessage(prompt);
  }, [handleSendMessage]);

  // Run a workflow stage through the chat flow. Each stage acts as its role and works against the
  // task spec (already in context). preferHermes hands the stage to the Hermes agent (hybrid mode).
  // taskOverride lets a caller run a stage on a JUST-created task before React state has caught up
  // (used by the chat's "create a task & plan it" nudge button).
  const runStage = useCallback((stage: Stage, preferHermes = false, taskOverride?: TaskMeta) => {
    const task = taskOverride ?? workflow.activeTask;
    if (!task) return;
    const specText = taskOverride ? '' : workflow.spec;
    let prompt = '';
    switch (stage) {
      case 'plan':
        prompt = `🏗️ Act as the Architect for the task "${task.title}". Here is the current spec:\n\n${specText || '(empty)'}\n\nProduce the COMPLETE updated specification — fill in Goal, concrete checkable Acceptance Criteria, a Definition of Done, the Affected Files (real paths from the project tree), and the Approach. Output it as a single fenced code block written to the spec file:\n\n\`\`\`md:.monastery/tasks/${task.id}/spec.md\n<full spec here>\n\`\`\``;
        break;
      case 'implement':
        prompt = `💻 Act as the Coder for the task "${task.title}". Implement strictly per the spec (in context). Make minimal, focused edits to the affected files only. Output each changed/new file as a fenced code block with its path (e.g. \`\`\`ts:src/foo.ts).`;
        break;
      case 'review':
        prompt = `🔍 Act as the Reviewer for the task "${task.title}". Review the current code against the Acceptance Criteria and Definition of Done in the spec. List any gaps, bugs, or anti-patterns. If it fully meets the bar, reply with "APPROVED" and a one-line rationale.`;
        break;
      default:
        return; // 'verify' runs the build/test command (panel button); 'done' has no stage prompt
    }
    handleSendMessage(prompt, undefined, preferHermes ? { preferHermes: true } : undefined);
  }, [workflow.activeTask, workflow.spec, handleSendMessage]);

  const handleStopGeneration = useCallback(() => {
    abortRef.current?.abort();
    setIsGenerating(false);
  }, []);

  return {
    messages,
    setMessages,
    isGenerating,
    autoContinue,
    setAutoContinue,
    agentMode,
    setAgentMode,
    activeSkillIds,
    toggleSkill,
    activeAgentIds,
    toggleActiveAgent,
    handleSendMessage,
    handleContinueGeneration,
    handleStopGeneration,
    triggerAgent,
    handleFixBuildError,
    runStage,
  };
}
