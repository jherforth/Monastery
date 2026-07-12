import { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, X, StopCircle, Copy, Check, RotateCcw, Brain, ChevronDown, ChevronRight, Bot, Database, Loader2, Coins } from 'lucide-react';
import { Message, Attachment } from '../types';
import { useAppStore } from '../store/useAppStore';
import { useSnapshots } from '../hooks/useSnapshots';
import { useAgents } from '../hooks/useAgents';
import { WORKFLOW_ROLE_IDS } from '../hooks/useWorkflow';
import { Spinner } from './Spinner';

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
  /** Currently active agent role ids (a persistent "lens" over chat messages). */
  activeAgentIds?: string[];
  /** Toggle an agent role on/off (caller enforces the max). */
  onToggleAgent?: (agentId: string) => void;
  /** Max number of roles that can be active at once (for disabling extras). */
  maxActiveRoles?: number;
  /** When a workflow task is active, the stage roles (plan/implement/verify/review) are driven by
   *  the Workflow panel, so the chat hides those chips and shows only the extras (docs, deploy). */
  hasActiveTask?: boolean;
  onStopGeneration?: () => void;
  onContinue?: (messageId: string) => void;
  /** Called after an in-chat snapshot restore succeeds so the app can reload files/tabs. */
  onReverted?: () => void;
  /** Creates a workflow task with the given title and kicks off its Plan stage — used by
   *  the large-project workflow nudge (messages carrying suggestTaskTitle). */
  onCreateTask?: (title: string) => void;
  /** Whether truncated responses auto-continue (capped) instead of requiring a manual click. */
  autoContinue?: boolean;
  onToggleAutoContinue?: (on: boolean) => void;
  isGenerating?: boolean;
  /** Whether a default Hermes connection exists (enables the Agent mode toggle). */
  hermesAvailable?: boolean;
  /** Whether Agent mode (route to Hermes) is currently on. */
  agentMode?: boolean;
  onToggleAgentMode?: (on: boolean) => void;
  /** Whether a Pocketbase connection is configured (enables the Pocketbase backend toggle). */
  pocketbaseAvailable?: boolean;
  /** Whether to include Pocketbase + deployment instructions in the LLM context. */
  useDatabaseContext?: boolean;
  onToggleDatabaseContext?: (on: boolean) => void;
}

