import { ReactNode } from 'react';

type Variant = 'success' | 'warning' | 'error' | 'muted';

const STYLES: Record<Variant, string> = {
  success: 'bg-green-400/10 text-green-400',
  warning: 'bg-amber-400/10 text-amber-400',
  error: 'bg-red-400/10 text-red-400',
  muted: 'bg-monastery-dark-tertiary text-monastery-text-muted',
};

/** One vocabulary for connection/health status instead of ad-hoc emoji and color spans. */
export function StatusBadge({ variant, children }: { variant: Variant; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${STYLES[variant]}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
