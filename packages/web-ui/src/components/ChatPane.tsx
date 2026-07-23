import { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, X, StopCircle, Copy, Check, RotateCcw, Brain, ChevronDown, ChevronRight, Bot, Loader2, Coins, MessageSquare, Plus, Trash2, SlidersHorizontal, Settings } from 'lucide-react';
import { Message, Attachment, SessionInfo } from '../types';
import { DiffCard } from './DiffCard';
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

// Compact relative timestamp for the session list ("5m ago", "3d ago").
const formatSessionDate = (dateStr: string) => {
  try {
    const d = new Date(dateStr);
    const diffMs = Date.now() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  } catch {
    return dateStr;
  }
};

/** A context/behavior option in the composer's "+ Context" popover. Registry-driven: App
 *  builds these from the skill registry (lib/skills.ts) plus fixed behaviors, so adding a
 *  skill requires no composer changes. */
export interface ComposerToggle {
  id: string;
  label: string;
  description: string;
  active: boolean;
  onToggle: (on: boolean) => void;
  /** Show a removable chip in the toolbar while active (default true). */
  showChip?: boolean;
}

interface ChatPaneProps {
  messages: Message[];
  onSendMessage: (content: string, attachments?: Attachment[]) => void;
  /** Chat sessions for the active project — shown in the header session switcher. */
  sessions?: SessionInfo[];
  currentSessionId?: string | null;
  onCreateSession?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  /** Context & behavior options for the composer popover. */
  contextToggles?: ComposerToggle[];
  /** Active task chip in the header ("🛠 title · stage"); null label shows a plain Tasks chip. */
  activeTaskLabel?: string | null;
  onOpenTasks?: () => void;
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
  /** Permanently suppress the large-project workflow nudge (persisted by the app). */
  onSuppressWorkflowNudge?: () => void;
  isGenerating?: boolean;
  /** Whether a default Hermes connection exists (enables the Agent mode toggle). */
  hermesAvailable?: boolean;
  /** Whether Agent mode (route to Hermes) is currently on. */
  agentMode?: boolean;
  onToggleAgentMode?: (on: boolean) => void;
}

