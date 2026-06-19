/**
 * SSE (Server-Sent Events) stream parser.
 * Parses a ReadableStream into an async generator of typed events.
 *
 * Usage:
 *   for await (const { eventType, data } of parseSSEStream(reader)) { ... }
 */

export interface SSEEvent {
  eventType: string;
  data: string;
}

export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
    }

    // SSE events are separated by double newlines
    const events = buffer.split('\n\n');
    // The last element may be incomplete — keep it in the buffer
    buffer = events.pop() || '';

    for (const event of events) {
      if (!event.trim()) continue;
      
      const lines = event.split('\n');
      let eventType = '';
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data: ')) {
          const c = line.slice(6);
          if (c !== '[DONE]') dataLines.push(c);
        } else if (line.startsWith('data:')) {
          const c = line.slice(5);
          if (c !== '[DONE]') dataLines.push(c.startsWith(' ') ? c.slice(1) : c);
        }
      }

      if (dataLines.length > 0) {
        yield { eventType, data: dataLines.join('\n') };
      }
    }

    if (done) {
      // Flush any remaining data in the buffer (final incomplete event)
      if (buffer.trim()) {
        const lines = buffer.split('\n');
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const c = line.slice(6);
            if (c !== '[DONE]') dataLines.push(c);
          } else if (line.startsWith('data:')) {
            const c = line.slice(5);
            if (c !== '[DONE]') dataLines.push(c.startsWith(' ') ? c.slice(1) : c);
          }
        }
        if (dataLines.length > 0) {
          yield { eventType: '', data: dataLines.join('\n') };
        }
      }
      break;
    }
  }
}
