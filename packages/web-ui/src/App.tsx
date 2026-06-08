import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useState, useEffect, useCallback } from 'react';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { ChatPane } from './components/ChatPane';
import { CodeEditor } from './components/CodeEditor';
import { PreviewPane } from './components/PreviewPane';
import { useAppStore } from './store/useAppStore';
import { useSessions } from './hooks/useSessions';
import { useEndpoints } from './hooks/useEndpoints';
import { Message } from './types';

export default function App() {
  const { sidebarCollapsed, previewCollapsed, paneLayout, updatePaneLayout, theme, currentProject, setCurrentProject } = useAppStore();
  const [currentFile, setCurrentFile] = useState('');
  const [editorContent, setEditorContent] = useState('// Select a file to edit');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [projectFiles, setProjectFiles] = useState<any[]>([]);
  const [availableProjects, setAvailableProjects] = useState<any[]>([]);
  const [allFileContents, setAllFileContents] = useState<Record<string, string>>({});

  // Endpoints for LLM selector in TopBar
  const { endpoints } = useEndpoints();

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

  // Sync persisted theme with the HTML data-theme attribute on load
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

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
    if (!currentProject?.id) {
      setProjectFiles([]);
      setAllFileContents({});
      return;
    }
    fetch(`/api/projects/${currentProject.id}/files`)
      .then(r => r.json())
      .then(files => setProjectFiles(files))
      .catch(() => setProjectFiles([]));
    // Also fetch all file contents for LLM context
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

  const handleSendMessage = useCallback(async (content: string, attachments?: any[]) => {
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

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments,
    };
    
    setMessages((prev) => [...prev, userMessage]);
    setIsGenerating(true);

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
      
      // Build system context from the current project
      const contextParts: string[] = [];
      if (currentProject) {
        contextParts.push(`You are an expert coding assistant. You have full access to the project "${currentProject.name}". You can freely read, create, and modify any file. Your changes are automatically applied.`);
      }
      contextParts.push(`FILE EDITING RULES:
- To edit or create a file, use code blocks with the format: \`\`\`language:path/to/file
- Example: \`\`\`tsx:src/App.tsx
- The file path after the colon determines where the code is written.
- To create a NEW file, just use a path that doesn't exist yet.
- You can write multiple files in a single response — each code block becomes a file.`);
      
      if (projectFiles.length > 0) {
        const fileList = projectFiles.map((f: any) => `  ${f.type === 'directory' ? '📁' : '📄'} ${f.path || f.name}`).join('\n');
        contextParts.push(`PROJECT FILE TREE:\n${fileList}`);
      }
      
      // Include ALL file contents so the LLM has full project visibility
      const fileEntries = Object.entries(allFileContents);
      if (fileEntries.length > 0) {
        const fileContents = fileEntries
          .filter(([, content]) => content.trim().length > 0)
          .map(([path, content]) => {
            const ext = path.split('.').pop() || '';
            return `### ${path}\n\`\`\`${ext}\n${content}\n\`\`\``;
          })
          .join('\n\n');
        // Cap total context at ~400KB (fits DeepSeek's 128K token window with room for conversation)
        const capped = fileContents.length > 400_000 
          ? fileContents.slice(0, 400_000) + '\n\n... [additional files truncated — open specific files to include them]'
          : fileContents;
        contextParts.push(`PROJECT FILE CONTENTS:\n${capped}`);
      }
      const systemMessage = contextParts.length > 0 ? {
        role: 'system' as const,
        content: contextParts.join('\n\n'),
      } : null;
      
      const chatMessages = [
        ...(systemMessage ? [systemMessage] : []),
        ...messages.map(m => ({ role: m.role, content: m.content })),
        { role: userMessage.role, content: userMessage.content },
      ];
      
      const modelId = 'deepseek-chat';
      const res = await fetch(`/api/models/${modelId}/chat?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatMessages }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error');
        console.error('Chat API returned', res.status, errText);
        throw new Error(`Backend returned ${res.status}`);
      }

      // Read the response as a stream using the SSE protocol
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');
      
      const decoder = new TextDecoder();
      let fullContent = '';
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Process complete SSE events (terminated by double newline)
        const events = buffer.split('\n\n');
        // The last element may be incomplete — keep it in the buffer
        buffer = events.pop() || '';
        
        for (const event of events) {
          const lines = event.split('\n');
          const dataLines: string[] = [];
          for (const line of lines) {
            // Handle "data: ..." lines (with or without space after colon)
            if (line.startsWith('data:')) {
              const content = line.slice(5).trimStart();
              if (content === '[DONE]') continue;
              dataLines.push(content);
            }
          }
          // Join multi-line data with \n per SSE spec
          if (dataLines.length > 0) {
            fullContent += dataLines.join('\n');
          }
        }
      }
      
      if (fullContent) {
        const aiMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: fullContent,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, aiMessage]);
        
        if (sessionId) {
          addMessage({ role: 'assistant', content: fullContent }).catch(console.error);
        }

        // Auto-apply code blocks to files
        if (currentProject?.id) {
          const codeBlockRegex = /```(\w+)?(?::(\S+))?\s*\n([\s\S]*?)```/g;
          let match;
          const writes: Promise<void>[] = [];
          while ((match = codeBlockRegex.exec(fullContent)) !== null) {
            const [, _lang, filePath, code] = match;
            const targetPath = filePath || currentFile;
            if (targetPath) {
              writes.push(
                fetch(`/api/projects/${currentProject.id}/files/write`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path: targetPath, content: code.trimEnd() + '\n' }),
                }).then(r => {
                  if (!r.ok) console.error(`Failed to write ${targetPath}`);
                  else console.log(`Auto-applied: ${targetPath}`);
                }).catch(e => console.error(`Write error for ${targetPath}:`, e))
              );
            }
          }
          // After all writes complete, refresh the editor if current file was updated
          if (writes.length > 0) {
            Promise.all(writes).then(() => {
              if (currentFile) {
                fetch(`/api/projects/${currentProject.id}/files/read?path=${encodeURIComponent(currentFile)}`)
                  .then(r => r.ok ? r.json() : null)
                  .then(data => { if (data?.content) setEditorContent(data.content); })
                  .catch(() => {});
              }
              // Refresh project files and git status
              fetch(`/api/projects/${currentProject.id}/files`)
                .then(r => r.json()).then(f => setProjectFiles(f)).catch(() => {});
            });
          }
        }
      }
      
      setIsGenerating(false);
    } catch (err) {
      console.error('Chat streaming failed, using fallback:', err);
      // Fallback: simulated response
      setTimeout(() => {
        const aiMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: 'This is a simulated response. Connect to the backend API for real AI interactions.',
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, aiMessage]);
        
        if (sessionId) {
          addMessage({ role: 'assistant', content: aiMessage.content }).catch(console.error);
        }
        setIsGenerating(false);
      }, 1500);
    }
  }, [messages, currentSession, currentProject, createSession, addMessage, projectFiles, currentFile, editorContent, allFileContents]);

  const handleStopGeneration = () => {
    setIsGenerating(false);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-monastery-dark-bg overflow-hidden">
      <TopBar availableProjects={availableProjects} endpoints={endpoints} onRefreshProjects={refreshProjects} />
      
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
              onSelectFile={async (path) => {
                setCurrentFile(path);
                try {
                  const res = await fetch(`/api/projects/${currentProject!.id}/files/read?path=${encodeURIComponent(path)}`);
                  if (res.ok) {
                    const data = await res.json();
                    setEditorContent(data.content || `// ${path}`);
                  } else {
                    setEditorContent(`// ${path}`);
                  }
                } catch {
                  setEditorContent(`// ${path}`);
                }
              }}
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
            <ChatPane
              messages={messages}
              onSendMessage={handleSendMessage}
              onStopGeneration={handleStopGeneration}
              isGenerating={isGenerating}
            />
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
                  <div className="flex items-center justify-between px-3 py-2 border-b border-monastery-dark-border">
                    <span className="text-xs font-medium text-monastery-text-secondary">
                      {currentFile || 'No file selected'}
                    </span>
                    <div className="flex items-center gap-2">
                      <button className="px-2 py-1 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors">
                        Explain
                      </button>
                      <button className="px-2 py-1 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors">
                        Refactor
                      </button>
                      <button className="px-2 py-1 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors">
                        Add Tests
                      </button>
                      {currentFile && (
                        <button
                          onClick={async () => {
                            if (!currentProject?.id || !currentFile) return;
                            try {
                              await fetch(`/api/projects/${currentProject.id}/files/write`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ path: currentFile, content: editorContent }),
                              });
                            } catch (e) {
                              console.error('Save failed:', e);
                            }
                          }}
                          className="px-3 py-1 text-xs bg-monastery-pine hover:bg-monastery-forest text-white rounded transition-colors font-medium"
                        >
                          Save
                        </button>
                      )}
                    </div>
                  </div>
                  <CodeEditor
                    value={editorContent}
                    language={currentFile?.endsWith('.tsx') || currentFile?.endsWith('.ts') ? 'typescript' : 'javascript'}
                    onChange={setEditorContent}
                  />
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
                  <PreviewPane />
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    </div>
  );
}
