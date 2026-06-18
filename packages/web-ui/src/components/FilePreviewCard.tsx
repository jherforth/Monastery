import { Copy, Check } from 'lucide-react';

interface PreviewFile {
  name: string;
  content: string;
  language: string;
}

interface FilePreviewCardProps {
  file: PreviewFile;
  copiedFile: string | null;
  onCopy: (content: string, id: string) => void;
}

export function FilePreviewCard({ file, copiedFile, onCopy }: FilePreviewCardProps) {
  return (
    <div className="rounded-lg border border-monastery-dark-border overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-monastery-dark-tertiary border-b border-monastery-dark-border">
        <span className="text-xs font-medium text-monastery-text-primary">{file.name}</span>
        <button
          onClick={() => onCopy(file.content, file.name)}
          className="flex items-center gap-1 text-xs text-monastery-text-muted hover:text-monastery-text-primary transition-colors"
        >
          {copiedFile === file.name ? (
            <><Check size={12} className="text-green-400" /> Copied</>
          ) : (
            <><Copy size={12} /> Copy</>
          )}
        </button>
      </div>
      <pre className="p-3 text-xs text-monastery-text-secondary font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre">
        {file.content}
      </pre>
    </div>
  );
}
