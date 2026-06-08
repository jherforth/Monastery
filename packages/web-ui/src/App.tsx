import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useState, useEffect, useCallback } from 'react';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { ChatPane } from './components/ChatPane';
import { CodeEditor } from './components/CodeEditor';
import { PreviewPane } from './components/PreviewPane';
import { useAppStore } from './store/useAppStore';
import { useSessions } from './hooks/useSessions';
import { Message } from './types';

export default function App() {
  const { sidebarCollapsed, previewCollapsed, paneLayout, updatePaneLayout, theme, currentProject, setCurrentProject } = useAppStore();
  const [currentFile, setCurrentFile] = useState('');
  const [editorContent, setEditorContent] = useState('// Select a file to edit');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [projectFiles, setProjectFiles] = useState<any[]>([]);
  const [availableProjects, setAvailableProjects] = useState<any[]>([]);

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
  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then((projects: any[]) => {
        setAvailableProjects(projects);
        if (projects.length > 0 && !currentProject) {
          // Auto-select the most recently updated project
          const recent = projects[0];
          setCurrentProject({
            id: recent.id,
            name: recent.name,
            path: '', // Will be populated by the backend file listing
            lastOpened: Date.now(),
            files: [],
          });
        }
      })
      .catch(() => {});
  }, []); // Run once on mount

  // Fetch project files when currentProject changes
  useEffect(() => {
    if (!currentProject?.id) {
      setProjectFiles([]);
      return;
    }
    fetch(`/api/projects/${currentProject.id}/files`)
      .then(r => r.json())
      .then(files => setProjectFiles(files))
      .catch(() => setProjectFiles([]));
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
      
      const res = await fetch(`/api/models/deepseek-chat/chat?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMessage].map(m => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (res.ok && res.headers.get('content-type')?.includes('text/event-stream')) {
        // Streaming response
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            // Parse SSE data lines
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                fullContent += data;
              }
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
          
          // Save AI response to backend
          if (sessionId) {
            addMessage({ role: 'assistant', content: fullContent }).catch(console.error);
          }
        }
      } else {
        throw new Error('Backend returned non-streaming response or error');
      }
    } catch {
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
      return; // Don't set isGenerating to false yet (handled in setTimeout)
    }
    
    setIsGenerating(false);
  }, [messages, currentSession, currentProject, createSession, addMessage]);

  const handleStopGeneration = () => {
    setIsGenerating(false);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-monastery-dark-bg overflow-hidden">
      <TopBar availableProjects={availableProjects} />
      
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
