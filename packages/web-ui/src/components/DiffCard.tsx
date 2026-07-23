import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, FilePlus2, FileDiff } from 'lucide-react';
import { FileChange } from '../types';
import { diffLines } from '../lib/diff';

/**
 * Collapsed: one row per changed file with +added/−removed counts.
 * Expanded: a unified line diff (computed lazily on first expand).
 */
export function DiffCard({ change }: { change: FileChange }) {
  const [open, setOpen] = useState(false);
  const isNew = change.before === '';

  // Counts are cheap enough to show collapsed; the hunked render happens in the same pass.
  const diff = useMemo(() => diffLines(change.before, change.after), [change]);

  return (
    <div className="mt-1.5 rounded-lg border border-monastery-dark-border overflow-hidden text-left">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-monastery-dark-bg hover:bg-monastery-dark-tertiary transition-colors"
        title={open ? 'Hide diff' : 'Show diff'}
      >
        {open ? <ChevronDown size={12} className="text-monastery-text-muted shrink-0" /> : <ChevronRight size={12} className="text-monastery-text-muted shrink-0" />}
        {isNew
          ? <FilePlus2 size={12} className="text-green-400 shrink-0" />
          : <FileDiff size={12} className="text-monastery-lantern shrink-0" />}
        <span className="text-xs font-mono text-monastery-text-primary truncate flex-1">{change.path}</span>
        {isNew && <span className="text-[11px] text-green-400 shrink-0">new</span>}
        {diff.added > 0 && <span className="text-[11px] text-green-400 shrink-0">+{diff.added}</span>}
        {diff.removed > 0 && <span className="text-[11px] text-red-400 shrink-0">−{diff.removed}</span>}
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto bg-monastery-dark-bg border-t border-monastery-dark-border p-0 text-[11px] leading-relaxed font-mono">
          <code className="block min-w-max">
            {diff.lines.map((line, i) =>
              line.type === 'skip' ? (
                <span key={i} className="block px-2.5 text-monastery-text-muted select-none">⋯ {line.count} unchanged lines</span>
              ) : (
                <span
                  key={i}
                  className={`block px-2.5 whitespace-pre ${
                    line.type === 'add' ? 'bg-green-400/10 text-green-300'
                    : line.type === 'del' ? 'bg-red-400/10 text-red-300'
                    : 'text-monastery-text-secondary'
                  }`}
                >
                  {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '} {line.text}
                </span>
              )
            )}
            {diff.truncated && (
              <span className="block px-2.5 py-1 text-monastery-text-muted">⋯ diff truncated (large change)</span>
            )}
          </code>
        </pre>
      )}
    </div>
  );
}
