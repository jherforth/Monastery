import { useState, useEffect, useRef } from 'react';
import { Eye, RefreshCw, AlertTriangle, Wrench, X } from 'lucide-react';

/** A runtime error forwarded by the bridge script the backend injects into preview pages. */
export interface PreviewError {
  kind: 'error' | 'rejection' | 'console' | 'resource';
  message: string;
  stack?: string;
  page?: string;
}

interface PreviewPaneProps {
  projectId?: string | null;
  /** Hand the collected errors to the chat to fix (Build mode). */
  onFixErrors?: (errors: PreviewError[]) => void;
}

const MAX_ERRORS = 20;

// Live preview of the project's index.html. Errors the page throws come back over postMessage
// (see PREVIEW_ERROR_BRIDGE in the backend) and surface as a "Fix it" chip.
export function PreviewPane({ projectId, onFixErrors }: PreviewPaneProps) {
  const [previewKey, setPreviewKey] = useState(0);
  const [errors, setErrors] = useState<PreviewError[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewUrl = projectId ? `/api/projects/${projectId}/preview/index.html` : 'about:blank';

  // Auto-refresh whenever the AI (or a manual save) writes files — debounced, since a single
  // response can write several files in quick succession.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setPreviewKey(k => k + 1), 250);
    };
    window.addEventListener('monastery:files-written', handler);
    return () => { clearTimeout(timer); window.removeEventListener('monastery:files-written', handler); };
  }, []);

  // A reload (or a different project) starts with a clean slate.
  useEffect(() => { setErrors([]); setShowErrors(false); }, [previewKey, projectId]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data;
      if (!d || d.source !== 'monastery-preview' || typeof d.message !== 'string') return;
      setErrors(prev => {
        if (prev.length >= MAX_ERRORS || prev.some(p => p.message === d.message && p.kind === d.kind)) return prev;
        return [...prev, { kind: d.kind, message: d.message, stack: d.stack || undefined, page: d.page || undefined }];
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div className="h-full flex flex-col bg-monastery-dark-bg">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-monastery-dark-border bg-monastery-dark-surface">
        <div className="flex items-center gap-2 min-w-0">
          <Eye size={14} className="text-monastery-text-secondary shrink-0" />
          <span className="text-xs font-medium text-monastery-text-secondary">
            {projectId ? 'Live Preview' : 'Preview (no project)'}
          </span>
          {errors.length > 0 && (
            <button
              onClick={() => setShowErrors(s => !s)}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md bg-amber-400/15 text-amber-300 hover:bg-amber-400/25 transition-colors"
              title="Errors reported by the page — click for details"
            >
              <AlertTriangle size={11} /> {errors.length} {errors.length === 1 ? 'error' : 'errors'}
            </button>
          )}
          {errors.length > 0 && onFixErrors && (
            <button
              onClick={() => { onFixErrors(errors); setShowErrors(false); }}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md bg-monastery-pine hover:bg-monastery-forest text-white transition-colors"
              title="Send these errors to the chat and fix them"
            >
              <Wrench size={11} /> Fix it
            </button>
          )}
        </div>
        <button
          onClick={() => setPreviewKey(k => k + 1)}
          className="p-1.5 hover:bg-monastery-dark-tertiary rounded transition-colors shrink-0"
          title="Refresh preview"
        >
          <RefreshCw size={14} className="text-monastery-lantern" />
        </button>
      </div>
      {showErrors && errors.length > 0 && (
        <div className="max-h-48 overflow-y-auto border-b border-monastery-dark-border bg-monastery-dark-surface px-3 py-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-monastery-text-muted">Reported by the page</span>
            <button onClick={() => setShowErrors(false)} className="p-0.5 text-monastery-text-muted hover:text-monastery-text-primary" title="Hide">
              <X size={12} />
            </button>
          </div>
          {errors.map((err, i) => (
            <div key={i} className="text-xs font-mono text-amber-200/90 break-words">
              <span className="text-monastery-text-muted">[{err.kind}{err.page ? ` · ${err.page}` : ''}]</span> {err.message}
            </div>
          ))}
        </div>
      )}
      <iframe
        ref={iframeRef}
        key={previewKey}
        src={previewUrl}
        className="flex-1 w-full bg-white"
        title="Preview"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
      />
    </div>
  );
}

/** The chat prompt for "Fix it": every collected error, with stacks, as one fix request. */
export function previewErrorsPrompt(errors: PreviewError[]): string {
  const lines = errors.map(e => {
    const where = e.page ? ` (on ${e.page})` : '';
    return `- [${e.kind}]${where} ${e.message}${e.stack ? `\n  ${e.stack.split('\n').slice(0, 6).join('\n  ')}` : ''}`;
  });
  return `The live preview reported ${errors.length === 1 ? 'this error' : 'these errors'}:\n\n${lines.join('\n')}\n\nFind the root cause in the project files and fix it.`;
}
