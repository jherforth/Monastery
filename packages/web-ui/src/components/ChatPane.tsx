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
    <div className="flex flex-col h-full bg-monastery-dark-bg">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-monastery-text-muted">
            <div className="text-center max-w-md">
              <h3 className="text-lg font-medium text-monastery-text-primary mb-2">
                Welcome to Monastery
              </h3>
              <p className="text-sm">
                Start a conversation with your AI assistant. Ask it to create, edit, or explain code.
              </p>
              <div className="mt-6 grid grid-cols-2 gap-2 text-left">
                <button className="p-3 bg-monastery-dark-surface rounded-lg text-xs hover:bg-monastery-dark-tertiary transition-colors">
                  "Create a Next.js app with authentication"
                </button>
                <button className="p-3 bg-monastery-dark-surface rounded-lg text-xs hover:bg-monastery-dark-tertiary transition-colors">
                  "Explain this codebase structure"
                </button>
                <button className="p-3 bg-monastery-dark-surface rounded-lg text-xs hover:bg-monastery-dark-tertiary transition-colors">
                  "Add tests to the existing module"
                </button>
                <button className="p-3 bg-monastery-dark-surface rounded-lg text-xs hover:bg-monastery-dark-tertiary transition-colors">
                  "Deploy this to my homelab"
                </button>
              </div>
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
