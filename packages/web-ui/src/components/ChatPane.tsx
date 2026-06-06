import React, { useState, useRef, useEffect } from 'react';
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
// Monastery Wireframe Background — Gold & Blue
// ============================================================

function MonasteryBackground() {
  return (
    <div className="monastery-wireframe absolute inset-0 overflow-hidden opacity-100">
      <svg
        viewBox="0 0 800 600"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 w-full h-full"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/* Gold glow gradients */}
          <radialGradient id="gg1" cx="50%" cy="25%" r="35%">
            <stop offset="0%" stopColor="#D4A030" stopOpacity="0.08">
              <animate attributeName="stop-opacity" values="0.04;0.10;0.04" dur="7s" repeatCount="indefinite" />
            </stop>
            <stop offset="100%" stopColor="#D4A030" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="gg2" cx="20%" cy="55%" r="25%">
            <stop offset="0%" stopColor="#C9A84C" stopOpacity="0.06">
              <animate attributeName="stop-opacity" values="0.02;0.08;0.02" dur="9s" repeatCount="indefinite" />
            </stop>
            <stop offset="100%" stopColor="#C9A84C" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="gg3" cx="80%" cy="55%" r="25%">
            <stop offset="0%" stopColor="#C9A84C" stopOpacity="0.06">
              <animate attributeName="stop-opacity" values="0.02;0.08;0.02" dur="11s" repeatCount="indefinite" />
            </stop>
            <stop offset="100%" stopColor="#C9A84C" stopOpacity="0" />
          </radialGradient>
          {/* Blue accent glows */}
          <radialGradient id="bg1" cx="50%" cy="70%" r="45%">
            <stop offset="0%" stopColor="#4A6FA5" stopOpacity="0.04">
              <animate attributeName="stop-opacity" values="0.02;0.06;0.02" dur="10s" repeatCount="indefinite" />
            </stop>
            <stop offset="100%" stopColor="#4A6FA5" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Background glows */}
        <rect width="800" height="600" fill="url(#gg1)" />
        <rect width="800" height="600" fill="url(#gg2)" />
        <rect width="800" height="600" fill="url(#gg3)" />
        <rect width="800" height="600" fill="url(#bg1)" />

        {/* ====== GOLD WIREFRAME ====== */}
        <g stroke="#D4A030" strokeWidth="0.7" fill="none" opacity="0.55">
          {/* ---- CEILING: Fan vault ribs ---- */}
          {[220,260,300,340,380,420,460,500,540,580].map((x, i) => (
            <line key={`vr-${i}`} x1={x} y1={180} x2={400} y2={20}
              strokeDasharray="2 8"
              style={{ animation: `wireframePulse1 8s ease-in-out infinite`, animationDelay: `${i*0.3}s` }} />
          ))}
          {/* Cross ribs */}
          {[40,80,120,160].map((y, i) => (
            <path key={`cr-${i}`} d={`M220,${y} Q400,${y-30} 580,${y}`}
              style={{ animation: `wireframePulse2 11s ease-in-out infinite`, animationDelay: `${i*0.5}s` }} />
          ))}
          {/* Ridge rib */}
          <line x1="200" y1="180" x2="600" y2="180" strokeWidth="1.2" />

          {/* ---- CENTRAL ARCH (pointed, 3 concentric layers) ---- */}
          <path d="M310,460 L310,220 Q310,120 400,100 Q490,120 490,220 L490,460" strokeWidth="1.3" />
          <path d="M325,460 L325,225 Q325,135 400,118 Q475,135 475,225 L475,460" strokeWidth="0.9" />
          <path d="M340,460 L340,230 Q340,150 400,136 Q460,150 460,230 L460,460" strokeWidth="0.6" opacity="0.7" />
          {/* Arch keystone */}
          <polygon points="394,104 400,96 406,104 403,112 397,112" strokeWidth="1" fill="#D4A030" fillOpacity="0.08" />

          {/* ---- LEFT ARCH ---- */}
          <path d="M125,460 L125,330 Q125,280 195,260 Q265,280 265,330 L265,460" strokeWidth="1.1" />
          <path d="M140,460 L140,335 Q140,292 195,275 Q250,292 250,335 L250,460" strokeWidth="0.7" opacity="0.7" />

          {/* ---- RIGHT ARCH ---- */}
          <path d="M535,460 L535,330 Q535,280 605,260 Q675,280 675,330 L675,460" strokeWidth="1.1" />
          <path d="M550,460 L550,335 Q550,292 605,275 Q660,292 660,335 L660,460" strokeWidth="0.7" opacity="0.7" />

          {/* ---- PILLARS ---- */}
          {[125,195,265,310,400,490,535,605,675].map((x, i) => (
            <React.Fragment key={`pil-${i}`}>
              <line x1={x} y1={x===310||x===490?180:260} x2={x} y2={510} strokeWidth="1" />
              {/* Fluting lines */}
              {x!==400 && [x-4,x+4].map((fx, j) => (
                <line key={`fl-${i}-${j}`} x1={fx} y1={x===310||x===490?190:270} x2={fx} y2={500} strokeWidth="0.4" opacity="0.5" />
              ))}
            </React.Fragment>
          ))}
          {/* Column capitals */}
          {[125,195,265,310,490,535,605,675].map((x, i) => (
            <path key={`cap-${i}`} d={`M${x-8},${x===310||x===490?180:260} L${x+8},${x===310||x===490?180:260} L${x+5},${x===310||x===490?170:250} L${x-5},${x===310||x===490?170:250}Z`} strokeWidth="0.7" />
          ))}

          {/* ---- ROSE WINDOW (central arch) ---- */}
          <circle cx="400" cy="190" r="40" strokeWidth="1" />
          <circle cx="400" cy="190" r="30" strokeWidth="0.7" />
          <circle cx="400" cy="190" r="18" strokeWidth="0.8" />
          <circle cx="400" cy="190" r="6" strokeWidth="0.9" />
          {/* Radial spokes */}
          {[0,30,60,90,120,150,180,210,240,270,300,330].map((deg, i) => {
            const rad = (deg * Math.PI) / 180;
            const x2 = 400 + 38 * Math.cos(rad);
            const y2 = 190 + 38 * Math.sin(rad);
            return <line key={`spk-${i}`} x1="400" y1="190" x2={x2} y2={y2} strokeWidth="0.5" opacity="0.6"
              style={{ animation: `wireframePulse1 8s ease-in-out infinite`, animationDelay: `${i*0.4}s` }} />;
          })}

          {/* ---- WALL TRIANGULAR MESH (dense) ---- */}
          <g opacity="0.35">
            {/* Left wall mesh */}
            {Array.from({length:6}).map((_, row) => (
              Array.from({length:5}).map((_, col) => {
                const x1=60+col*25, x2=x1+25, x3=x1+12.5;
                const yBase=300+row*28, y2=yBase+28;
                return (
                  <React.Fragment key={`lwm-${row}-${col}`}>
                    <line x1={x1} y1={yBase} x2={x2} y2={yBase} strokeWidth="0.35" />
                    <line x1={x1} y1={yBase} x2={x3} y2={y2} strokeWidth="0.35" />
                    <line x1={x2} y1={yBase} x2={x3} y2={y2} strokeWidth="0.35" />
                    {row>0 && <line x1={x3} y1={y2} x2={x1} y2={yBase} strokeWidth="0.25" />}
                  </React.Fragment>
                );
              })
            ))}
            {/* Right wall mesh */}
            {Array.from({length:6}).map((_, row) => (
              Array.from({length:5}).map((_, col) => {
                const x1=560+col*25, x2=x1+25, x3=x1+12.5;
                const yBase=300+row*28, y2=yBase+28;
                return (
                  <React.Fragment key={`rwm-${row}-${col}`}>
                    <line x1={x1} y1={yBase} x2={x2} y2={yBase} strokeWidth="0.35" />
                    <line x1={x1} y1={yBase} x2={x3} y2={y2} strokeWidth="0.35" />
                    <line x1={x2} y1={yBase} x2={x3} y2={y2} strokeWidth="0.35" />
                  </React.Fragment>
                );
              })
            ))}
          </g>

          {/* ---- FLOOR: Dense triangular mesh ---- */}
          <g opacity="0.35">
            {/* 10 columns of triangles across the floor */}
            {Array.from({length:10}).map((_, col) => (
              Array.from({length:5}).map((_, row) => {
                const isOffset = (col + row) % 2 === 0;
                const x1 = 40 + col * 76;
                const x2 = x1 + 76;
                const xm = x1 + 38;
                const y1 = 490 + row * 22;
                const y2 = y1 + 22;
                return (
                  <React.Fragment key={`fm-${col}-${row}`}>
                    {isOffset ? (
                      <>
                        <line x1={x1} y1={y1} x2={x2} y2={y1} strokeWidth="0.4" />
                        <line x1={x1} y1={y1} x2={xm} y2={y2} strokeWidth="0.4" />
                        <line x1={x2} y1={y1} x2={xm} y2={y2} strokeWidth="0.4" />
                      </>
                    ) : (
                      <>
                        <line x1={x1} y1={y2} x2={x2} y2={y2} strokeWidth="0.4" />
                        <line x1={x1} y1={y2} x2={xm} y2={y1} strokeWidth="0.4" />
                        <line x1={x2} y1={y2} x2={xm} y2={y1} strokeWidth="0.4" />
                      </>
                    )}
                  </React.Fragment>
                );
              })
            ))}
            {/* Floor horizon lines */}
            {[490,512,534,556,578,600].map((y) => (
              <line key={`fh-${y}`} x1="30" y1={y} x2="770" y2={y} strokeWidth="0.5" opacity="0.6" />
            ))}
          </g>

          {/* ---- HORIZONTAL STONE COURSES (all walls) ---- */}
          <g opacity="0.25">
            {[220,250,280,310,340,370,400,430,460].map((y) => (
              <line key={`sc-${y}`} x1="60" y1={y} x2="740" y2={y} strokeWidth="0.4"
                style={{ animation: `wireframePulse2 11s ease-in-out infinite`, animationDelay: `${y*0.01}s` }} />
            ))}
          </g>

          {/* ---- AMBULATORY (background corridor lines) ---- */}
          <g opacity="0.2">
            <path d="M200,120 L200,300" strokeWidth="0.5" />
            <path d="M600,120 L600,300" strokeWidth="0.5" />
            <path d="M200,120 Q400,80 600,120" strokeWidth="0.4" strokeDasharray="3 6" />
            <path d="M150,160 Q400,110 650,160" strokeWidth="0.3" strokeDasharray="2 8" />
          </g>
        </g>

        {/* ====== BLUE WIREFRAME (accent/secondary layer) ====== */}
        <g stroke="#4A6FA5" strokeWidth="0.5" fill="none" opacity="0.45">
          {/* Blue vault ribs crossing the gold ones */}
          <path d="M250,180 L400,40 L550,180" strokeWidth="0.8" strokeDasharray="4 10"
            style={{ animation: 'wireframePulse3 13s ease-in-out infinite' }} />
          <path d="M300,180 L400,60 L500,180" strokeWidth="0.6" strokeDasharray="3 8"
            style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '2s' }} />

          {/* Blue floor diagonals */}
          <g opacity="0.3">
            <line x1="100" y1="490" x2="250" y2="600" strokeWidth="0.4"
              style={{ animation: 'wireframePulse2 11s ease-in-out infinite' }} />
            <line x1="250" y1="490" x2="400" y2="600" strokeWidth="0.4"
              style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '0.6s' }} />
            <line x1="400" y1="490" x2="550" y2="600" strokeWidth="0.4"
              style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1.2s' }} />
            <line x1="550" y1="490" x2="700" y2="600" strokeWidth="0.4"
              style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '1.8s' }} />
            {/* Cross diagonals */}
            <line x1="700" y1="490" x2="550" y2="600" strokeWidth="0.4"
              style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '2.4s' }} />
            <line x1="550" y1="490" x2="400" y2="600" strokeWidth="0.4"
              style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '3s' }} />
            <line x1="400" y1="490" x2="250" y2="600" strokeWidth="0.4"
              style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '3.6s' }} />
            <line x1="250" y1="490" x2="100" y2="600" strokeWidth="0.4"
              style={{ animation: 'wireframePulse2 11s ease-in-out infinite', animationDelay: '4.2s' }} />
          </g>

          {/* Blue wall accents */}
          <g opacity="0.25">
            {/* Diagonal brick patterns on walls */}
            {[0,1,2,3,4].map((i) => (
              <React.Fragment key={`bwa-${i}`}>
                <line x1={60+i*18} y1={300} x2={80+i*18} y2={460} strokeWidth="0.3" />
                <line x1={740-i*18} y1={300} x2={720-i*18} y2={460} strokeWidth="0.3" />
              </React.Fragment>
            ))}
          </g>

          {/* Blue arch tracery accents */}
          <path d="M310,400 Q400,370 490,400" strokeWidth="0.6" opacity="0.4"
            style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '5s' }} />
          <path d="M310,430 Q400,405 490,430" strokeWidth="0.5" opacity="0.35"
            style={{ animation: 'wireframePulse3 13s ease-in-out infinite', animationDelay: '6s' }} />
        </g>
      </svg>
    </div>
  );
}
