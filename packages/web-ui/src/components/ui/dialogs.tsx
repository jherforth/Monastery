import { createContext, useCallback, useContext, useRef, useState, ReactNode } from 'react';
import { AlertTriangle, HelpCircle, Info } from 'lucide-react';
import { Modal } from './Modal';

/**
 * App-styled replacements for window.confirm / window.prompt / alert.
 * Mount <DialogProvider> once at the root; call the async helpers anywhere:
 *
 *   const { confirm, promptText, notice } = useDialogs();
 *   if (await confirm({ title: 'Delete file?', message: '…', danger: true })) …
 */

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button red for destructive actions. */
  danger?: boolean;
}

interface PromptOptions {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
}

interface NoticeOptions {
  title: string;
  message?: ReactNode;
}

type DialogRequest =
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (value: string | null) => void } & PromptOptions)
  | ({ kind: 'notice'; resolve: () => void } & NoticeOptions);

interface DialogApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  promptText: (opts: PromptOptions) => Promise<string | null>;
  notice: (opts: NoticeOptions) => Promise<void>;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialogs(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialogs must be used within <DialogProvider>');
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const confirm = useCallback((opts: ConfirmOptions) =>
    new Promise<boolean>(resolve => setRequest({ kind: 'confirm', ...opts, resolve })), []);

  const promptText = useCallback((opts: PromptOptions) =>
    new Promise<string | null>(resolve => {
      setPromptValue(opts.initialValue ?? '');
      setRequest({ kind: 'prompt', ...opts, resolve });
    }), []);

  const notice = useCallback((opts: NoticeOptions) =>
    new Promise<void>(resolve => setRequest({ kind: 'notice', ...opts, resolve })), []);

  const settle = (result: boolean | string | null) => {
    if (!request) return;
    if (request.kind === 'confirm') request.resolve(result === true);
    else if (request.kind === 'prompt') request.resolve(typeof result === 'string' ? result : null);
    else request.resolve();
    setRequest(null);
  };

  const icon = request?.kind === 'notice'
    ? <Info size={16} className="text-monastery-lantern" />
    : request?.kind === 'prompt'
    ? <HelpCircle size={16} className="text-monastery-lantern" />
    : (request as ConfirmOptions | null)?.danger
    ? <AlertTriangle size={16} className="text-red-400" />
    : <HelpCircle size={16} className="text-monastery-lantern" />;

  return (
    <DialogContext.Provider value={{ confirm, promptText, notice }}>
      {children}
      <Modal
        open={request !== null}
        onClose={() => settle(request?.kind === 'confirm' ? false : null)}
        title={request ? <>{icon} {request.title}</> : undefined}
      >
        {request && (
          <>
            {'message' in request && request.message && (
              <div className="text-sm text-monastery-text-secondary mb-4 whitespace-pre-wrap">{request.message}</div>
            )}
            {request.kind === 'prompt' && (
              <>
                {request.label && (
                  <label className="block text-xs text-monastery-text-secondary mb-1">{request.label}</label>
                )}
                <input
                  ref={inputRef}
                  autoFocus
                  value={promptValue}
                  onChange={(e) => setPromptValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && promptValue.trim()) settle(promptValue);
                    if (e.key === 'Escape') settle(null);
                  }}
                  placeholder={request.placeholder}
                  className="w-full mb-4 px-3 py-2 bg-monastery-dark-bg border border-monastery-dark-border rounded-lg text-sm text-monastery-text-primary placeholder-monastery-text-muted focus:border-monastery-pine focus:outline-none"
                />
              </>
            )}
            <div className="flex justify-end gap-2">
              {request.kind !== 'notice' && (
                <button
                  onClick={() => settle(request.kind === 'confirm' ? false : null)}
                  className="px-3 py-1.5 text-sm text-monastery-text-secondary hover:text-monastery-text-primary"
                >
                  {(request.kind === 'confirm' && request.cancelLabel) || 'Cancel'}
                </button>
              )}
              <button
                autoFocus={request.kind !== 'prompt'}
                onClick={() => settle(request.kind === 'prompt' ? promptValue : true)}
                disabled={request.kind === 'prompt' && !promptValue.trim()}
                className={`px-3 py-1.5 text-sm text-white rounded-lg disabled:opacity-50 ${
                  request.kind === 'confirm' && request.danger
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-monastery-pine hover:bg-monastery-forest'
                }`}
              >
                {(request.kind === 'notice' ? 'OK' : request.confirmLabel) || (request.kind === 'prompt' ? 'OK' : 'Confirm')}
              </button>
            </div>
          </>
        )}
      </Modal>
    </DialogContext.Provider>
  );
}
