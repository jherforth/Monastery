import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useState, useEffect, useCallback } from 'react';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { ChatPane } from './components/ChatPane';
import { EditorPane } from './components/EditorPane';
import { useEditorTabs, isImagePath } from './hooks/useEditorTabs';
import { PreviewPane } from './components/PreviewPane';
import { SelfHostWizard } from './components/SelfHostWizard';
import { useAppStore } from './store/useAppStore';
import { useSessions } from './hooks/useSessions';
import { useEndpoints } from './hooks/useEndpoints';
import { useAgents } from './hooks/useAgents';
import { useHermesAgent } from './hooks/useHermesAgent';
import { useHostingServices } from './hooks/useHostingServices';
import { useWorkflow, type Stage } from './hooks/useWorkflow';
import { WorkflowPanel } from './components/WorkflowPanel';
import {
  useChatOrchestrator,
  MAX_ACTIVE_ROLES,
  WORKFLOW_NUDGE_SUPPRESS_KEY,
} from './hooks/useChatOrchestrator';
import { Message } from './types';

export default function App() {
  const { sidebarCollapsed, previewCollapsed, editorCollapsed, paneLayout, updatePaneLayout, theme, currentProject, setCurrentProject } = useAppStore();

  // Multi-tab editor state (open files, active buffer)
  const {
    openTabs,
    setOpenTabs,
    activeTabIndex,
    setActiveTabIndex,
    activeTab,
    currentFile,
    editorContent,
    resetTabs,
    openFileInTab,
    closeTab,
    updateTabContent,
    markTabSaved,
    updateTabContentByPath,
  } = useEditorTabs(currentProject?.id);

  const [projectFiles, setProjectFiles] = useState<any[]>([]);
  const [availableProjects, setAvailableProjects] = useState<any[]>([]);
  const [allFileContents, setAllFileContents] = useState<Record<string, string>>({});
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<Array<{ id: string }>>([]);

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
    fetchSessions,
    createSession,
    getSession,
    deleteSession,
    addMessage,
  } = useSessions(currentProject?.id ?? null);

  // Agent system (execution is unified through the orchestrator's handleSendMessage)
  const { getAgent, editorPrompts } = useAgents();

  // Everything about talking to the model — streaming, auto-continue, @read/@search rounds,
  // applying code blocks to disk, edit recovery — lives in the orchestrator hook.
  const {
    messages,
    setMessages,
    isGenerating,
    autoContinue,
    setAutoContinue,
    agentMode,
    setAgentMode,
    useDatabaseContext,
    setUseDatabaseContext,
    activeAgentIds,
    toggleActiveAgent,
    handleSendMessage,
    handleContinueGeneration,
    handleStopGeneration,
    triggerAgent,
    handleFixBuildError,
    runStage,
  } = useChatOrchestrator({
    currentProject,
    currentSession,
    createSession,
    addMessage,
    availableModels,
    hermesConnection,
    pocketbaseBaseUrl: pocketbaseConn?.base_url,
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
  });

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
    resetTabs();

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

  // Create a new session
  const handleCreateSession = useCallback(async () => {
    const session = await createSession();
    if (session) {
      setMessages([]);
    }
  }, [createSession, setMessages]);

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
  }, [getSession, setMessages]);

  // Delete a session
  const handleDeleteSession = useCallback(async (sessionId: string) => {
    await deleteSession(sessionId);
    if (currentSession?.id === sessionId) {
      setMessages([]);
    }
  }, [deleteSession, currentSession, setMessages]);

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

  // Reload files + tabs + LLM context after events that rewrite the working tree
  // (snapshot restore, git pull, in-chat revert).
  const reloadProjectState = useCallback(() => {
    resetTabs();
    if (!currentProject?.id) return;
    fetch(`/api/projects/${currentProject.id}/files`)
      .then(r => r.json()).then(f => setProjectFiles(f)).catch(() => {});
    fetch(`/api/projects/${currentProject.id}/files/read-all`)
      .then(r => r.json()).then(d => setAllFileContents(d.files || {})).catch(() => {});
  }, [currentProject?.id, resetTabs]);

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
    _path: string,
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
  }, [deleteWithConfirm, setOpenTabs]);

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
  }, [deleteWithConfirm, setOpenTabs]);

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
  }, [currentProject?.id, refreshFileTree, setOpenTabs]);

  // Save the active editor buffer to disk and sync the LLM context map.
  const handleSaveFile = useCallback(async () => {
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
  }, [currentProject?.id, currentFile, editorContent, markTabSaved]);

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
          reloadProjectState();
        }}
        onPullComplete={(msg) => {
          // Reload files + LLM context so the pulled-in remote changes are adopted everywhere,
          // and drop a marker in chat. Open tabs are reset so no stale buffer overwrites merged work.
          reloadProjectState();
          setMessages(prev => [...prev, {
            id: `pull-${Date.now()}`,
            role: 'system' as const,
            content: `⬇️ ${msg}`,
            timestamp: Date.now(),
          }]);
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
            />
          </div>
        </div>

        {/* Main Content Area — Chat + Editor (+ Preview when open) */}
        <PanelGroup direction="horizontal" className="flex-1">
          {/* Chat Pane — always visible */}
          <Panel
            defaultSize={editorCollapsed && previewCollapsed ? 100 : paneLayout.chat}
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
              sessions={sessions}
              currentSessionId={currentSession?.id ?? null}
              onCreateSession={handleCreateSession}
              onSelectSession={handleSelectSession}
              onDeleteSession={handleDeleteSession}
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
              onSuppressWorkflowNudge={() => {
                // Persist the opt-out and strip the action buttons from any nudge already shown.
                localStorage.setItem(WORKFLOW_NUDGE_SUPPRESS_KEY, '1');
                setMessages(prev => prev.map(m => m.suggestTaskTitle
                  ? { ...m, suggestTaskTitle: undefined, content: `${m.content}\n\n_(You won't be reminded about this again.)_` }
                  : m));
              }}
              onReverted={() => {
                // Reload everything after an in-chat "Abandon these changes" restore so the
                // editor tabs and the LLM context map match the restored disk state.
                reloadProjectState();
              }}
              autoContinue={autoContinue}
              onToggleAutoContinue={setAutoContinue}
              isGenerating={isGenerating}
              hermesAvailable={!!hermesConnection}
              agentMode={agentMode}
              onToggleAgentMode={setAgentMode}
              pocketbaseAvailable={!!pocketbaseConn}
              useDatabaseContext={useDatabaseContext}
              onToggleDatabaseContext={setUseDatabaseContext}
            />
            </div>
           </div>
          </Panel>

          {/* Code Editor — has its own toggle, independent of the file-tree sidebar */}
          {!editorCollapsed && (
            <>
              <PanelResizeHandle className="w-1 bg-monastery-dark-border hover:bg-monastery-lantern transition-colors cursor-col-resize" />
              <Panel
                defaultSize={previewCollapsed ? 100 - paneLayout.chat : paneLayout.editor}
                minSize={20}
                onResize={(size) => updatePaneLayout({ ...paneLayout, editor: size })}
              >
                <EditorPane
                  projectId={currentProject?.id}
                  tabs={openTabs}
                  activeTabIndex={activeTabIndex}
                  currentFile={currentFile}
                  editorContent={editorContent}
                  onSelectTab={setActiveTabIndex}
                  onCloseTab={closeTab}
                  onChange={updateTabContent}
                  onSave={handleSaveFile}
                  onExplain={() => {
                    if (!currentFile) return;
                    const prompt = editorPrompts.reviewer?.(currentFile, editorContent)
                      ?? `Explain this code in detail:\n\nFile: ${currentFile}\n\`\`\`\n${editorContent}\n\`\`\``;
                    triggerAgent('reviewer', prompt);
                  }}
                  onRefactor={() => {
                    if (!currentFile) return;
                    const prompt = editorPrompts.coder?.(currentFile, editorContent)
                      ?? `Refactor this code for better patterns, readability, and performance:\n\nFile: ${currentFile}\n\`\`\`\n${editorContent}\n\`\`\``;
                    triggerAgent('coder', prompt);
                  }}
                  onAddTests={() => {
                    if (!currentFile) return;
                    const prompt = editorPrompts.tester?.(currentFile, editorContent)
                      ?? `Write comprehensive unit and integration tests for this code:\n\nFile: ${currentFile}\n\`\`\`\n${editorContent}\n\`\`\``;
                    triggerAgent('tester', prompt);
                  }}
                />
              </Panel>
            </>
          )}

          {/* Preview Pane — slides in/out */}
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
