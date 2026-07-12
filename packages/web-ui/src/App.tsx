import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { ChatPane } from './components/ChatPane';
import { CodeEditor } from './components/CodeEditor';
import { PreviewPane } from './components/PreviewPane';
import { SelfHostWizard } from './components/SelfHostWizard';
import { useAppStore } from './store/useAppStore';
import { useSessions } from './hooks/useSessions';
import { useEndpoints } from './hooks/useEndpoints';
import { useAgents } from './hooks/useAgents';
import { useHermesAgent } from './hooks/useHermesAgent';
import { useHostingServices } from './hooks/useHostingServices';
import { buildSkillInstructions } from './lib/skills';
import { useWorkflow, WORKFLOW_ROLE_IDS, type Stage, type TaskMeta } from './hooks/useWorkflow';
import { WorkflowPanel } from './components/WorkflowPanel';
import { parseSSEStream } from './lib/sse';
import { Message } from './types';

// Below this total corpus size the whole project is sent as context; above it, only the
// active file + working set (scoped mode). Also the threshold for nudging users toward the
// staged workflow, whose task specs pre-scope the right files.
const SMALL_PROJECT_LIMIT = 64_000; // ~16K tokens

// Format one file for the PROJECT FILE CONTENTS context block.
const fmtFile = (path: string, content: string) => {
  const ext = path.split('.').pop() || '';
  return `### ${path}\n\`\`\`${ext}\n${content}\n\`\`\``;
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

export default function App() {
  const { sidebarCollapsed, previewCollapsed, paneLayout, updatePaneLayout, theme, currentProject, setCurrentProject } = useAppStore();
  
  // Multi-tab editor state
  interface EditorTab { path: string; content: string; isDirty: boolean; }
  // Binary image formats get an image viewer instead of Monaco (SVG stays editable text).
  const isImagePath = (p: string) =>
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif'].includes(p.split('.').pop()?.toLowerCase() || '');
  const [openTabs, setOpenTabs] = useState<EditorTab[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const activeTab = openTabs[activeTabIndex];
  const currentFile = activeTab?.path || '';
  const editorContent = activeTab?.content || '// Select a file to edit';
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [projectFiles, setProjectFiles] = useState<any[]>([]);
  const [availableProjects, setAvailableProjects] = useState<any[]>([]);
  const [allFileContents, setAllFileContents] = useState<Record<string, string>>({});
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string }>>([]);
  // When on, chat messages are routed to the Hermes agent instead of plain LLM streaming.
  // Only selectable when a default Hermes connection is configured.
  const [agentMode, setAgentMode] = useState(false);
  // When on, the LLM system context includes Pocketbase + deployment instructions (with the
  // configured Pocketbase URL). Toggled by the user when building a DB-backed app.
  const [useDatabaseContext, setUseDatabaseContext] = useState(false);
  // Auto-continue a response that hits the model's output-token cap (finish_reason="length"),
  // up to MAX_AUTO_CONTINUE times, then fall back to the manual Continue button. Capped on
  // purpose: unbounded auto-continue can burn cloud (e.g. DeepSeek) tokens on verbose models.
  const [autoContinue, setAutoContinue] = useState(true);
  const MAX_AUTO_CONTINUE = 5;
  // Same idea, separate cap: rounds where the model asked for context via `@read`/`@search`
  // and got results auto-fed back in. Kept small and distinct from MAX_AUTO_CONTINUE since
  // each round is a full extra request (not just an appended chunk). 4 allows the full
  // discovery chain in a complex project: search → read → (read more) → edit.
  const MAX_AUTO_READ_ROUNDS = 4;
  // Context discipline: in large projects we don't dump the whole repo into every message. The
  // "working set" is the subset of files (beyond the active file) currently included in context —
  // seeded by a task spec's affected-files later, and grown when the model emits `@read <path>`.
  const [workingSetPaths, setWorkingSetPaths] = useState<string[]>([]);
  // Active agent role(s) — a persistent "lens" applied to chat messages. Capped to keep focus.
  const MAX_ACTIVE_ROLES = 2;
  const [activeAgentIds, setActiveAgentIds] = useState<string[]>([]);
  const toggleActiveAgent = useCallback((id: string) => {
    setActiveAgentIds(ids =>
      ids.includes(id)
        ? ids.filter(x => x !== id)
        : ids.length < MAX_ACTIVE_ROLES ? [...ids, id] : ids
    );
  }, []);
  const abortRef = useRef<AbortController | null>(null);
  // Workflow nudge: suggested at most once per session/project (reset below) when a freeform
  // request hits a large project without an active task.
  const workflowNudgeShownRef = useRef(false);

  // Endpoints for LLM selector in TopBar
  const { endpoints } = useEndpoints();
  // Hermes agent: a default connection enables the "Agent mode" toggle in the chat.
  const { defaultConnection: hermesConnection } = useHermesAgent();
  // Pocketbase: a configured connection enables the "Pocketbase backend" toggle + its URL is
  // injected into the LLM context and into deploys.
  const { connections: hostingConns } = useHostingServices();
  const pocketbaseConn = hostingConns.find((c: any) => c.service_type === 'pocketbase');
  // Staged coding workflow (SAW-inspired): task spec + stages + gates + evidence, stored locally.
  const workflow = useWorkflow(currentProject?.id);
  // When a task is active, its stage roles are driven by the Workflow panel — drop any active
  // stage-role chips so a now-hidden role can't keep silently injecting into context.
  useEffect(() => {
    if (workflow.activeTask) {
      setActiveAgentIds(ids => ids.filter(id => !WORKFLOW_ROLE_IDS.includes(id)));
    }
  }, [workflow.activeTask?.id]);

  // Fetch available models whenever endpoints change so we always send the right model ID
  useEffect(() => {
    if (endpoints.length === 0) return;
    fetch('/api/models')
      .then(r => r.ok ? r.json() : [])
      .then((m: Array<{ id: string }>) => { if (m.length > 0) setAvailableModels(m); })
      .catch(() => {});
  }, [endpoints]);

  // Session management
  const {
    sessions,
    currentSession,
    isLoading: isLoadingSessions,
    fetchSessions,
    createSession,
    getSession,
    deleteSession,
    addMessage,
  } = useSessions(currentProject?.id ?? null);

  // Agent system (execution is unified through handleSendMessage; see triggerAgent below)
  const { getAgent, editorPrompts } = useAgents();

  // Sync persisted theme with the HTML data-theme attribute on load
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Keyboard shortcut: Ctrl+Shift+D opens Self-Host Wizard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setIsWizardOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // On startup, fetch existing projects and auto-select if none active
  const refreshProjects = useCallback(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then((projects: any[]) => {
        setAvailableProjects(projects);
        if (projects.length > 0 && !useAppStore.getState().currentProject) {
          const recent = projects[0];
          setCurrentProject({
            id: recent.id,
            name: recent.name,
            path: '',
            lastOpened: Date.now(),
            files: [],
          });
        }
      })
      .catch(() => {});
  }, [setCurrentProject]);

  useEffect(() => {
    refreshProjects();
  }, []); // Run once on mount

  // Fetch project files when currentProject changes
  useEffect(() => {
    // Clear tabs when switching projects
    setOpenTabs([]);
    setActiveTabIndex(0);
    
    if (!currentProject?.id) {
      setProjectFiles([]);
      setAllFileContents({});
      return;
    }
    fetch(`/api/projects/${currentProject.id}/files`)
      .then(r => r.json())
      .then(files => setProjectFiles(files))
      .catch(() => setProjectFiles([]));
    fetch(`/api/projects/${currentProject.id}/files/read-all`)
      .then(r => r.json())
      .then(data => setAllFileContents(data.files || {}))
      .catch(() => setAllFileContents({}));
  }, [currentProject?.id]);

  // Fetch sessions when project changes
  useEffect(() => {
    if (currentProject?.id) {
      fetchSessions();
    }
  }, [currentProject?.id, fetchSessions]);

  // A new session or project gets one fresh chance to show the workflow nudge.
  useEffect(() => {
    workflowNudgeShownRef.current = false;
  }, [currentProject?.id, currentSession?.id]);

  // Create a new session
  const handleCreateSession = useCallback(async () => {
    const session = await createSession();
    if (session) {
      setMessages([]);
    }
  }, [createSession]);

  // Select an existing session and load its messages
  const handleSelectSession = useCallback(async (sessionId: string) => {
    const session = await getSession(sessionId);
    if (session) {
      const msgs: Message[] = session.messages.map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
        timestamp: new Date(m.created_at).getTime(),
        model: m.model ?? undefined,
      }));
      setMessages(msgs);
    }
  }, [getSession]);

  // Delete a session
  const handleDeleteSession = useCallback(async (sessionId: string) => {
    await deleteSession(sessionId);
    if (currentSession?.id === sessionId) {
      setMessages([]);
    }
  }, [deleteSession, currentSession]);

  // Refresh the file tree after file operations
  const refreshFileTree = useCallback(() => {
    if (!currentProject?.id) return;
    fetch(`/api/projects/${currentProject.id}/files`)
      .then(r => r.json())
      .then(files => setProjectFiles(files))
      .catch(() => {});
    fetch(`/api/projects/${currentProject.id}/files/read-all`)
      .then(r => r.json())
      .then(data => setAllFileContents(data.files || {}))
      .catch(() => {});
  }, [currentProject?.id]);

  // When the window regains focus, do a lightweight re-read of the file tree so files written
  // outside Monastery (e.g. by Hermes on a shared workspace) show up without a manual refresh.
  useEffect(() => {
    const pid = currentProject?.id;
    if (!pid) return;
    const onFocus = () => {
      fetch(`/api/projects/${pid}/files`)
        .then(r => r.json())
        .then(files => setProjectFiles(files))
        .catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [currentProject?.id]);

  // Shared delete-with-confirmation helper
  const deleteWithConfirm = useCallback(async (
    path: string,
    endpoint: string,
    confirmMsg: string,
    onSuccess?: () => void,
  ) => {
    if (!currentProject?.id) return;
    if (!window.confirm(confirmMsg)) return;
    try {
      const res = await fetch(endpoint, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Delete failed:', data.error || res.statusText);
        return;
      }
      onSuccess?.();
      refreshFileTree();
    } catch (e) {
      console.error('Delete error:', e);
    }
  }, [currentProject?.id, refreshFileTree]);

  // Delete a file (user-initiated, no LLM)
  const handleDeleteFile = useCallback(async (path: string) => {
    const name = path.split('/').pop() || path;
    await deleteWithConfirm(
      path,
      `/api/projects/${currentProject!.id}/files?path=${encodeURIComponent(path)}`,
      `Delete "${name}"? This cannot be undone.`,
      () => setOpenTabs(prev => prev.filter(t => t.path !== path)),
    );
  }, [deleteWithConfirm]);

  // Create a new directory (user-initiated, no LLM)
  const handleCreateDirectory = useCallback(async (parentPath: string) => {
    if (!currentProject?.id) return;
    const name = window.prompt('Directory name:');
    if (!name || !name.trim()) return;
    const dirPath = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
    try {
      const res = await fetch(`/api/projects/${currentProject.id}/files/dir?path=${encodeURIComponent(dirPath)}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Create directory failed:', data.error || res.statusText);
        return;
      }
      refreshFileTree();
    } catch (e) {
      console.error('Create directory error:', e);
    }
  }, [currentProject?.id, refreshFileTree]);

  // Delete a directory (user-initiated, no LLM)
  const handleDeleteDirectory = useCallback(async (path: string) => {
    const name = path.split('/').pop() || path;
    await deleteWithConfirm(
      path,
      `/api/projects/${currentProject!.id}/files/dir?path=${encodeURIComponent(path)}`,
      `Delete directory "${name}" and ALL its contents? This cannot be undone.`,
      () => setOpenTabs(prev => prev.filter(t => !t.path.startsWith(path + '/'))),
    );
  }, [deleteWithConfirm]);

  // Create a new file (user-initiated, no LLM)
  const handleCreateFile = useCallback(async (parentPath: string) => {
    if (!currentProject?.id) return;
    const name = window.prompt('File name (e.g., index.ts):');
    if (!name || !name.trim()) return;
    const filePath = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
    try {
      const res = await fetch(`/api/projects/${currentProject.id}/files/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content: '' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Create file failed:', data.error || res.statusText);
        return;
      }
      refreshFileTree();
    } catch (e) {
      console.error('Create file error:', e);
    }
  }, [currentProject?.id, refreshFileTree]);

  // Upload a file to the project (user-initiated, no LLM)
  const handleUploadFile = useCallback(async (parentPath: string, file: File) => {
    if (!currentProject?.id) return;
    const filePath = parentPath ? `${parentPath}/${file.name}` : file.name;

    // Determine if this is a text-based file (should NOT be base64-encoded)
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const textExtensions = ['svg', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'json', 'xml', 'md', 'txt', 'yaml', 'yml', 'toml', 'env', 'gitignore', 'dockerfile', 'editorconfig', 'sh', 'bash', 'zsh', 'py', 'rb', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'vue', 'svelte', 'astro', 'graphql', 'sql', 'prisma', 'proto'];
    const isText = textExtensions.includes(ext) || file.type.startsWith('text/') || file.type === 'image/svg+xml';

    const reader = new FileReader();
    reader.onload = async (event) => {
      let content = event.target?.result as string;
      if (!content) return;
      // Binary uploads (images etc.): FileReader gives a data URL — strip the
      // "data:<mime>;base64," prefix and tell the backend to decode, so real bytes
      // land on disk instead of the data-URL text (which broke previews).
      const encoding = isText ? undefined : 'base64';
      if (!isText) {
        const comma = content.indexOf(',');
        content = comma >= 0 ? content.slice(comma + 1) : content;
      } else {
        // Normalize Windows line endings on text uploads. CRLF otherwise flows into the
        // LLM context, gets echoed back by the model, and a raw \r in an SSE data field
        // panics axum's encoder (the server runs Linux; LF is right on disk anyway).
        content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      }
      try {
        const res = await fetch(`/api/projects/${currentProject.id}/files/write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content, ...(encoding ? { encoding } : {}) }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.error('Upload failed:', data.error || res.statusText);
          return;
        }
        refreshFileTree();
      } catch (e) {
        console.error('Upload write error:', e);
      }
    };

    if (isText) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  }, [currentProject?.id, refreshFileTree]);

  // Move a file/directory to a new parent directory (drag-and-drop)
  const handleMoveFile = useCallback(async (sourcePath: string, targetDirPath: string) => {
    if (!currentProject?.id) return;
    const sourceName = sourcePath.split('/').pop() || sourcePath;
    const destPath = `${targetDirPath}/${sourceName}`;

    try {
      const res = await fetch(`/api/projects/${currentProject.id}/files/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: sourcePath, destination: destPath }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Move failed:', data.error || res.statusText);
        return;
      }
      // Update open tabs if the moved file had one
      setOpenTabs(prev => prev.map(t =>
        t.path === sourcePath ? { ...t, path: destPath } : t
      ));
      refreshFileTree();
    } catch (e) {
      console.error('Move error:', e);
    }
  }, [currentProject?.id, refreshFileTree]);

  // --- Multi-tab editor helpers ---
  const openFileInTab = useCallback(async (path: string) => {
    // Check if already open
    const existingIdx = openTabs.findIndex(t => t.path === path);
    if (existingIdx >= 0) {
      setActiveTabIndex(existingIdx);
      return;
    }
    // Images: no text content to fetch (binary on disk) — the tab renders an <img> viewer.
    if (isImagePath(path)) {
      setOpenTabs(prev => {
        const updated = [...prev, { path, content: '', isDirty: false }];
        setActiveTabIndex(updated.length - 1);
        return updated;
      });
      return;
    }
    // Fetch file content and add as new tab
    try {
      const res = await fetch(`/api/projects/${currentProject!.id}/files/read?path=${encodeURIComponent(path)}`);
      const data = res.ok ? await res.json() : null;
      const content = data?.content || `// ${path}`;
      const newTab: EditorTab = { path, content, isDirty: false };
      setOpenTabs(prev => {
        const updated = [...prev, newTab];
        setActiveTabIndex(updated.length - 1);
        return updated;
      });
    } catch {
      const newTab: EditorTab = { path, content: `// ${path}`, isDirty: false };
      setOpenTabs(prev => {
        const updated = [...prev, newTab];
        setActiveTabIndex(updated.length - 1);
        return updated;
      });
    }
  }, [currentProject, openTabs]);

  const closeTab = useCallback((index: number) => {
    setOpenTabs(prev => {
      const updated = prev.filter((_, i) => i !== index);
      if (activeTabIndex >= updated.length) {
        setActiveTabIndex(Math.max(0, updated.length - 1));
      } else if (index < activeTabIndex) {
        setActiveTabIndex(prev => prev - 1);
      }
      return updated;
    });
  }, [activeTabIndex]);

  const updateTabContent = useCallback((content: string) => {
    setOpenTabs(prev => prev.map((t, i) =>
      i === activeTabIndex ? { ...t, content, isDirty: true } : t
    ));
  }, [activeTabIndex]);

  const markTabSaved = useCallback(() => {
    setOpenTabs(prev => prev.map((t, i) =>
      i === activeTabIndex ? { ...t, isDirty: false } : t
    ));
  }, [activeTabIndex]);

  const updateTabContentByPath = useCallback((path: string, content: string) => {
    setOpenTabs(prev => prev.map(t =>
      t.path === path ? { ...t, content, isDirty: false } : t
    ));
  }, []);

  // Parse an assistant response for code blocks / shell commands and apply them to
  // the project on disk. Shared by the initial send and the manual "Continue" action
  // so both paths write files identically.
  const applyAssistantOutput = useCallback((fullContent: string) => {
    if (!currentProject?.id) return;

    type WriteResult = { path: string; ok: boolean; error?: string };
    // Collect everything to apply first — the fetches only fire AFTER the safety
    // checkpoint below, so a bad response can't destroy un-snapshotted work.
    const fileWrites: Array<{ path: string; content: string }> = [];
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

    if (fileWrites.length === 0 && shellCommands.length === 0) return;

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

      const writes: Promise<WriteResult | void>[] = fileWrites.map(({ path: filePath, content: cleanCode }) =>
        fetch(`/api/projects/${currentProject.id}/files/write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, content: cleanCode }),
        }).then(async r => {
          if (!r.ok) {
            const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
            const msg = typeof err === 'object' && err !== null && 'error' in err
              ? String(err.error) : `HTTP ${r.status}`;
            console.error(`Failed to write ${filePath}: ${msg}`);
            return { path: filePath, ok: false, error: msg };
          }
          console.log(`Wrote ${filePath} (${cleanCode.length} bytes)`);
          return { path: filePath, ok: true };
        }).catch(e => {
          console.error(`Write error for ${filePath}:`, e);
          return { path: filePath, ok: false, error: String(e) };
        })
      );

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

        // Keep the LLM's context fresh: fold successful writes into allFileContents so the
        // next turn's PROJECT FILE CONTENTS matches the disk. (This map previously went stale
        // after the first AI edit, making the model regenerate from outdated file state.)
        const okPaths = new Set(results.filter((r): r is WriteResult => !!r && r.ok).map(r => r.path));
        if (okPaths.size > 0) {
          setAllFileContents(prev => {
            const next = { ...prev };
            for (const w of fileWrites) if (okPaths.has(w.path)) next[w.path] = w.content;
            return next;
          });
        }
        // Shell commands can touch arbitrary files — re-read everything to be safe.
        if (shellCommands.length > 0) {
          fetch(`/api/projects/${currentProject.id}/files/read-all`)
            .then(r => r.json()).then(d => setAllFileContents(d.files || {})).catch(() => {});
        }

        // Feedback: add a system note showing which files were written
        const okFiles = results.filter((r): r is WriteResult => !!r && r.ok).map(r => r.path);
        const failFiles = results.filter((r): r is WriteResult => !!r && !r.ok);
        if (okFiles.length > 0 || failFiles.length > 0) {
          let note = '';
          if (okFiles.length > 0) {
            note += `✅ Wrote **${okFiles.length}** file${okFiles.length > 1 ? 's' : ''}: ${okFiles.map(f => `\`${f}\``).join(', ')}`;
            note += checkpointSnapshotId
              ? '\n\n🛟 The previous state was snapshotted first — you can abandon these changes below.'
              : '\n\n⚠️ Safety snapshot could not be created before these changes.';
          }
          if (failFiles.length > 0) {
            note += (note ? '\n\n' : '') + `❌ Failed **${failFiles.length}** file${failFiles.length > 1 ? 's' : ''}: ${failFiles.map(f => `\`${f.path}\` (${f.error})`).join(', ')}`;
          }
          if (note) {
            setMessages(prev => [...prev, {
              id: `write-feedback-${Date.now()}`,
              role: 'system' as const,
              content: note,
              timestamp: Date.now(),
              // Carrying the snapshot id makes ChatPane render its restore button inline,
              // so abandoning an AI edit is one click on the message itself.
              model: (okFiles.length > 0 && checkpointSnapshotId) || undefined,
              revertLabel: okFiles.length > 0 && checkpointSnapshotId ? 'Abandon these changes' : undefined,
            }]);
          }
        }
      });
    })();
  }, [currentProject?.id, currentFile, updateTabContentByPath]);

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
    contextParts.push(`FILE EDITING RULES:
- To edit or create a file, use code blocks with the format: \`\`\`language:path/to/file
- Example: \`\`\`tsx:src/App.tsx
- The file path after the colon determines where the code is written.
- To create a NEW file, just use a path that doesn't exist yet.
- You can write multiple files in a single response — each code block becomes a file.
- CRITICAL: a code block with a file path REPLACES that file's ENTIRE contents. ALWAYS output the COMPLETE file — never a fragment, snippet, or "rest unchanged" placeholder. Writing a partial file destroys the parts you left out.
- For illustrative snippets you do NOT want saved to disk, use a plain code block with no file path.`);

    // Skills (lazy-loaded expertise) — only the active ones are injected (see lib/skills.ts).
    // The Pocketbase "toggle" is now skill #1; new domains can be added declaratively.
    buildSkillInstructions(
      useDatabaseContext ? ['pocketbase'] : [],
      { pocketbaseUrl: pocketbaseConn?.base_url, userMessage: userMessageContent },
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
  }, [activeAgentIds, getAgent, currentProject, useDatabaseContext, pocketbaseConn?.base_url, workflow.activeTask, workflow.spec, projectFiles, allFileContents, currentFile, activeTab, workingSetPaths]);

  const handleSendMessage = useCallback(async (content: string, attachments?: any[], options?: { preferHermes?: boolean }) => {
    // Auto-create a session if none exists
    let sessionId = currentSession?.id;
    if (!sessionId && currentProject?.id) {
      const session = await createSession({ title: content.slice(0, 50) });
      if (session) {
        sessionId = session.id;
      } else {
        // Fallback: still show messages locally even if session creation fails
        sessionId = null;
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

    // Nudge toward the staged workflow: freeform one-shot edits on a large (scoped-context)
    // project are exactly where out-of-context mistakes happen. A task's Plan stage picks the
    // affected files up front, which pre-scopes the model's context for every later stage.
    // Shown once per session, only when no task is active; the button creates the task AND
    // kicks off the Architect's Plan stage in one click.
    const corpusSize = Object.values(allFileContents).reduce((n, c) => n + c.length, 0);
    if (!workflow.activeTask && corpusSize > SMALL_PROJECT_LIMIT && !workflowNudgeShownRef.current && currentProject?.id) {
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
            content: `${pulled} — send your next message (or "continue") and the results will be included.`,
            timestamp: Date.now(),
          }]);
          break;
        }

        readRounds++;
        setMessages(prev => [...prev, {
          id: `ctx-${Date.now()}`,
          role: 'system' as const,
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

  const handleStopGeneration = () => {
    abortRef.current?.abort();
    setIsGenerating(false);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-monastery-dark-bg overflow-hidden">
      <TopBar availableProjects={availableProjects} endpoints={endpoints} onRefreshProjects={refreshProjects}
        onOpenWizard={() => setIsWizardOpen(true)}
        onCommitComplete={(msg, snapshotId, wasRestore) => {
          const markerMsg: Message = {
            id: `commit-${Date.now()}`,
            role: 'system',
            content: wasRestore
              ? `⏪ ${msg} — restored from snapshot`
              : `✅ ${msg}`,
            timestamp: Date.now(),
            model: snapshotId || undefined,
          };
          setMessages(prev => [...prev, markerMsg]);
        }}
        onRestoreComplete={() => {
          // Full refresh after snapshot restore
          setOpenTabs([]);
          setActiveTabIndex(0);
          if (currentProject?.id) {
            fetch(`/api/projects/${currentProject.id}/files`)
              .then(r => r.json()).then(f => setProjectFiles(f)).catch(() => {});
            fetch(`/api/projects/${currentProject.id}/files/read-all`)
              .then(r => r.json()).then(d => setAllFileContents(d.files || {})).catch(() => {});
          }
        }}      />
      
      <SelfHostWizard isOpen={isWizardOpen} onClose={() => setIsWizardOpen(false)} onFixBuildError={handleFixBuildError} />

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar — slides in/out with CSS transition */}
        <div
          className={`transition-all duration-300 ease-in-out overflow-hidden ${
            sidebarCollapsed ? 'w-0 border-r-0' : 'w-64 border-r border-monastery-dark-border'
          }`}
        >
          <div className="w-64 h-full flex-shrink-0">
            <Sidebar
              files={projectFiles}
              onSelectFile={openFileInTab}
              onDeleteFile={handleDeleteFile}
              onCreateFile={handleCreateFile}
              onCreateDirectory={handleCreateDirectory}
              onDeleteDirectory={handleDeleteDirectory}
              onUploadFile={handleUploadFile}
              onMoveFile={handleMoveFile}
              onRefreshFiles={refreshFileTree}
              sessions={sessions}
              currentSessionId={currentSession?.id ?? null}
              isLoadingSessions={isLoadingSessions}
              onCreateSession={handleCreateSession}
              onSelectSession={handleSelectSession}
              onDeleteSession={handleDeleteSession}
            />
          </div>
        </div>

        {/* Main Content Area — Chat + Editor (+ Preview when open) */}
        <PanelGroup direction="horizontal" className="flex-1">
          {/* Chat Pane — always visible */}
          <Panel
            defaultSize={sidebarCollapsed ? (previewCollapsed ? 100 : paneLayout.chat) : paneLayout.chat}
            minSize={20}
            onResize={(size) => updatePaneLayout({ ...paneLayout, chat: size })}
          >
           <div className="h-full flex flex-col">
            <WorkflowPanel
              projectId={currentProject?.id}
              workflow={workflow}
              onRunStage={(s: Stage) => runStage(s, false)}
              onHandToHermes={(s: Stage) => runStage(s, true)}
              hermesAvailable={!!hermesConnection}
              onApplySkills={(ids) => { if (ids.includes('pocketbase')) setUseDatabaseContext(true); }}
              templateCtx={{ pocketbaseConfigured: !!pocketbaseConn }}
            />
            <div className="flex-1 min-h-0">
            <ChatPane
              messages={messages}
              onSendMessage={handleSendMessage}
              activeAgentIds={activeAgentIds}
              onToggleAgent={toggleActiveAgent}
              maxActiveRoles={MAX_ACTIVE_ROLES}
              hasActiveTask={!!workflow.activeTask}
              onStopGeneration={handleStopGeneration}
              onContinue={handleContinueGeneration}
              onCreateTask={async (title) => {
                try {
                  // Create + activate the task, then immediately run the Architect's Plan
                  // stage on it (passed explicitly — React state hasn't re-rendered yet).
                  const task = await workflow.createTask(title, currentSession?.id);
                  runStage('plan', false, task);
                } catch (e) {
                  console.error('Task creation from nudge failed:', e);
                }
              }}
              onReverted={() => {
                // Reload everything after an in-chat "Abandon these changes" restore so the
                // editor tabs and the LLM context map match the restored disk state.
                setOpenTabs([]);
                setActiveTabIndex(0);
                if (currentProject?.id) {
                  fetch(`/api/projects/${currentProject.id}/files`)
                    .then(r => r.json()).then(f => setProjectFiles(f)).catch(() => {});
                  fetch(`/api/projects/${currentProject.id}/files/read-all`)
                    .then(r => r.json()).then(d => setAllFileContents(d.files || {})).catch(() => {});
                }
              }}
              autoContinue={autoContinue}
              onToggleAutoContinue={setAutoContinue}
              isGenerating={isGenerating}
              hermesAvailable={!!hermesConnection}
              agentMode={agentMode}
              // Roles live under Agent mode in the UI; clear them when it's switched off so an
              // active role can't keep silently injecting once its chips are hidden.
              onToggleAgentMode={(on) => { setAgentMode(on); if (!on) setActiveAgentIds([]); }}
              pocketbaseAvailable={!!pocketbaseConn}
              useDatabaseContext={useDatabaseContext}
              onToggleDatabaseContext={setUseDatabaseContext}
            />
            </div>
           </div>
          </Panel>

          {/* Code Editor — only visible when sidebar is open */}
          {!sidebarCollapsed && (
            <>
              <PanelResizeHandle className="w-1 bg-monastery-dark-border hover:bg-monastery-lantern transition-colors cursor-col-resize" />
              <Panel 
                defaultSize={previewCollapsed ? 100 - paneLayout.chat : paneLayout.editor}
                minSize={20}
                onResize={(size) => updatePaneLayout({ ...paneLayout, editor: size })}
              >
                <div className="h-full bg-monastery-dark-surface flex flex-col animate-slideInRight">
                  {/* Tab Bar */}
                  {openTabs.length > 0 && (
                    <div className="flex items-center border-b border-monastery-dark-border bg-monastery-dark-bg overflow-x-auto shrink-0">
                      {openTabs.map((tab, i) => (
                        <div
                          key={tab.path}
                          onClick={() => setActiveTabIndex(i)}
                          className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-monastery-dark-border transition-colors shrink-0 ${
                            i === activeTabIndex
                              ? 'bg-monastery-dark-surface text-monastery-text-primary border-t-2 border-t-monastery-lantern'
                              : 'text-monastery-text-secondary hover:bg-monastery-dark-surface hover:text-monastery-text-primary'
                          }`}
                        >
                          <span className="max-w-[120px] truncate">{tab.path.split('/').pop()}</span>
                          {tab.isDirty && (
                            <span className="w-1.5 h-1.5 rounded-full bg-monastery-lantern" title="Unsaved changes" />
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); closeTab(i); }}
                            className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-monastery-dark-tertiary rounded transition-all"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  
                  {/* Editor Toolbar */}
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-monastery-dark-border shrink-0">
                    <span className="text-xs text-monastery-text-muted truncate">
                      {currentFile || 'No file selected'}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          if (!currentFile) return;
                          const prompt = editorPrompts.reviewer?.(currentFile, editorContent)
                            ?? `Explain this code in detail:\n\nFile: ${currentFile}\n\`\`\`\n${editorContent}\n\`\`\``;
                          triggerAgent('reviewer', prompt);
                        }}
                        disabled={!currentFile}
                        className="px-2 py-0.5 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors text-monastery-text-secondary disabled:opacity-40"
                      >
                        Explain
                      </button>
                      <button
                        onClick={() => {
                          if (!currentFile) return;
                          const prompt = editorPrompts.coder?.(currentFile, editorContent)
                            ?? `Refactor this code for better patterns, readability, and performance:\n\nFile: ${currentFile}\n\`\`\`\n${editorContent}\n\`\`\``;
                          triggerAgent('coder', prompt);
                        }}
                        disabled={!currentFile}
                        className="px-2 py-0.5 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors text-monastery-text-secondary disabled:opacity-40"
                      >
                        Refactor
                      </button>
                      <button
                        onClick={() => {
                          if (!currentFile) return;
                          const prompt = editorPrompts.tester?.(currentFile, editorContent)
                            ?? `Write comprehensive unit and integration tests for this code:\n\nFile: ${currentFile}\n\`\`\`\n${editorContent}\n\`\`\``;
                          triggerAgent('tester', prompt);
                        }}
                        disabled={!currentFile}
                        className="px-2 py-0.5 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors text-monastery-text-secondary disabled:opacity-40"
                      >
                        Add Tests
                      </button>
                      {currentFile && !isImagePath(currentFile) && (
                        <button
                          onClick={async () => {
                            if (!currentProject?.id || !currentFile) return;
                            try {
                              await fetch(`/api/projects/${currentProject.id}/files/write`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ path: currentFile, content: editorContent }),
                              });
                              markTabSaved();
                              // Keep the LLM context map in sync with the saved file.
                              setAllFileContents(prev => ({ ...prev, [currentFile]: editorContent }));
                            } catch (e) {
                              console.error('Save failed:', e);
                            }
                          }}
                          className="px-3 py-0.5 text-xs bg-monastery-pine hover:bg-monastery-forest text-white rounded transition-colors font-medium"
                        >
                          Save
                        </button>
                      )}
                    </div>
                  </div>
                  
                  {/* Editor — image files get a viewer (served via the preview route, which also
                      self-heals legacy data-URL uploads); everything else gets Monaco. */}
                  <div className="flex-1 overflow-hidden">
                    {currentFile && isImagePath(currentFile) && currentProject?.id ? (
                      <div className="h-full w-full flex items-center justify-center bg-monastery-dark-bg overflow-auto p-4">
                        <img
                          src={`/api/projects/${currentProject.id}/preview/${currentFile}`}
                          alt={currentFile}
                          className="max-w-full max-h-full object-contain rounded border border-monastery-dark-border bg-white/5"
                        />
                      </div>
                    ) : (
                      <CodeEditor
                        value={editorContent}
                        language={currentFile?.endsWith('.tsx') || currentFile?.endsWith('.ts') ? 'typescript' : 'javascript'}
                        onChange={updateTabContent}
                      />
                    )}
                  </div>
                </div>
              </Panel>
            </>
          )}

          {/* Preview/Terminal Pane — slides in/out */}
          {!previewCollapsed && (
            <>
              <PanelResizeHandle className="w-1 bg-monastery-dark-border hover:bg-monastery-lantern transition-colors cursor-col-resize" />
              <Panel 
                defaultSize={paneLayout.preview}
                minSize={15}
                onResize={(size) => updatePaneLayout({ ...paneLayout, preview: size })}
              >
                <div className="h-full animate-slideInRight">
                  <PreviewPane projectId={currentProject?.id} />
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    </div>
  );
}
