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
import { Message } from './types';

export default function App() {
  const { sidebarCollapsed, previewCollapsed, paneLayout, updatePaneLayout, theme, currentProject, setCurrentProject } = useAppStore();
  
  // Multi-tab editor state
  interface EditorTab { path: string; content: string; isDirty: boolean; }
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
  const abortRef = useRef<AbortController | null>(null);

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

  // Agent system
  const { runAgent, getAgent } = useAgents();

  // Shared agent trigger — used by both ChatPane quick-actions and editor toolbar
  const triggerAgent = useCallback(async (agentId: string, task: string) => {
    if (!currentProject?.id) return;

    const agent = getAgent(agentId);

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user' as const,
      content: `${agent?.icon || '🤖'} **${agent?.name || agentId}**: ${task}`,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMsg]);
    setIsGenerating(true);

    // Create abort controller for this agent run
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const agentMsgId = (Date.now() + 1).toString();
    setMessages(prev => [...prev, {
      id: agentMsgId,
      role: 'assistant' as const,
      content: '',
      timestamp: Date.now(),
    }]);

    try {
      let finalContent = '';
      await runAgent(agentId, task, currentProject.id, (content) => {
        finalContent = content;
        setMessages(prev => prev.map(m =>
          m.id === agentMsgId ? { ...m, content } : m
        ));
      }, controller.signal);

      if (currentSession?.id) {
        addMessage({ role: 'assistant', content: finalContent }).catch(() => {});
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setMessages(prev => prev.map(m =>
        m.id === agentMsgId
          ? { ...m, content: `⚠️ Agent error: ${e.message}` }
          : m
      ));
    } finally {
      setIsGenerating(false);
    }
  }, [currentProject?.id, getAgent, runAgent, currentSession?.id, addMessage]);

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

  // Delete a file (user-initiated, no LLM)
  const handleDeleteFile = useCallback(async (path: string) => {
    if (!currentProject?.id) return;
    const name = path.split('/').pop() || path;
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/projects/${currentProject.id}/files?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Delete failed:', data.error || res.statusText);
        return;
      }
      // Close the tab if it was open
      setOpenTabs(prev => prev.filter(t => t.path !== path));
      refreshFileTree();
    } catch (e) {
      console.error('Delete file error:', e);
    }
  }, [currentProject?.id, refreshFileTree]);

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
    if (!currentProject?.id) return;
    const name = path.split('/').pop() || path;
    if (!window.confirm(`Delete directory "${name}" and ALL its contents? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/projects/${currentProject.id}/files/dir?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Delete directory failed:', data.error || res.statusText);
        return;
      }
      // Close any tabs for files inside this directory
      setOpenTabs(prev => prev.filter(t => !t.path.startsWith(path + '/')));
      refreshFileTree();
    } catch (e) {
      console.error('Delete directory error:', e);
    }
  }, [currentProject?.id, refreshFileTree]);

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
    try {
      // Read file as base64 data URL, then save via write endpoint
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target?.result as string;
        if (!content) return;
        try {
          const res = await fetch(`/api/projects/${currentProject.id}/files/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, content }),
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
      reader.readAsDataURL(file);
    } catch (e) {
      console.error('Upload read error:', e);
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
        signal: controller.signal,
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
      let reasoningContent = '';
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
          let eventType = '';
          const dataLines: string[] = [];
          for (const line of lines) {
            // Handle "event: ..." lines — determine SSE event type
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            }
            // Handle "data: ..." lines — per SSE spec, strip at most one space after colon
            if (line.startsWith('data: ')) {
              const chunkContent = line.slice(6);
              if (chunkContent === '[DONE]') continue;
              dataLines.push(chunkContent);
            } else if (line.startsWith('data:')) {
              const chunkContent = line.slice(5);
              if (chunkContent === '[DONE]') continue;
              dataLines.push(chunkContent.startsWith(' ') ? chunkContent.slice(1) : chunkContent);
            }
          }
          // Join multi-line data with \n per SSE spec
          if (dataLines.length > 0) {
            const chunkText = dataLines.join('\n');
            if (eventType === 'reasoning') {
              reasoningContent += chunkText;
            } else {
              fullContent += chunkText;
            }
          }
        }
      }
      
      if (fullContent || reasoningContent) {
        const aiMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: fullContent,
          reasoning: reasoningContent || undefined,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, aiMessage]);
        
        if (sessionId) {
          addMessage({ role: 'assistant', content: fullContent }).catch(console.error);
        }

      // Auto-apply code blocks and shell commands to files
      if (currentProject?.id) {
          const writes: Promise<void>[] = [];
          const modifiedFiles: string[] = [];
          
          // --- Enhanced code block parser (patterns from bolt.diy) ---
          
          // Pattern 1: language:path/to/file (original)
          const pattern1 = /```(\w+)?:(\S+)\s*\n([\s\S]*?)```/g;
          
          // Pattern 2: file path on line before code block
          const pattern2 = /(?:^|\n)\s*([\/\w\-\.]+\.\w+):?\s*\n+```(\w*)\n([\s\S]*?)```/gm;
          
          // Pattern 3: create/update/modify/write file language
          const pattern3 = /(?:create|update|modify|edit|write|add|generate)\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?(?:called\s+)?[`'"]*([\/\w\-\.]+\.\w+)[`'"]*:?\s*\n+```(\w*)\n([\s\S]*?)```/gi;
          
          // Pattern 4: file comment inside code block
          const pattern4 = /```(\w*)\n(?:\/\/|#|<!--)\s*(?:file:?|filename:?)\s*([\/\w\-\.]+\.\w+).*?\n([\s\S]*?)```/gi;
          
          const allPatterns = [pattern1, pattern2, pattern3, pattern4];
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
              } else {
                filePath = match[1];
                code = match[3];
              }
              
              if (!filePath || seenPaths.has(filePath)) continue;
              seenPaths.add(filePath);
              
              const cleanCode = code.trimEnd() + '\n';
              modifiedFiles.push(filePath);
              
              writes.push(
                fetch(`/api/projects/${currentProject.id}/files/write`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path: filePath, content: cleanCode }),
                }).then(r => {
                  if (!r.ok) console.error(`Failed to write ${filePath}`);
                }).catch(e => console.error(`Write error for ${filePath}:`, e))
              );
            }
          }
          
          // --- Shell command detection ---
          const shellRegex = /```(?:shell|bash|sh|zsh)\s*\n([\s\S]*?)```/gi;
          let shellMatch;
          const shellCommands: string[] = [];
          while ((shellMatch = shellRegex.exec(fullContent)) !== null) {
            const cmd = shellMatch[1].trim();
            if (cmd) shellCommands.push(cmd);
          }
          
          if (shellCommands.length > 0 && currentProject.id) {
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
          }
          
          if (writes.length > 0) {
            Promise.all(writes).then(() => {
              if (currentFile) {
                fetch(`/api/projects/${currentProject.id}/files/read?path=${encodeURIComponent(currentFile)}`)
                  .then(r => r.ok ? r.json() : null)
                  .then(data => { if (data?.content) updateTabContentByPath(currentFile, data.content); })
                  .catch(() => {});
              }
              fetch(`/api/projects/${currentProject.id}/files`)
                .then(r => r.json()).then(f => setProjectFiles(f)).catch(() => {});
            });
          }
        }
      }
      
      setIsGenerating(false);
    } catch (err: any) {
      // Don't show fallback if user intentionally stopped generation
      if (err?.name === 'AbortError') {
        setIsGenerating(false);
        return;
      }
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
      
      <SelfHostWizard isOpen={isWizardOpen} onClose={() => setIsWizardOpen(false)} />

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
              onRunAgent={triggerAgent}
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
                          triggerAgent('reviewer', `Explain this code in detail:\n\nFile: ${currentFile}\n\`\`\`\n${editorContent}\n\`\`\``);
                        }}
                        disabled={!currentFile}
                        className="px-2 py-0.5 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors text-monastery-text-secondary disabled:opacity-40"
                      >
                        Explain
                      </button>
                      <button
                        onClick={() => {
                          if (!currentFile) return;
                          triggerAgent('coder', `Refactor this code for better patterns, readability, and performance:\n\nFile: ${currentFile}\n\`\`\`\n${editorContent}\n\`\`\``);
                        }}
                        disabled={!currentFile}
                        className="px-2 py-0.5 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors text-monastery-text-secondary disabled:opacity-40"
                      >
                        Refactor
                      </button>
                      <button
                        onClick={() => {
                          if (!currentFile) return;
                          triggerAgent('tester', `Write comprehensive unit and integration tests for this code:\n\nFile: ${currentFile}\n\`\`\`\n${editorContent}\n\`\`\``);
                        }}
                        disabled={!currentFile}
                        className="px-2 py-0.5 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors text-monastery-text-secondary disabled:opacity-40"
                      >
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
                              markTabSaved();
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
                  
                  {/* Editor */}
                  <div className="flex-1 overflow-hidden">
                    <CodeEditor
                      value={editorContent}
                      language={currentFile?.endsWith('.tsx') || currentFile?.endsWith('.ts') ? 'typescript' : 'javascript'}
                      onChange={updateTabContent}
                    />
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
