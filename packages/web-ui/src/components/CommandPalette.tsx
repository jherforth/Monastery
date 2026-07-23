import { useState, useEffect, useMemo, useRef } from 'react';
import { Search, FileCode, CornerDownLeft } from 'lucide-react';

/** An entry in the command palette. New features land here first — it costs no chrome. */
export interface CommandItem {
  id: string;
  label: string;
  /** Group header shown in the list (e.g. "Layout", "Sessions", "Ship"). */
  section: string;
  /** Extra text shown dimmed after the label (e.g. a shortcut or detail). */
  hint?: string;
  /** Extra match text for filtering beyond the label. */
  keywords?: string;
  run: () => void;
}

interface CommandPaletteProps {
  commands: CommandItem[];
  /** Project file paths — matched once the query has 2+ characters. */
  files?: string[];
  onOpenFile?: (path: string) => void;
}

const MAX_FILE_RESULTS = 15;

/**
 * Ctrl+K command palette: every app action is reachable by keyboard, and new actions get a
 * home without adding another button somewhere.
 */
export function CommandPalette({ commands, files = [], onOpenFile }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Global shortcut: Ctrl/Cmd+K toggles the palette. Capture phase so it wins even when
  // focus is inside Monaco (which treats Ctrl+K as a chord leader and swallows it).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(o => !o);
        setQuery('');
        setSelected(0);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const q = query.trim().toLowerCase();

  const matches = useMemo(() => {
    const cmdMatches = commands.filter(c =>
      !q || c.label.toLowerCase().includes(q) || c.section.toLowerCase().includes(q) || c.keywords?.toLowerCase().includes(q)
    ).map(c => ({ kind: 'command' as const, item: c }));
    const fileMatches = (q.length >= 2 && onOpenFile)
      ? files
          .filter(f => f.toLowerCase().includes(q))
          .slice(0, MAX_FILE_RESULTS)
          .map(f => ({ kind: 'file' as const, path: f }))
      : [];
    return [...cmdMatches, ...fileMatches];
  }, [commands, files, q, onOpenFile]);

  // Keep the selection in range as the filter changes.
  useEffect(() => {
    if (selected >= matches.length) setSelected(0);
  }, [matches.length, selected]);

  // Keep the selected row visible while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const close = () => { setOpen(false); setQuery(''); setSelected(0); };

  const runSelected = (index: number) => {
    const m = matches[index];
    if (!m) return;
    close();
    if (m.kind === 'command') m.item.run();
    else onOpenFile?.(m.path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // stopPropagation so Escape only dismisses the palette — Settings and the drawers
    // listen for Escape on window and would otherwise close underneath it too.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); runSelected(selected); }
  };

  // Group flat matches by section for headers, preserving order.
  let lastSection: string | null = null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-[15vh] p-4" onClick={close}>
      <div
        className="w-full max-w-lg bg-monastery-dark-surface border border-monastery-dark-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-monastery-dark-border">
          <Search size={16} className="text-monastery-text-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={onKeyDown}
            placeholder="Type a command or file name…"
            className="flex-1 bg-transparent text-sm text-monastery-text-primary placeholder-monastery-text-muted focus:outline-none"
          />
          <kbd className="text-[10px] text-monastery-text-muted border border-monastery-dark-border rounded px-1">Esc</kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {matches.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-monastery-text-muted">No matches.</p>
          )}
          {matches.map((m, i) => {
            const section = m.kind === 'command' ? m.item.section : 'Files';
            const header = section !== lastSection ? section : null;
            lastSection = section;
            return (
              <div key={m.kind === 'command' ? m.item.id : `file-${m.path}`}>
                {header && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-monastery-text-muted">
                    {header}
                  </div>
                )}
                <button
                  data-selected={i === selected || undefined}
                  onClick={() => runSelected(i)}
                  onMouseEnter={() => setSelected(i)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                    i === selected
                      ? 'bg-monastery-dark-tertiary text-monastery-text-primary'
                      : 'text-monastery-text-secondary'
                  }`}
                >
                  {m.kind === 'file' && <FileCode size={13} className="text-monastery-text-muted shrink-0" />}
                  <span className="flex-1 truncate">{m.kind === 'command' ? m.item.label : m.path}</span>
                  {m.kind === 'command' && m.item.hint && (
                    <span className="text-[10px] text-monastery-text-muted shrink-0">{m.item.hint}</span>
                  )}
                  {i === selected && <CornerDownLeft size={12} className="text-monastery-text-muted shrink-0" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
