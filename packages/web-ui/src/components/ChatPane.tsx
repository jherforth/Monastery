import { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, X, StopCircle, Copy, Check, RotateCcw, Brain, ChevronDown, ChevronRight, Bot, ChevronUp } from 'lucide-react';
import { Message, Attachment } from '../types';
import { useAppStore } from '../store/useAppStore';
import { useSnapshots } from '../hooks/useSnapshots';
import { useAgents } from '../hooks/useAgents';
import { ThuribleSpinner } from './ThuribleSpinner';

// Reasoning window — collapsible, scrollable, max ~12 rows
function ReasoningWindow({ reasoning }: { reasoning: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  return (
    <div className="mt-2 rounded-lg overflow-hidden border border-monastery-dark-border bg-monastery-dark-bg/50">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-monastery-text-secondary hover:text-monastery-text-primary hover:bg-monastery-dark-tertiary/50 transition-colors"
      >
        <Brain size={14} className="text-monastery-lantern flex-shrink-0" />
        <span className="font-medium">Reasoning</span>
        <span className="text-monastery-text-muted">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {isExpanded && (
        <div className="px-3 pb-2">
          <pre className="text-xs text-monastery-text-secondary whitespace-pre-wrap font-mono leading-relaxed overflow-y-auto" style={{ maxHeight: '18em' }}>
            {reasoning}
          </pre>
        </div>
      )}
    </div>
  );
}

interface ChatPaneProps {
  messages: Message[];
  onSendMessage: (content: string, attachments?: Attachment[]) => void;
  onRunAgent?: (agentId: string, task: string) => void;
  onStopGeneration?: () => void;
  isGenerating?: boolean;
}

export function ChatPane({ 
  messages, 
  onSendMessage,
  onRunAgent,
  onStopGeneration,
  isGenerating = false,
}: ChatPaneProps) {
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showQuickActions, setShowQuickActions] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { activeEndpoint, theme } = useAppStore();
  const { restoreSnapshot } = useSnapshots();
  const { quickActions } = useAgents();
  const [revertingId, setRevertingId] = useState<string | null>(null);

  const handleRevert = async (snapshotId: string) => {
    setRevertingId(snapshotId);
    try {
      await restoreSnapshot(snapshotId, { create_backup: true });
      useAppStore.getState().setLastRestoredSnapshotId(snapshotId);
    } catch (e) {
      console.error('Revert failed:', e);
    } finally {
      setRevertingId(null);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() && attachments.length === 0) return;
    
    onSendMessage(inputValue.trim(), attachments.length > 0 ? attachments : undefined);
    setInputValue('');
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const attachment: Attachment = {
          type: file.type.startsWith('image/') ? 'image' : 'file',
          name: file.name,
          content: event.target?.result as string,
        };
        setAttachments((prev) => [...prev, attachment]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    });
  };

  // Render markdown-style formatting inline
  const renderInline = (text: string) => {
    // Bold **text**
    const withBold = text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i} className="text-monastery-text-primary">{part.slice(2, -2)}</strong>;
      }
      return part;
    });
    // Inline code `text`
    return withBold.flatMap((part, i) => {
      if (typeof part === 'string') {
        return part.split(/(`[^`]+`)/g).map((sub, j) => {
          if (sub.startsWith('`') && sub.endsWith('`')) {
            return <code key={`${i}-${j}`} className="px-1 py-0.5 bg-monastery-dark-tertiary rounded text-xs font-mono">{sub.slice(1, -1)}</code>;
          }
          return sub;
        });
      }
      return [part];
    });
  };

  // Render message content with markdown and code blocks
  const renderContent = (content: string) => {
    const parts = content.split(/(```[\s\S]*?```)/g);
    let codeBlockIndex = -1;
    
    return parts.map((part, i) => {
      if (part.startsWith('```') && part.endsWith('```')) {
        codeBlockIndex++;
        const ci = codeBlockIndex;
        const lines = part.split('\n');
        const lang = lines[0].replace('```', '').trim();
        const code = lines.slice(1, -1).join('\n');
        
        return (
          <div key={i} className="mt-2 mb-2 rounded-lg overflow-hidden border border-monastery-dark-border">
            <div className="flex items-center justify-between px-3 py-1.5 bg-monastery-dark-tertiary">
              <span className="text-xs text-monastery-text-muted">{lang || 'code'}</span>
              <button
                onClick={() => copyToClipboard(code, ci)}
                className="flex items-center gap-1 px-2 py-0.5 text-xs text-monastery-text-secondary hover:text-monastery-text-primary hover:bg-monastery-dark-bg rounded transition-colors"
              >
                {copiedIndex === ci ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                {copiedIndex === ci ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="p-3 bg-monastery-dark-bg overflow-x-auto overflow-y-auto max-h-64">
              <code className="text-xs font-mono text-monastery-text-primary">{code}</code>
            </pre>
          </div>
        );
      }
      // Render markdown-like paragraphs
      return (
        <div key={i} className="whitespace-pre-wrap text-sm leading-relaxed">
          {renderInline(part)}
        </div>
      );
    });
  };

  return (
    <div className="flex flex-col h-full bg-monastery-dark-bg relative overflow-hidden">
      {/* Monastery SVG background */}
      <img
        src={theme === 'monastery-dark' ? '/images/monasteryDark.svg' : '/images/monasteryLight.svg'}
        alt=""
        className="absolute inset-0 w-full h-full object-cover opacity-[0.07] pointer-events-none select-none"
      />
      
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 relative z-10">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-lg px-6">
              {/* Monastery Logo */}
              <img
                src={theme === 'monastery-dark' ? '/images/logoDark.svg' : '/images/logoLight.svg'}
                alt="Monastery"
                className="w-16 h-16 mx-auto mb-6"
              />

              <h1 className="text-2xl font-semibold text-monastery-text-primary mb-2">
                Welcome to Monastery
              </h1>
              <p className="text-sm text-monastery-text-secondary mb-2">
                AI's self-hosted sanctuary for coding.
              </p>
              <p className="text-xs text-monastery-text-muted mb-8 max-w-sm mx-auto leading-relaxed">
                Connect an LLM to begin — ask it to create, edit, debug, or deploy applications.
              </p>

              {/* Quick Start Suggestions */}
              <div className="grid grid-cols-2 gap-2 text-left max-w-sm mx-auto">
                <button 
                  onClick={() => onSendMessage('Create a Next.js app with authentication')}
                  className="p-3 bg-monastery-dark-surface rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine text-left"
                >
                  <div className="font-medium text-monastery-text-primary mb-0.5">Web App</div>
                  Create a Next.js app with authentication
                </button>
                <button 
                  onClick={() => onSendMessage('Explain how this project structure works')}
                  className="p-3 bg-monastery-dark-surface rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine text-left"
                >
                  <div className="font-medium text-monastery-text-primary mb-0.5">Understand</div>
                  Explain this codebase structure
                </button>
                <button 
                  onClick={() => onSendMessage('Add unit tests to the existing module')}
                  className="p-3 bg-monastery-dark-surface rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine text-left"
                >
                  <div className="font-medium text-monastery-text-primary mb-0.5">Testing</div>
                  Add tests to the existing module
                </button>
                <button 
                  onClick={() => onSendMessage('Deploy this project to my homelab server')}
                  className="p-3 bg-monastery-dark-surface rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine text-left"
                >
                  <div className="font-medium text-monastery-text-primary mb-0.5">Deploy</div>
                  Deploy this to my homelab
                </button>
              </div>

              {/* First Steps Hint */}
              {!activeEndpoint && (
                <div className="mt-8 p-3 bg-amber-400/10 border border-amber-400/20 rounded-xl max-w-sm mx-auto">
                  <p className="text-xs text-amber-300 font-medium mb-1">First step</p>
                  <p className="text-xs text-amber-200/80">
                    Click <strong>No LLM connected</strong> in the top bar or open{' '}
                    <strong>Settings → LLM Endpoints</strong> to connect your AI backend.
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                  message.role === 'user'
                    ? 'bg-monastery-pine text-white'
                    : message.role === 'system'
                    ? 'bg-monastery-dark-tertiary border border-monastery-dark-border text-center'
                    : 'bg-monastery-dark-surface border border-monastery-dark-border'
                }`}
              >
                {message.attachments && message.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {message.attachments.map((attachment, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-monastery-dark-tertiary rounded text-xs"
                      >
                        <Paperclip size={12} />
                        {attachment.name}
                      </span>
                    ))}
                  </div>
                )}
                {/* Reasoning window for assistant messages */}
                {message.role === 'assistant' && message.reasoning && (
                  <ReasoningWindow reasoning={message.reasoning} />
                )}
                <div className={`text-sm ${message.role === 'system' ? 'text-monastery-text-secondary' : ''}`}>
                  {renderContent(message.content)}
                </div>
                {/* Revert button on commit markers */}
                {message.role === 'system' && message.model && (
                  <button
                    onClick={() => handleRevert(message.model!)}
                    disabled={revertingId === message.model}
                    className="mt-2 flex items-center gap-1.5 px-3 py-1 text-xs bg-monastery-dark-surface hover:bg-monastery-lantern hover:text-monastery-dark-bg rounded-lg transition-colors disabled:opacity-50 mx-auto"
                  >
                    <RotateCcw size={12} />
                    {revertingId === message.model ? 'Reverting...' : 'Revert to this snapshot'}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
        
        {isGenerating && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-monastery-dark-surface border border-monastery-dark-border">
              <div className="flex items-center gap-2">
                <ThuribleSpinner size={28} />
                <span className="text-monastery-text-muted text-sm">Contemplating...</span>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* Agent Quick Actions */}
      {onRunAgent && quickActions.length > 0 && (
        <div className="px-4 pb-1">
          <button
            onClick={() => setShowQuickActions(!showQuickActions)}
            className="flex items-center gap-1 text-xs text-monastery-text-muted hover:text-monastery-text-secondary transition-colors mb-1"
          >
            <Bot size={12} />
            Agents
            {showQuickActions ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
          {showQuickActions && (
            <div className="flex flex-wrap gap-1.5">
              {quickActions.map(action => (
                <button
                  key={action.agentId}
                  onClick={() => onRunAgent(action.agentId, action.prompt)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs bg-monastery-dark-surface border border-monastery-dark-border rounded-lg text-monastery-text-secondary hover:text-monastery-text-primary hover:border-monastery-pine transition-colors disabled:opacity-50"
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-monastery-dark-border p-4">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {attachments.map((attachment, index) => (
              <div
                key={index}
                className="inline-flex items-center gap-2 px-3 py-1.5 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg text-sm"
              >
                <Paperclip size={14} className="text-monastery-text-muted" />
                <span>{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(index)}
                  className="hover:text-monastery-lantern transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        
        <div className="flex items-end gap-2">
          <label className="p-2 hover:bg-monastery-dark-surface rounded-lg transition-colors cursor-pointer">
            <Paperclip size={20} className="text-monastery-text-secondary" />
            <input
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
          </label>
          
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              activeEndpoint
                ? "Ask anything... (Shift+Enter for new line)"
                : "Connect an LLM endpoint to start chatting"
            }
            disabled={!activeEndpoint && messages.length === 0}
            rows={Math.min(Math.max(inputValue.split('\n').length, 1), 6)}
            className="flex-1 bg-monastery-dark-surface border border-monastery-dark-border rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:border-monastery-pine transition-colors"
          />
          
          {isGenerating ? (
            <button
              type="button"
              onClick={onStopGeneration}
              className="p-3 bg-status-error hover:bg-red-600 text-white rounded-xl transition-colors"
              title="Stop generation"
            >
              <StopCircle size={20} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!inputValue.trim() && attachments.length === 0}
              className="p-3 bg-monastery-pine hover:bg-monastery-forest disabled:bg-monastery-dark-tertiary disabled:text-monastery-text-muted text-white rounded-xl transition-colors"
              title="Send message"
            >
              <Send size={20} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
