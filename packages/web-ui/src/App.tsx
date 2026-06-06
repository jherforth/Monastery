import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useState } from 'react';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { ChatPane } from './components/ChatPane';
import { CodeEditor } from './components/CodeEditor';
import { PreviewPane } from './components/PreviewPane';
import { useAppStore } from './store/useAppStore';
import { Message } from './types';

export default function App() {
  const { sidebarCollapsed, previewCollapsed, paneLayout, updatePaneLayout } = useAppStore();
  const [currentFile, setCurrentFile] = useState('');
  const [editorContent, setEditorContent] = useState('// Select a file to edit');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleSendMessage = (content: string, attachments?: any[]) => {
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments,
    };
    
    setMessages((prev) => [...prev, userMessage]);
    setIsGenerating(true);
    
    // Simulate AI response (would connect to backend in real app)
    setTimeout(() => {
      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'This is a simulated response. Connect to the backend API for real AI interactions.',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, aiMessage]);
      setIsGenerating(false);
    }, 1500);
  };

  const handleStopGeneration = () => {
    setIsGenerating(false);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-monastery-dark-bg overflow-hidden">
      <TopBar />
      
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar — slides in/out with CSS transition */}
        <div
          className={`transition-all duration-300 ease-in-out overflow-hidden ${
            sidebarCollapsed ? 'w-0 border-r-0' : 'w-64 border-r border-monastery-dark-border'
          }`}
        >
          <div className="w-64 h-full flex-shrink-0">
            <Sidebar
              files={[
                {
                  name: 'src',
                  path: '/src',
                  type: 'directory',
                  children: [
                    { name: 'App.tsx', path: '/src/App.tsx', type: 'file', syncStatus: 'modified' as const },
                    { name: 'index.css', path: '/src/index.css', type: 'file', syncStatus: 'synced' as const },
                    { name: 'main.tsx', path: '/src/main.tsx', type: 'file', syncStatus: 'new' as const },
                  ],
                },
                { name: 'package.json', path: '/package.json', type: 'file', syncStatus: 'synced' as const },
                { name: 'README.md', path: '/README.md', type: 'file', syncStatus: 'synced' as const },
              ]}
              onSelectFile={(path) => {
                setCurrentFile(path);
                setEditorContent(`// Content of ${path}\nconsole.log("Hello from Monastery");`);
              }}
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