export function ChatPane({
  messages,
  onSendMessage,
  sessions = [],
  currentSessionId = null,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  contextToggles = [],
  activeTaskLabel = null,
  onOpenTasks,
  activeAgentIds = [],
  onToggleAgent,
  maxActiveRoles = 2,
  hasActiveTask = false,
  onStopGeneration,
  onContinue,
  onReverted,
  onCreateTask,
  onSuppressWorkflowNudge,
  isGenerating = false,
  hermesAvailable = false,
  agentMode = false,
  onToggleAgentMode,
}: ChatPaneProps) {
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [rolesMenuOpen, setRolesMenuOpen] = useState(false);
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
    <div className="flex flex-col h-full bg-monastery-dark-surface relative overflow-hidden">
      {/* Chat header — session switcher (sessions belong to the chat, not the file tree) */}
      {onSelectSession && (
        <div className="relative z-20 flex items-center gap-1 px-3 py-1.5 shrink-0">
          <div className="relative min-w-0">
            <button
              onClick={() => setSessionMenuOpen(o => !o)}
              className="flex items-center gap-1.5 px-2 py-1 max-w-full hover:bg-monastery-dark-tertiary rounded-md transition-colors text-xs text-monastery-text-secondary"
              title="Switch chat session"
            >
              <MessageSquare size={13} className="shrink-0" />
              <span className="truncate">
                {sessions.find(s => s.id === currentSessionId)?.title || 'New session'}
              </span>
              <ChevronDown size={12} className="text-monastery-text-muted shrink-0" />
            </button>
            {sessionMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSessionMenuOpen(false)} />
                <div className="absolute top-full left-0 mt-1 w-72 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg shadow-xl z-20 py-1 max-h-80 overflow-y-auto">
                  {onCreateSession && (
                    <>
                      <button
                        onClick={() => { onCreateSession(); setSessionMenuOpen(false); }}
                        className="w-full text-left px-3 py-2 text-sm text-monastery-lantern hover:bg-monastery-dark-tertiary transition-colors flex items-center gap-2"
                      >
                        <Plus size={14} /> New Session
                      </button>
                      {sessions.length > 0 && <div className="border-t border-monastery-dark-border my-1" />}
                    </>
                  )}
                  {sessions.map(session => (
                    <div
                      key={session.id}
                      onClick={() => { onSelectSession(session.id); setSessionMenuOpen(false); }}
                      className={`group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                        currentSessionId === session.id
                          ? 'bg-monastery-dark-tertiary text-monastery-text-primary'
                          : 'text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary'
                      }`}
                    >
                      <MessageSquare size={14} className="shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">{session.title}</div>
                        <div className="text-xs text-monastery-text-muted">
                          {formatSessionDate(session.updated_at)}
                          {session.message_count > 0 && ` · ${session.message_count} msgs`}
                        </div>
                      </div>
                      {onDeleteSession && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded transition-all shrink-0"
                          title="Delete session"
                        >
                          <Trash2 size={12} className="text-red-400" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          {onCreateSession && (
            <button
              onClick={onCreateSession}
              className="p-1 hover:bg-monastery-dark-tertiary rounded-md transition-colors text-monastery-text-secondary hover:text-monastery-text-primary shrink-0"
              title="New session"
            >
              <Plus size={14} />
            </button>
          )}

          {/* Task chip — the staged workflow lives in a drawer, not a stacked panel */}
          {onOpenTasks && (
            <button
              onClick={onOpenTasks}
              className={`ml-auto flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors shrink-0 max-w-[45%] ${
                activeTaskLabel
                  ? 'bg-monastery-lantern/15 text-monastery-lantern hover:bg-monastery-lantern/25'
                  : 'text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary'
              }`}
              title={activeTaskLabel ? 'Open the active task' : 'Structured tasks: Plan → Implement → Verify → Review'}
            >
              <span className="truncate">🛠 {activeTaskLabel || 'Tasks'}</span>
            </button>
          )}
        </div>
      )}

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
                  className="p-3 bg-monastery-dark-bg rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine text-left"
                >
                  <div className="font-medium text-monastery-text-primary mb-0.5">Web App</div>
                  Create a Next.js app with authentication
                </button>
                <button 
                  onClick={() => onSendMessage('Explain how this project structure works')}
                  className="p-3 bg-monastery-dark-bg rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine text-left"
                >
                  <div className="font-medium text-monastery-text-primary mb-0.5">Understand</div>
                  Explain this codebase structure
                </button>
                <button 
                  onClick={() => onSendMessage('Add unit tests to the existing module')}
                  className="p-3 bg-monastery-dark-bg rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine text-left"
                >
                  <div className="font-medium text-monastery-text-primary mb-0.5">Testing</div>
                  Add tests to the existing module
                </button>
                <button 
                  onClick={() => onSendMessage('Deploy this project to my homelab server')}
                  className="p-3 bg-monastery-dark-bg rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine text-left"
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
            // Activity chatter (context pulls, recovery steps) renders as a slim inline row,
            // not a bubble — the conversation stays about the conversation.
            if (message.kind === 'activity') {
              return (
                <div key={message.id} className="flex justify-start">
                  <div className="px-2 py-0.5 text-[11px] text-monastery-text-muted leading-relaxed">
                    {renderInline(message.content)}
                  </div>
                </div>
              );
            }
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
                    ? 'bg-monastery-dark-tertiary text-center'
                    : 'bg-monastery-dark-bg'
                }`}
              >
                {/* Agent role chips on a user message (which role(s) it was sent under) */}
                {message.role === 'user' && message.agentLabels && message.agentLabels.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {message.agentLabels.map((label, i) => (
                      <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] bg-white/15 font-medium">
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
                  <span className="inline-flex items-center gap-1 mb-1.5 px-1.5 py-0.5 rounded text-[11px] font-medium bg-monastery-lantern/15 text-monastery-lantern">
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
                {/* Per-file diff cards on AI-change feedback messages */}
                {message.fileChanges && message.fileChanges.map(change => (
                  <DiffCard key={change.path} change={change} />
                ))}
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
                {/* Workflow nudge: one click creates the task and starts the Plan stage;
                    a second link permanently dismisses the reminder. */}
                {message.role === 'system' && message.suggestTaskTitle && onCreateTask && (
                  <div className="mt-2 flex items-center justify-center gap-3">
                    <button
                      onClick={() => onCreateTask(message.suggestTaskTitle!)}
                      className="flex items-center gap-1.5 px-3 py-1 text-xs bg-monastery-pine hover:bg-monastery-forest text-white rounded-lg transition-colors"
                    >
                      📋 Create a task for this &amp; plan it
                    </button>
                    {onSuppressWorkflowNudge && (
                      <button
                        onClick={onSuppressWorkflowNudge}
                        className="text-xs text-monastery-text-muted hover:text-monastery-text-secondary underline transition-colors"
                      >
                        Don't show again
                      </button>
                    )}
                  </div>
                )}
                {/* Timestamp footer on every message */}
                {timeLabel && (
                  <div
                    className={`mt-1 text-[11px] leading-none ${
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

      {/* Input — no rule above it; the inset field carries its own edge */}
      <form onSubmit={handleSubmit} className="p-4 pt-2">
        {/* Composer toolbar: a "+ Context" popover holds the registry-driven options (skills,
            behaviors) so new ones never widen this row; active ones surface as removable chips.
            The Chat/Agent mode selector sits at the right, with roles behind it in a popover. */}
        <div className="flex items-center flex-wrap gap-1.5 mb-2">
          {/* Context popover */}
          {contextToggles.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setContextMenuOpen(o => !o)}
                className={pill(false)}
                title="Context & behavior options"
              >
                <SlidersHorizontal size={12} /> Context
              </button>
              {contextMenuOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setContextMenuOpen(false)} />
                  <div className="absolute bottom-full left-0 mb-1 w-80 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg shadow-xl z-30 py-1">
                    {contextToggles.map(t => (
                      <button
                        key={t.id}
                        type="button"
                        role="switch"
                        aria-checked={t.active}
                        onClick={() => t.onToggle(!t.active)}
                        className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-monastery-dark-tertiary transition-colors"
                      >
                        <span className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                          t.active ? 'bg-monastery-pine border-monastery-pine text-white' : 'border-monastery-dark-border'
                        }`}>
                          {t.active && <Check size={11} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm text-monastery-text-primary">{t.label}</span>
                          <span className="block text-xs text-monastery-text-muted">{t.description}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Active context chips (click to remove) */}
          {contextToggles.filter(t => t.active && t.showChip !== false).map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => t.onToggle(false)}
              className={pill(true)}
              title={`${t.description} — click to disable`}
            >
              {t.label} <X size={10} />
            </button>
          ))}

          {/* Active role chips (click to remove) */}
          {agentMode && onToggleAgent && activeAgentIds.map(id => {
            const action = quickActions.find(a => a.agentId === id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => onToggleAgent(id)}
                className={pill(true)}
                title="Click to remove this role"
              >
                {action?.label ?? id} <X size={10} />
              </button>
            );
          })}

          {/* Mode selector — Chat vs Agent (Hermes). Always visible so the routing decision is
              legible; without a Hermes connection the Agent side deep-links to Settings. */}
          {onToggleAgentMode && (
            <div className="ml-auto flex items-center gap-1.5">
              {agentMode && onToggleAgent && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setRolesMenuOpen(o => !o)}
                    className={pill(false)}
                    title="Agent roles — a persistent lens applied to your messages"
                  >
                    Roles{activeAgentIds.length > 0 ? ` · ${activeAgentIds.length}` : ''} <ChevronDown size={10} />
                  </button>
                  {rolesMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-20" onClick={() => setRolesMenuOpen(false)} />
                      <div className="absolute bottom-full right-0 mb-1 w-72 bg-monastery-dark-surface border border-monastery-dark-border rounded-lg shadow-xl z-30 py-1">
                        {hasActiveTask && (
                          <div className="px-3 py-1.5 text-[11px] text-monastery-text-muted border-b border-monastery-dark-border">
                            Plan / Implement / Verify / Review run from the active task while one is open — only extra lenses are listed here.
                          </div>
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
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-monastery-dark-tertiary transition-colors disabled:opacity-40"
                            >
                              <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                                active ? 'bg-monastery-pine border-monastery-pine text-white' : 'border-monastery-dark-border'
                              }`}>
                                {active && <Check size={11} />}
                              </span>
                              <span className="text-sm text-monastery-text-primary">{action.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
              <div className="flex rounded-md border border-monastery-dark-border overflow-hidden" role="radiogroup" aria-label="Chat mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!agentMode}
                  onClick={() => onToggleAgentMode(false)}
                  title="Standard LLM chat"
                  className={`flex items-center gap-1 px-2 py-0.5 text-[11px] transition-colors ${
                    !agentMode
                      ? 'bg-monastery-lantern text-monastery-dark-bg font-medium'
                      : 'bg-monastery-dark-surface text-monastery-text-secondary hover:text-monastery-text-primary'
                  }`}
                >
                  <MessageSquare size={11} /> Chat
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={agentMode}
                  onClick={() => {
                    if (hermesAvailable) {
                      onToggleAgentMode(true);
                    } else {
                      // No Hermes connection — take the user to the place that fixes it.
                      window.dispatchEvent(new CustomEvent('monastery:open-settings', { detail: { tab: 'hermes' } }));
                    }
                  }}
                  title={hermesAvailable
                    ? 'Route messages through the Hermes agent (tools, sub-agents)'
                    : 'Requires a Hermes connection — opens Settings → Hermes Agent'}
                  className={`flex items-center gap-1 px-2 py-0.5 text-[11px] transition-colors ${
                    agentMode
                      ? 'bg-monastery-lantern text-monastery-dark-bg font-medium'
                      : hermesAvailable
                      ? 'bg-monastery-dark-surface text-monastery-text-secondary hover:text-monastery-text-primary'
                      : 'bg-monastery-dark-surface text-monastery-text-muted'
                  }`}
                >
                  {hermesAvailable ? <Bot size={11} /> : <Settings size={11} />} Agent
                </button>
              </div>
            </div>
          )}
        </div>
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
          <label className="p-2 hover:bg-monastery-dark-tertiary rounded-lg transition-colors cursor-pointer">
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
            className="flex-1 bg-monastery-dark-bg border border-monastery-dark-border rounded-xl px-4 py-3 text-sm resize-y overflow-y-auto focus:outline-none focus:border-monastery-pine transition-colors"
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
