import { X } from 'lucide-react';
import { CodeEditor } from './CodeEditor';
import { EditorTab, isImagePath } from '../hooks/useEditorTabs';

interface EditorPaneProps {
  projectId?: string;
  tabs: EditorTab[];
  activeTabIndex: number;
  currentFile: string;
  editorContent: string;
  onSelectTab: (index: number) => void;
  onCloseTab: (index: number) => void;
  onChange: (content: string) => void;
  onSave: () => void;
  /** Editor-toolbar agent actions on the active file. */
  onExplain: () => void;
  onRefactor: () => void;
  onAddTests: () => void;
}

/** The code editor pane: tab bar, toolbar (agent actions + save), and Monaco / image viewer. */
export function EditorPane({
  projectId,
  tabs,
  activeTabIndex,
  currentFile,
  editorContent,
  onSelectTab,
  onCloseTab,
  onChange,
  onSave,
  onExplain,
  onRefactor,
  onAddTests,
}: EditorPaneProps) {
  return (
    <div className="h-full bg-monastery-dark-surface flex flex-col animate-slideInRight rounded-xl overflow-hidden">
      {/* Tab Bar — tabs separate themselves by background, not ruled lines */}
      {tabs.length > 0 && (
        <div className="flex items-center bg-monastery-dark-bg overflow-x-auto shrink-0">
          {tabs.map((tab, i) => (
            <div
              key={tab.path}
              onClick={() => onSelectTab(i)}
              className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer transition-colors shrink-0 ${
                i === activeTabIndex
                  ? 'bg-monastery-dark-surface text-monastery-text-primary border-t-2 border-t-monastery-lantern'
                  : 'text-monastery-text-secondary hover:bg-monastery-dark-surface hover:text-monastery-text-primary'
              }`}
            >
              <span className="max-w-[120px] truncate">{tab.path.split('/').pop()}</span>
              {tab.isDirty && (
                <span className="w-1.5 h-1.5 rounded-full bg-monastery-lantern" title="Unsaved changes" />
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onCloseTab(i); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-monastery-dark-tertiary rounded transition-all"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Editor Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
        <span className="text-xs text-monastery-text-muted truncate">
          {currentFile || 'No file selected'}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={onExplain}
            disabled={!currentFile}
            className="px-2 py-0.5 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors text-monastery-text-secondary disabled:opacity-40"
          >
            Explain
          </button>
          <button
            onClick={onRefactor}
            disabled={!currentFile}
            className="px-2 py-0.5 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors text-monastery-text-secondary disabled:opacity-40"
          >
            Refactor
          </button>
          <button
            onClick={onAddTests}
            disabled={!currentFile}
            className="px-2 py-0.5 text-xs hover:bg-monastery-dark-tertiary rounded transition-colors text-monastery-text-secondary disabled:opacity-40"
          >
            Add Tests
          </button>
          {currentFile && !isImagePath(currentFile) && (
            <button
              onClick={onSave}
              className="px-3 py-0.5 text-xs bg-monastery-pine hover:bg-monastery-forest text-white rounded transition-colors font-medium"
            >
              Save
            </button>
          )}
        </div>
      </div>

      {/* Editor — image files get a viewer (served via the preview route, which also
          self-heals legacy data-URL uploads); everything else gets Monaco. */}
      <div className="flex-1 overflow-hidden">
        {currentFile && isImagePath(currentFile) && projectId ? (
          <div className="h-full w-full flex items-center justify-center bg-monastery-dark-bg overflow-auto p-4">
            <img
              src={`/api/projects/${projectId}/preview/${currentFile}`}
              alt={currentFile}
              className="max-w-full max-h-full object-contain rounded border border-monastery-dark-border bg-white/5"
            />
          </div>
        ) : (
          <CodeEditor
            value={editorContent}
            language={currentFile?.endsWith('.tsx') || currentFile?.endsWith('.ts') ? 'typescript' : 'javascript'}
            onChange={onChange}
          />
        )}
      </div>
    </div>
  );
}
