import Editor, { OnMount } from '@monaco-editor/react';
import { useAppStore } from '../store/useAppStore';

interface CodeEditorProps {
  value: string;
  language?: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}

export function CodeEditor({ 
  value, 
  language = 'typescript', 
  onChange,
  readOnly = false 
}: CodeEditorProps) {
  const { theme } = useAppStore();

  const handleEditorMount: OnMount = (editor, monaco) => {
    // Configure editor options
    editor.updateOptions({
      minimap: { enabled: true },
      fontSize: 14,
      lineNumbers: 'on',
      renderWhitespace: 'selection',
      wordWrap: 'on',
      automaticLayout: true,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
    });

    // Define Monastery theme for Monaco
    monaco.editor.defineTheme('monastery-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6E7681' },
        { token: 'string', foreground: 'F4A460' },
        { token: 'keyword', foreground: '1E6B4E', fontStyle: 'bold' },
        { token: 'function', foreground: '5DADE2' },
        { token: 'variable', foreground: 'E6EDF3' },
        { token: 'type', foreground: 'D4C3A3', fontStyle: 'italic' },
      ],
      colors: {
        'editor.background': '#0D1117',
        'editor.foreground': '#E6EDF3',
        'editor.lineHighlightBackground': '#161B22',
        'editorCursor.foreground': '#F4A460',
        'editor.selectionBackground': '#1E6B4E40',
        'editor.inactiveSelectionBackground': '#1E6B4E20',
        'scrollbarSlider.background': '#30363D',
        'scrollbarSlider.hoverBackground': '#6E7681',
      },
    });

    monaco.editor.setTheme(theme === 'monastery-dark' ? 'monastery-dark' : 'vs-light');
  };

  return (
    <div className="h-full w-full">
      <Editor
        height="100%"
        language={language}
        value={value}
        onChange={(newValue) => onChange?.(newValue || '')}
        onMount={handleEditorMount}
        options={{
          readOnly,
          minimap: { enabled: true },
          fontSize: 14,
          lineNumbers: 'on',
          renderWhitespace: 'selection',
          wordWrap: 'on',
          automaticLayout: true,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
        }}
        theme={theme === 'monastery-dark' ? 'monastery-dark' : 'vs-light'}
      />
    </div>
  );
}
