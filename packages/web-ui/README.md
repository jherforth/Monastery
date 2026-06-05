# Monastery Web UI

The frontend interface for **Monastery** - A calm, focused, self-hosted sanctuary for AI-assisted coding.

**Tagline**: "Build in silence. Deploy with purpose."

## Tech Stack

- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS with custom Monastery theme
- **State Management**: Zustand with persistence
- **Code Editor**: Monaco Editor (VS Code's editor)
- **Icons**: Lucide React
- **Resizable Panels**: react-resizable-panels

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

```bash
cd packages/web-ui
npm install
npm run dev
```

The development server will start on `http://localhost:3000` and proxy API requests to the backend at `http://localhost:8080`.

### Build for Production

```bash
npm run build
```

Output will be in the `dist/` directory, ready to be served by the backend or a static host.

## Project Structure

```
packages/web-ui/
├── src/
│   ├── components/       # UI components
│   │   ├── TopBar.tsx        # Persistent top navigation
│   │   ├── Sidebar.tsx       # Collapsible left sidebar
│   │   ├── ChatPane.tsx      # AI chat interface
│   │   ├── CodeEditor.tsx    # Monaco editor wrapper
│   │   └── PreviewPane.tsx   # Preview/terminal output
│   ├── hooks/            # Custom React hooks
│   │   └── index.ts          # Keyboard shortcuts, streaming
│   ├── store/            # State management
│   │   └── useAppStore.ts    # Zustand store
│   ├── types/            # TypeScript definitions
│   │   └── index.ts          # Shared interfaces
│   ├── utils/            # Helper functions
│   ├── App.tsx           # Main application component
│   ├── main.tsx          # Entry point
│   └── index.css         # Global styles & theme
├── public/               # Static assets
├── index.html            # HTML template
├── tailwind.config.js    # Theme configuration
├── vite.config.ts        # Vite configuration
└── package.json
```

## Design System

### Color Palette

The Monastery theme uses a calm, dark-mode-first palette:

- **Forest Green** (`#0A3D2A`): Deep brand color
- **Pine Green** (`#1E6B4E`): Primary actions
- **Lantern Gold** (`#F4A460`): Accents, focus states
- **Dark Background** (`#0D1117`): Main surface
- **Dark Surface** (`#161B22`): Secondary surfaces

See `BRANDING.md` for complete design guidelines.

### Themes

- **Monastery Dark** (default): Optimized for long coding sessions
- **Scriptorium Light**: Warm, parchment-inspired light theme

Toggle themes via settings or `Ctrl/Cmd + Shift + T`.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + K` | Command palette |
| `Ctrl/Cmd + L` | Focus chat input |
| `Ctrl/Cmd + Shift + D` | Self-host wizard |
| `Ctrl/Cmd + Shift + T` | Toggle theme |
| `Escape` | Close modals/focus editor |

## Components

### TopBar
Persistent header with:
- Logo and project switcher
- LLM status indicator
- Resource monitor
- Self-host wizard button
- Settings

### Sidebar
Collapsible navigation with tabs for:
- File explorer
- Chat history
- Agents & tools
- Homelab integrations

### ChatPane
AI conversation interface featuring:
- Streaming responses
- File attachments
- Suggested prompts
- Stop generation button

### CodeEditor
Monaco-based editor with:
- Syntax highlighting for 50+ languages
- Custom Monastery theme
- Inline AI actions (Explain, Refactor, Test)
- Git gutter integration (future)

### PreviewPane
Tabbed output area with:
- Live preview iframe
- Terminal output
- Diff viewer for AI changes

## State Management

Uses Zustand for lightweight, persistent state:

```typescript
import { useAppStore } from './store/useAppStore';

function MyComponent() {
  const { theme, toggleSidebar, currentProject } = useAppStore();
  
  // ... use state and actions
}
```

Persisted preferences:
- Theme selection
- Pane layout sizes
- Sidebar collapsed state
- LLM endpoint configurations

## API Integration

The UI connects to the backend via:

- **REST API**: `/api/*` endpoints for CRUD operations
- **WebSocket**: `/ws` for real-time updates
- **SSE**: For streaming LLM responses

Example streaming hook:

```typescript
import { useStreamingResponse } from './hooks';

function ChatComponent() {
  const handleChunk = (chunk: string) => {
    // Append to message
  };
  
  const handleStream = useStreamingResponse(handleChunk);
  
  // Use with fetch
  const response = await fetch('/api/chat', { method: 'POST' });
  await handleStream(response);
}
```

## Customization

### Adding Custom Themes

1. Define CSS variables in `src/index.css`
2. Add theme selector in settings
3. Update Monaco editor theme mapping

### Extending Components

All components are designed for composition:

```tsx
<ChatPane
  messages={messages}
  onSendMessage={handleSend}
  renderMessage={(msg) => <CustomMessage msg={msg} />}
/>
```

## Accessibility

- WCAG AA contrast compliance
- Full keyboard navigation
- Screen reader friendly
- Reduced motion support
- Focus indicators (Lantern Gold rings)

## Performance

- Code splitting by route
- Lazy component loading
- Virtualized lists for large message histories
- Debounced search inputs
- Efficient re-renders with React.memo

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Desktop-optimized (primary target)

## License

MIT - See LICENSE file

---

*Built with calm intention for the homelab community.*
