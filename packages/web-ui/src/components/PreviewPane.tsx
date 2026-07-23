import { useState, useEffect } from 'react';
import { Eye, RefreshCw } from 'lucide-react';

interface PreviewPaneProps {
  projectId?: string | null;
}

// Live preview of the project's index.html. (Terminal and diff views were removed —
// they were static placeholders; real ones can return as features when they exist.)
export function PreviewPane({ projectId }: PreviewPaneProps) {
  const [previewUrl, setPreviewUrl] = useState('about:blank');
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    if (projectId) {
      setPreviewUrl(`/api/projects/${projectId}/preview/index.html`);
    } else {
      setPreviewUrl('about:blank');
    }
  }, [projectId]);

  return (
    <div className="h-full flex flex-col bg-monastery-dark-bg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-monastery-dark-border bg-monastery-dark-surface">
        <div className="flex items-center gap-2">
          <Eye size={14} className="text-monastery-text-secondary" />
          <span className="text-xs font-medium text-monastery-text-secondary">
            {projectId ? 'Live Preview' : 'Preview (no project)'}
          </span>
        </div>
        <button
          onClick={() => setPreviewKey(k => k + 1)}
          className="p-1.5 hover:bg-monastery-dark-tertiary rounded transition-colors"
          title="Refresh preview"
        >
          <RefreshCw size={14} className="text-monastery-lantern" />
        </button>
      </div>
      <iframe
        key={previewKey}
        src={previewUrl}
        className="flex-1 w-full bg-white"
        title="Preview"
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}
