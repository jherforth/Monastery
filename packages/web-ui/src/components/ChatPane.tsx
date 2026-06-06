import { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, X, StopCircle } from 'lucide-react';
import { Message, Attachment } from '../types';
import { useAppStore } from '../store/useAppStore';

interface ChatPaneProps {
  messages: Message[];
  onSendMessage: (content: string, attachments?: Attachment[]) => void;
  onStopGeneration?: () => void;
  isGenerating?: boolean;
}

export function ChatPane({ 
  messages, 
  onSendMessage, 
  onStopGeneration,
  isGenerating = false 
}: ChatPaneProps) {
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { activeEndpoint } = useAppStore();

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

  return (
    <div className="flex flex-col h-full bg-monastery-dark-bg relative overflow-hidden">
      {/* Monastery Wireframe Background */}
      <MonasteryBackground />
      
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 relative z-10">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-lg px-6">
              {/* Monastery Logo */}
              <div className="w-16 h-16 bg-monastery-forest rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-monastery-forest/20">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-monastery-lantern">
                  <path d="M3 21V7l9-4 9 4v14" />
                  <path d="M3 7l9 4 9-4" />
                  <path d="M12 11v10" />
                  <path d="M8 14v4" />
                  <path d="M16 14v4" />
                </svg>
              </div>

              <h1 className="text-2xl font-semibold text-monastery-text-primary mb-2">
                Welcome to Monastery
              </h1>
              <p className="text-sm text-monastery-text-secondary mb-2">
                Build in silence. Deploy with purpose.
              </p>
              <p className="text-xs text-monastery-text-muted mb-8 max-w-sm mx-auto leading-relaxed">
                Your calm, self-hosted sanctuary for AI-assisted coding.
                Connect an LLM to begin — ask it to create, edit, debug, or deploy applications.
              </p>

              {/* Quick Start Suggestions */}
              <div className="grid grid-cols-2 gap-2 text-left max-w-sm mx-auto">
                <button 
                  onClick={() => onSendMessage('Create a Next.js app with authentication')}
                  className="p-3 bg-monastery-dark-surface rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine-green text-left"
                >
                  <div className="font-medium text-monastery-text-primary mb-0.5">Web App</div>
                  Create a Next.js app with authentication
                </button>
                <button 
                  onClick={() => onSendMessage('Explain how this project structure works')}
                  className="p-3 bg-monastery-dark-surface rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine-green text-left"
                >
                  <div className="font-medium text-monastery-text-primary mb-0.5">Understand</div>
                  Explain this codebase structure
                </button>
                <button 
                  onClick={() => onSendMessage('Add unit tests to the existing module')}
                  className="p-3 bg-monastery-dark-surface rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine-green text-left"
                >
                  <div className="font-medium text-monastery-text-primary mb-0.5">Testing</div>
                  Add tests to the existing module
                </button>
                <button 
                  onClick={() => onSendMessage('Deploy this project to my homelab server')}
                  className="p-3 bg-monastery-dark-surface rounded-xl text-xs text-monastery-text-secondary hover:bg-monastery-dark-tertiary hover:text-monastery-text-primary transition-all border border-monastery-dark-border hover:border-monastery-pine-green text-left"
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
                <div className="whitespace-pre-wrap text-sm">{message.content}</div>
              </div>
            </div>
          ))
        )}
        
        {isGenerating && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-monastery-dark-surface border border-monastery-dark-border">
              <div className="flex items-center gap-2">
                <div className="lantern-loading w-2 h-2 bg-monastery-lantern rounded-full" />
                <div className="lantern-loading w-2 h-2 bg-monastery-lantern rounded-full" style={{ animationDelay: '0.2s' }} />
                <div className="lantern-loading w-2 h-2 bg-monastery-lantern rounded-full" style={{ animationDelay: '0.4s' }} />
                <span className="text-monastery-text-muted text-sm ml-2">Generating...</span>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

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

// ============================================================
// Monastery Wireframe Background
// ============================================================

function MonasteryBackground() {
  return (
    <div className="monastery-wireframe absolute inset-0 overflow-hidden opacity-100">
      <style>{`
        @keyframes wireframePulse1 {
          0%, 100% { opacity: 0.05; stroke-dashoffset: 0; }
          30% { opacity: 0.15; }
          60% { opacity: 0.07; stroke-dashoffset: -200; }
        }
        @keyframes wireframePulse2 {
          0%, 100% { opacity: 0.04; stroke-dashoffset: 0; }
          40% { opacity: 0.12; }
          70% { opacity: 0.06; stroke-dashoffset: -150; }
        }
        @keyframes wireframePulse3 {
          0%, 100% { opacity: 0.03; }
          25% { opacity: 0.10; stroke-dashoffset: -100; }
          55% { opacity: 0.05; }
          85% { opacity: 0.12; stroke-dashoffset: -250; }
        }
        @keyframes wireframeGlow {
          0%, 100% { stop-opacity: 0.01; }
          50% { stop-opacity: 0.07; }
        }
      `}</style>

      <svg
        viewBox="0 0 800 600"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 w-full h-full"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Subtle radial glow gradients */}
          <radialGradient id="glow1" cx="50%" cy="30%" r="40%">
            <stop offset="0%" stopColor="#F4A460" stopOpacity="0.06" className="glow-stop">
              <animate attributeName="stop-opacity" values="0.02;0.08;0.02" dur="7s" repeatCount="indefinite" />
            </stop>
            <stop offset="100%" stopColor="#F4A460" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="glow2" cx="20%" cy="50%" r="30%">
            <stop offset="0%" stopColor="#F4A460" stopOpacity="0.04">
              <animate attributeName="stop-opacity" values="0.01;0.06;0.01" dur="9s" repeatCount="indefinite" />
            </stop>
            <stop offset="100%" stopColor="#F4A460" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="glow3" cx="80%" cy="50%" r="30%">
            <stop offset="0%" stopColor="#F4A460" stopOpacity="0.04">
              <animate attributeName="stop-opacity" values="0.01;0.06;0.01" dur="11s" repeatCount="indefinite" />
            </stop>
            <stop offset="100%" stopColor="#F4A460" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Background glow rectangles */}
        <rect width="800" height="600" fill="url(#glow1)" />
        <rect width="800" height="600" fill="url(#glow2)" />
        <rect width="800" height="600" fill="url(#glow3)" />

        <g stroke="#1E6B4E" strokeWidth="0.8" fill="none" opacity="0.5">
          {/* === CEILING VAULTS === */}
          {/* Central vault ribs converging upward */}
          <path d="M400,180 L250,0" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite' }} />
          <path d="M400,180 L550,0" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '0.5s' }} />
          <path d="M400,180 L340,0" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite' }} />
          <path d="M400,180 L460,0" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '0.7s' }} />
          <path d="M400,180 L400,0" className="pulse-3" style={{ animation: 'wireframePulse3 13s ease-in-out infinite' }} />

          {/* Horizontal ceiling braces */}
          <line x1="220" y1="60" x2="580" y2="60" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '2s' }} />
          <line x1="280" y1="120" x2="520" y2="120" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '3s' }} />

          {/* === CENTRAL ARCH (tall pointed arch) === */}
          <path d="M320,450 L320,240 Q320,160 400,140 Q480,160 480,240 L480,450"
            className="pulse-3" style={{ animation: 'wireframePulse3 13s ease-in-out infinite' }} />
          {/* Inner arch line */}
          <path d="M340,450 L340,250 Q340,180 400,165 Q460,180 460,250 L460,450"
            className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '1.5s' }} />
          {/* Arch keystone */}
          <circle cx="400" cy="142" r="6" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite' }} />

          {/* === LEFT ARCH === */}
          <path d="M140,450 L140,340 Q140,300 200,280 Q260,300 260,340 L260,450"
            className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1s' }} />
          <path d="M155,450 L155,345 Q155,312 200,298 Q245,312 245,345 L245,450"
            className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '2.5s' }} />

          {/* === RIGHT ARCH === */}
          <path d="M540,450 L540,340 Q540,300 600,280 Q660,300 660,340 L660,450"
            className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '3s' }} />
          <path d="M555,450 L555,345 Q555,312 600,298 Q645,312 645,345 L645,450"
            className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '4s' }} />

          {/* === PILLARS / COLUMNS === */}
          <line x1="320" y1="180" x2="320" y2="500" className="pulse-3" style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '1s' }} />
          <line x1="480" y1="180" x2="480" y2="500" className="pulse-3" style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '2s' }} />
          <line x1="140" y1="300" x2="140" y2="500" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '3.5s' }} />
          <line x1="260" y1="300" x2="260" y2="500" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '4s' }} />
          <line x1="540" y1="300" x2="540" y2="500" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '2.5s' }} />
          <line x1="660" y1="300" x2="660" y2="500" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '5s' }} />

          {/* Column capitals (decorative tops) */}
          <path d="M310,185 L330,175 L320,165" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '1s' }} />
          <path d="M490,185 L470,175 L480,165" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '1.3s' }} />

          {/* === FLOOR - Triangular mesh === */}
          <g opacity="0.3">
            {/* Row 1 */}
            <line x1="100" y1="500" x2="250" y2="460" className="pulse-3" style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '0.5s' }} />
            <line x1="250" y1="460" x2="400" y2="500" className="pulse-3" style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '0.8s' }} />
            <line x1="400" y1="500" x2="550" y2="460" className="pulse-3" style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '1.1s' }} />
            <line x1="550" y1="460" x2="700" y2="500" className="pulse-3" style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '1.4s' }} />

            {/* Row 2 */}
            <line x1="70" y1="540" x2="200" y2="500" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1s' }} />
            <line x1="200" y1="500" x2="330" y2="540" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1.3s' }} />
            <line x1="330" y1="540" x2="470" y2="500" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1.6s' }} />
            <line x1="470" y1="500" x2="600" y2="540" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1.9s' }} />
            <line x1="600" y1="540" x2="730" y2="500" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '2.2s' }} />

            {/* Cross-lines for triangular mesh */}
            <line x1="100" y1="500" x2="200" y2="500" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '0.3s' }} />
            <line x1="250" y1="460" x2="330" y2="540" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '0.6s' }} />
            <line x1="400" y1="500" x2="470" y2="500" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '0.9s' }} />
            <line x1="550" y1="460" x2="600" y2="540" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '1.2s' }} />
            <line x1="700" y1="500" x2="730" y2="500" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '1.5s' }} />

            {/* Floor edge lines */}
            <line x1="50" y1="500" x2="750" y2="500" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '0.5s' }} />
            <line x1="50" y1="540" x2="750" y2="540" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1s' }} />
            <line x1="50" y1="580" x2="750" y2="580" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1.5s' }} />
          </g>

          {/* === ARCH DETAIL LINES (rose window / tracery suggestion) === */}
          <g opacity="0.25">
            <circle cx="400" cy="220" r="25" className="pulse-3" style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '2s' }} />
            <circle cx="400" cy="220" r="12" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '0.5s' }} />
            <line x1="388" y1="220" x2="412" y2="220" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1s' }} />
            <line x1="400" y1="208" x2="400" y2="232" className="pulse-2" style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1.3s' }} />
            {/* Small arch tracery */}
            <path d="M375,235 Q375,200 400,195 Q425,200 425,235" className="pulse-1" style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: '2s' }} />
            <path d="M385,235 Q385,210 400,207 Q415,210 415,235" className="pulse-3" style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '2.5s' }} />
          </g>

          {/* === WALL DETAILS - horizontal courses === */}
          <g opacity="0.2">
            {[300, 340, 380, 420].map((y, i) => (
              <line key={`hl-${y}`} x1="80" y1={y} x2="720" y2={y}
                className="pulse-1"
                style={{ animation: 'wireframePulse1 8s ease-in-out infinite', animationDelay: `${i * 0.8}s` }} />
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}
