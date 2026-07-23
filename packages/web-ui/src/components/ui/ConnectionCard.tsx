import { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

export interface ConnectionAction {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  title?: string;
}

interface ConnectionCardProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  badges?: ReactNode;
  /** Result banner from a validate/test action. */
  testResult?: { ok: boolean; message: string } | null;
  actions: ConnectionAction[];
}

/**
 * The one card for a configured connection (LLM endpoint, Hermes, git forge, hosting service):
 * icon + name + url, status badges, a test-result line, and a consistent text-button action row.
 */
export function ConnectionCard({ icon, title, subtitle, badges, testResult, actions }: ConnectionCardProps) {
  return (
    <div className="p-3 rounded-lg bg-monastery-dark-bg border border-monastery-dark-border">
      <div className="flex items-center gap-3">
        <span className="shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-monastery-text-primary truncate">{title}</span>
            {badges}
          </div>
          {subtitle && <div className="text-xs text-monastery-text-muted truncate">{subtitle}</div>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {actions.map(a => (
            <button
              key={a.label}
              onClick={a.onClick}
              disabled={a.busy}
              title={a.title || a.label}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors disabled:opacity-50 ${
                a.danger
                  ? 'text-monastery-text-secondary hover:text-red-400 hover:bg-red-500/10'
                  : 'text-monastery-text-secondary hover:text-monastery-text-primary hover:bg-monastery-dark-tertiary'
              }`}
            >
              {a.busy ? <Loader2 size={12} className="animate-spin" /> : a.icon}
              {a.label}
            </button>
          ))}
        </div>
      </div>
      {testResult && (
        <div className={`mt-2 text-xs px-2 py-1 rounded ${
          testResult.ok ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'
        }`}>
          {testResult.message}
        </div>
      )}
    </div>
  );
}