export function ChatPane({
  messages,
  onSendMessage,
  activeAgentIds = [],
  onToggleAgent,
  maxActiveRoles = 2,
  hasActiveTask = false,
  onStopGeneration,
  onContinue,
  onReverted,
  onCreateTask,
  autoContinue = true,
  onToggleAutoContinue,
  isGenerating = false,
  hermesAvailable = false,
  agentMode = false,
  onToggleAgentMode,
  pocketbaseAvailable = false,
  useDatabaseContext = false,
  onToggleDatabaseContext,
}: ChatPaneProps) {
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Shared compact-pill styling for the inline toolbar (toggles + agent role chips).
  const pill = (active: boolean) =>
    `flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md border transition-colors ${
      active
        ? 'bg-monastery-lantern text-monastery-dark-bg border-monastery-lantern font-medium'
        : 'bg-monastery-dark-surface text-monastery-text-secondary border-monastery-dark-border hover:border-monastery-pine'
    }`;
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
      onReverted?.();
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

  // Auto-grow the input with its content (handles wrapped long lines, not just newlines),
  // up to a generous max; beyond that it scrolls. Users can also drag the handle (resize-y).
  const MAX_INPUT_HEIGHT = 260;
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [inputValue]);

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
    // Split on complete code blocks (opening + closing fence).
    // Also match unclosed blocks (streaming in progress or truncated).
    const parts = content.split(/(```[\s\S]*?```|```[^\n]*\n[\s\S]*$)/g);
    let codeBlockIndex = -1;
    
    return parts.map((part, i) => {
      if (!part?.startsWith('```')) {
        // Plain text / markdown
        return (
          <div key={i} className="whitespace-pre-wrap text-sm leading-relaxed">
            {renderInline(part || '')}
          </div>
        );
      }
      
      codeBlockIndex++;
      const ci = codeBlockIndex;
      const lines = part.split('\n');
      const lang = lines[0].replace('```', '').trim();
      // If the block is unclosed, the last line won't be ```
      const isUnclosed = !lines[lines.length - 1].trim().startsWith('```');
      const codeLines = isUnclosed ? lines.slice(1) : lines.slice(1, -1);
      const code = codeLines.join('\n');

      // Color-code diff blocks
      const isDiff = lang === 'diff';
      const diffLines = isDiff ? code.split('\n') : null;
      
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
          <pre className="p-3 bg-monastery-dark-bg overflow-x-auto overflow-y-auto max-h-80">
            {isDiff ? (
              <code className="text-xs font-mono block">
                {diffLines!.map((line, li) => (
                  <span
                    key={li}
                    className={
                      line.startsWith('+') && !line.startsWith('+++') ? 'text-green-400 block' :
                      line.startsWith('-') && !line.startsWith('---') ? 'text-red-400 block' :
                      line.startsWith('@@') ? 'text-monastery-lantern block' :
                      'text-monastery-text-secondary block'
                    }
                  >
                    {line}
                  </span>
                ))}
              </code>
            ) : (
              <code className="text-xs font-mono text-monastery-text-primary">
                {code}
                {isUnclosed && <span className="text-monastery-text-muted animate-pulse">▊</span>}
              </code>
            )}
          </pre>
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
          messages.map((message) => {
            // Compact timestamp: time-of-day for today's messages, date + time for older ones.
            // Hidden when the timestamp is missing/unparseable (e.g. a malformed session row).
            const ts = new Date(message.timestamp);
            const hasTime = Number.isFinite(ts.getTime());
            const isToday = hasTime && ts.toDateString() === new Date().toDateString();
            const timeLabel = !hasTime
              ? null
              : isToday
              ? ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
              : ts.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
            return (
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
                {/* Agent role chips on a user message (which role(s) it was sent under) */}
                {message.role === 'user' && message.agentLabels && message.agentLabels.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {message.agentLabels.map((label, i) => (
                      <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-white/15 font-medium">
                        {label}
                      </span>
                    ))}
                  </div>
                )}
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
                {/* Badge showing which backend answered (Hermes agent vs local LLM) */}
                {message.role === 'assistant' && message.via === 'hermes' && (
                  <span className="inline-flex items-center gap-1 mb-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-monastery-lantern/15 text-monastery-lantern">
                    <Bot size={10} /> via Hermes
                  </span>
                )}
                {/* Reasoning window for assistant messages */}
                {message.role === 'assistant' && message.reasoning && (
                  <ReasoningWindow reasoning={message.reasoning} />
                )}
                <div className={`text-sm ${message.role === 'system' ? 'text-monastery-text-secondary' : ''}`}>
                  {renderContent(message.content)}
                </div>
                {/* Auto-continuation status + token usage (when the endpoint reports usage). */}
                {message.role === 'assistant' && (message.continuing || (message.autoContinueCount ?? 0) > 0 || message.usage?.total_tokens) && (
                  <div className="mt-1.5 flex items-center flex-wrap gap-x-3 gap-y-1 text-[11px] text-monastery-text-muted">
                    {message.continuing ? (
                      <span className="flex items-center gap-1 text-monastery-lantern">
                        <Loader2 size={11} className="animate-spin" /> Continuing… (auto-continuation {message.autoContinueCount})
                      </span>
                    ) : (message.autoContinueCount ?? 0) > 0 ? (
                      <span className="flex items-center gap-1">
                        <RotateCcw size={11} /> Auto-continued {message.autoContinueCount}×
                      </span>
                    ) : null}
                    {message.usage?.total_tokens ? (
                      <span className="flex items-center gap-1" title={`prompt ${message.usage.prompt_tokens ?? '?'} · completion ${message.usage.completion_tokens ?? '?'}`}>
                        <Coins size={11} /> {message.usage.total_tokens.toLocaleString()} tokens
                      </span>
                    ) : null}
                  </div>
                )}
                {/* Manual Continue button — appears when the response still hit the output-token
                    cap after auto-continue is off or its limit was reached. */}
                {message.role === 'assistant' && message.truncated && !isGenerating && onContinue && (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => onContinue(message.id)}
                      className="flex items-center gap-1.5 px-3 py-1 text-xs bg-monastery-lantern text-monastery-dark-bg hover:opacity-90 rounded-lg transition-opacity font-medium"
                    >
                      ⏵ Continue generating
                    </button>
                    <span className="text-xs text-monastery-text-muted">
                      {(message.autoContinueCount ?? 0) > 0
                        ? 'Reached the auto-continue limit — continue manually if needed'
                        : "Response hit the model's output-token limit"}
                    </span>
                  </div>
                )}
                {/* Revert button on commit markers */}
                {message.role === 'system' && message.model && (
                  <button
                    onClick={() => handleRevert(message.model!)}
                    disabled={revertingId === message.model}
                    className="mt-2 flex items-center gap-1.5 px-3 py-1 text-xs bg-monastery-dark-surface hover:bg-monastery-lantern hover:text-monastery-dark-bg rounded-lg transition-colors disabled:opacity-50 mx-auto"
                  >
                    <RotateCcw size={12} />
                    {revertingId === message.model ? 'Reverting...' : (message.revertLabel || 'Revert to this snapshot')}
                  </button>
                )}
                {/* Workflow nudge: one click creates the task and starts the Plan stage */}
                {message.role === 'system' && message.suggestTaskTitle && onCreateTask && (
                  <button
                    onClick={() => onCreateTask(message.suggestTaskTitle!)}
                    className="mt-2 flex items-center gap-1.5 px-3 py-1 text-xs bg-monastery-pine hover:bg-monastery-forest text-white rounded-lg transition-colors mx-auto"
                  >
                    📋 Create a task for this &amp; plan it
                  </button>
                )}
                {/* Timestamp footer on every message */}
                {timeLabel && (
                  <div
                    className={`mt-1 text-[10px] leading-none ${
                      message.role === 'user'
                        ? 'text-white/50 text-right'
                        : message.role === 'system'
                        ? 'text-monastery-text-muted text-center'
                        : 'text-monastery-text-muted'
                    }`}
                    title={ts.toLocaleString()}
                  >
                    {timeLabel}
                  </div>
                )}
              </div>
            </div>
            );
          })
        )}
        
        {isGenerating && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-monastery-dark-surface border border-monastery-dark-border">
              <div className="flex items-center gap-2">
                <Spinner size={28} />
                <span className="text-monastery-text-muted text-sm">Contemplating...</span>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="border-t border-monastery-dark-border p-4">
        {/* Compact toolbar — all toggles inline on one row (left-aligned). Agent mode sits at the
            right; when it's on, the agent role chips are revealed inline after it. */}
        {(onToggleAutoContinue || (pocketbaseAvailable && onToggleDatabaseContext) || (hermesAvailable && onToggleAgentMode)) && (
          <div className="flex items-center flex-wrap gap-1.5 mb-2">
            {onToggleAutoContinue && (
              <button
                type="button" role="switch" aria-checked={autoContinue}
                onClick={() => onToggleAutoContinue(!autoContinue)}
                title={autoContinue ? 'Auto-continues responses cut off by the token limit (capped)' : 'Continue cut-off responses manually'}
                className={pill(autoContinue)}
              >
                <RotateCcw size={12} /> Auto-continue
              </button>
            )}
            {pocketbaseAvailable && onToggleDatabaseContext && (
              <button
                type="button" role="switch" aria-checked={useDatabaseContext}
                onClick={() => onToggleDatabaseContext(!useDatabaseContext)}
                title={useDatabaseContext ? 'Including Pocketbase backend + deploy instructions in context' : 'No backend / database context'}
                className={pill(useDatabaseContext)}
              >
                <Database size={12} /> Pocketbase
              </button>
            )}
            {hermesAvailable && onToggleAgentMode && (
              <button
                type="button" role="switch" aria-checked={agentMode}
                onClick={() => onToggleAgentMode(!agentMode)}
                title={agentMode ? 'Routing through the Hermes agent — select role(s) at right' : 'Standard LLM chat'}
                className={pill(agentMode)}
              >
                <Bot size={12} /> Agent mode
              </button>
            )}
            {/* Agent role chips — revealed only when Agent mode is on. Click to toggle (capped).
                When a workflow task is active, the stage roles are driven by the Workflow panel, so
                only the extras (Docs, Deploy) remain here as the quick ad-hoc lens. */}
            {agentMode && onToggleAgent && quickActions.length > 0 && (
              <>
                <span className="h-4 w-px bg-monastery-dark-border mx-0.5" aria-hidden />
                {hasActiveTask && (
                  <span className="text-[10px] text-monastery-text-muted" title="Plan/Implement/Verify/Review are run from the Workflow panel while a task is active">
                    Plan/Implement/Verify/Review → Workflow ·
                  </span>
                )}
                {(hasActiveTask ? quickActions.filter(a => !WORKFLOW_ROLE_IDS.includes(a.agentId)) : quickActions).map(action => {
                  const active = activeAgentIds.includes(action.agentId);
                  const atCap = !active && activeAgentIds.length >= maxActiveRoles;
                  return (
                    <button
                      key={action.agentId}
                      type="button"
                      onClick={() => onToggleAgent(action.agentId)}
                      disabled={atCap}
                      aria-pressed={active}
                      title={atCap ? `Max ${maxActiveRoles} roles — remove one first` : undefined}
                      className={`${pill(active)} disabled:opacity-40`}
                    >
                      {action.label}
                    </button>
                  );
                })}
                {activeAgentIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => activeAgentIds.forEach(id => onToggleAgent(id))}
                    className="text-[10px] text-monastery-text-muted hover:text-monastery-text-primary underline"
                  >
                    Clear
                  </button>
                )}
              </>
            )}
          </div>
        )}
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
              activeAgentIds.length === 1
                ? (quickActions.find(q => q.agentId === activeAgentIds[0])?.prompt ?? 'Ask anything...')
                : activeEndpoint
                ? "Ask anything... (Shift+Enter for new line)"
                : "Connect an LLM endpoint to start chatting"
            }
            disabled={!activeEndpoint && messages.length === 0}
            rows={1}
            style={{ maxHeight: MAX_INPUT_HEIGHT }}
            className="flex-1 bg-monastery-dark-surface border border-monastery-dark-border rounded-xl px-4 py-3 text-sm resize-y overflow-y-auto focus:outline-none focus:border-monastery-pine transition-colors"
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
