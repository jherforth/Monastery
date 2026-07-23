import { useState, useCallback } from 'react';

export interface EditorTab {
  path: string;
  content: string;
  isDirty: boolean;
}

// Binary image formats get an image viewer instead of Monaco (SVG stays editable text).
export const isImagePath = (p: string) =>
  ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif'].includes(p.split('.').pop()?.toLowerCase() || '');

/** Multi-tab editor state: which files are open, which is active, and their buffers. */
export function useEditorTabs(projectId: string | undefined) {
  const [openTabs, setOpenTabs] = useState<EditorTab[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const activeTab = openTabs[activeTabIndex] as EditorTab | undefined;
  const currentFile = activeTab?.path || '';
  const editorContent = activeTab?.content || '// Select a file to edit';

  /** Close all tabs (project switch, snapshot restore, git pull). */
  const resetTabs = useCallback(() => {
    setOpenTabs([]);
    setActiveTabIndex(0);
  }, []);

  const openFileInTab = useCallback(async (path: string) => {
    // Check if already open
    const existingIdx = openTabs.findIndex(t => t.path === path);
    if (existingIdx >= 0) {
      setActiveTabIndex(existingIdx);
      return;
    }
    // Images: no text content to fetch (binary on disk) — the tab renders an <img> viewer.
    if (isImagePath(path)) {
      setOpenTabs(prev => {
        const updated = [...prev, { path, content: '', isDirty: false }];
        setActiveTabIndex(updated.length - 1);
        return updated;
      });
      return;
    }
    // Fetch file content and add as new tab
    let content = `// ${path}`;
    try {
      const res = await fetch(`/api/projects/${projectId}/files/read?path=${encodeURIComponent(path)}`);
      const data = res.ok ? await res.json() : null;
      if (data?.content) content = data.content;
    } catch {
      // fall through with the placeholder content
    }
    setOpenTabs(prev => {
      const updated = [...prev, { path, content, isDirty: false }];
      setActiveTabIndex(updated.length - 1);
      return updated;
    });
  }, [projectId, openTabs]);

  const closeTab = useCallback((index: number) => {
    setOpenTabs(prev => {
      const updated = prev.filter((_, i) => i !== index);
      if (activeTabIndex >= updated.length) {
        setActiveTabIndex(Math.max(0, updated.length - 1));
      } else if (index < activeTabIndex) {
        setActiveTabIndex(prev => prev - 1);
      }
      return updated;
    });
  }, [activeTabIndex]);

  /** User typed in the editor — update the active tab's buffer and mark it dirty. */
  const updateTabContent = useCallback((content: string) => {
    setOpenTabs(prev => prev.map((t, i) =>
      i === activeTabIndex ? { ...t, content, isDirty: true } : t
    ));
  }, [activeTabIndex]);

  const markTabSaved = useCallback(() => {
    setOpenTabs(prev => prev.map((t, i) =>
      i === activeTabIndex ? { ...t, isDirty: false } : t
    ));
  }, [activeTabIndex]);

  /** Replace a tab's buffer with fresh on-disk content (after AI edits, restores, etc.). */
  const updateTabContentByPath = useCallback((path: string, content: string) => {
    setOpenTabs(prev => prev.map(t =>
      t.path === path ? { ...t, content, isDirty: false } : t
    ));
  }, []);

  return {
    openTabs,
    setOpenTabs,
    activeTabIndex,
    setActiveTabIndex,
    activeTab,
    currentFile,
    editorContent,
    resetTabs,
    openFileInTab,
    closeTab,
    updateTabContent,
    markTabSaved,
    updateTabContentByPath,
  };
}
