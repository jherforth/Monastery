import { useCallback, useEffect } from 'react';

export * from './useSnapshots';
export * from './useEndpoints';

export function useKeyboardShortcuts(
  shortcuts: Record<string, (e: KeyboardEvent) => void>
) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = [
        e.ctrlKey ? 'Ctrl' : '',
        e.metaKey ? 'Cmd' : '',
        e.shiftKey ? 'Shift' : '',
        e.altKey ? 'Alt' : '',
        e.key.toUpperCase(),
      ]
        .filter(Boolean)
        .join('+');

      if (shortcuts[key]) {
        e.preventDefault();
        shortcuts[key](e);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts]);
}

export function useStreamingResponse(
  onChunk: (chunk: string) => void,
  onComplete?: () => void
) {
  const handleStream = useCallback(
    async (response: Response) => {
      const reader = response.body?.getReader();
      if (!reader) return;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = new TextDecoder().decode(value);
          onChunk(chunk);
        }
        onComplete?.();
      } catch (error) {
        console.error('Stream error:', error);
      }
    },
    [onChunk, onComplete]
  );

  return handleStream;
}

export function useDebounce<T>(value: T, delay: number): T {
  const debouncedValue = value;

  useEffect(() => {
    const handler = setTimeout(() => {
      // In a real implementation, we'd update state here
    }, delay);

    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}
