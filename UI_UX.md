# UI/UX Design - Monastery

## Product Name & Brand
**Monastery** — A calm, focused, self-hosted sanctuary for AI-assisted coding.

**Tagline**: "Build in silence. Deploy with purpose."

**Visual Identity**
- Color palette: Deep greens (#0A3D2A, #1E6B4E), warm neutrals (#F5F0E8, #D4C3A3), dark mode dominant with subtle accent lighting (soft gold/amber highlights).
- Typography: Clean sans-serif (Inter or system-ui) for UI, monospace (JetBrains Mono) for code.
- Iconography: Minimal, inspired by monastic symbols — simple arches, quills, lanterns, or abstract node/network motifs. Use Lucide or custom SVG icons.
- Overall aesthetic: Sleek, modern, calm, spacious. Think Linear + Arc + VS Code, but with a contemplative, premium homelab feel. No clutter, generous whitespace, subtle animations.

## Core Philosophy
- **Focus First**: Reduce cognitive load so users stay in flow state.
- **Progressive Disclosure**: Novice-friendly defaults with power-user tools one click away.
- **Homelab Native**: Surface local network status, resource usage, and self-hosting tools prominently but non-intrusively.
- **Consistency**: Every screen follows the same layout language.

## Layout & Structure (Main Interface)

### Top Bar (Persistent)
- Left: Monastery logo + project name (click to open project switcher)
- Center: Model selector (current endpoint + model, status indicator: green/yellow/red for LLM health)
- Right: 
  - Self-Host Wizard button (prominent)
  - Git status
  - User settings (themes, shortcuts, LLM endpoints)
  - Resource monitor (CPU/GPU/RAM of harness + connected LLM)

### Left Sidebar (Collapsible)
- File explorer (virtual FS with sync indicators)
- Chat history / Sessions
- Agents & Tools library
- Homelab Integrations (Proxmox, Coolify, MQTT, etc.)

### Main Area (Resizable Panes)
Three-column default layout (fully draggable/resizable):
1. **Prompt / Chat Pane** (left or bottom, toggleable)
   - Large textarea with rich prompt input (attachments, @mentions for files/tools)
   - Streaming response with markdown, code blocks, and inline "Apply" buttons
   - Suggested follow-up prompts

2. **Code Editor** (center, Monaco-based)
   - Full-featured with syntax highlighting, git gutter, multi-file tabs
   - Inline AI actions (Explain, Refactor, Fix, Add tests, etc.)
   - Diff view when AI proposes changes

3. **Preview / Terminal / Output** (right)
   - Live preview iframe (for web apps)
   - Terminal pane (for running generated code)
   - Console/output logs
   - Toggle between preview, terminal, and visual diff

**Keyboard Shortcuts** (VS Code inspired + custom):
- `Ctrl/Cmd + K` → Quick command palette
- `Ctrl/Cmd + L` → Focus LLM prompt
- `Ctrl/Cmd + Shift + D` → Deploy / Open Self-Host Wizard

## Key Screens & Flows

### 1. Onboarding / Home Screen
- Clean welcome with "New Project" and "Open Recent"
- Quick-start templates optimized for homelab (Next.js + PocketBase, Rust Axum + SQLite, Python FastAPI, etc.)
- "Connect your LLM" prominent card with auto-discovery

### 2. Self-Hosting Wizard (Core Differentiator)
- Stepper interface with clear progress
- Steps:
  1. Stack Detection
  2. Target Environment (Coolify, Proxmox, Bare Docker, VPS)
  3. Configuration (domain, ports, LLM connection details)
  4. Review generated files (docker-compose.yml, .env, scripts)
  5. One-click actions or copy-paste instructions
- Visual summary cards with resource/cost estimates
- Troubleshooting expander with AI chat

### 3. Settings / Configuration
- LLM Endpoints manager (add, test connection, reorder priority)
- Appearance (themes, including "Monastery Dark", "Scriptorium Light")
- Homelab connections (Proxmox API, Coolify, etc.)
- Sandbox & Security options

### 4. Project Dashboard
- Overview metrics: Files changed, tokens used this session, deployment status
- AI Insights panel (suggested improvements, security scan summary, etc.)

## Interaction Details
- **Streaming Responses**: Smooth typewriter effect with "Stop" button
- **AI Suggestions**: Ghost text in editor, floating action buttons
- **Feedback Loops**: Thumbs up/down on responses → improves future context
- **Mobile/Tablet**: Responsive but primarily desktop-optimized (homelab use)
- **Accessibility**: High contrast, keyboard navigation, screen reader friendly
- **Animations**: Subtle — fade-ins, smooth pane resizing, loading lanterns

## Technical UI Notes (for Leptos/Dioxus)
- Use Tailwind or a lightweight CSS framework
- State management: Signals + server functions (Rust-native)
- Offline resilience: Local storage + sync when backend reconnects
- Theme system with CSS variables for easy customization

## Success Criteria
- A non-technical homelab user can go from zero to first deployed app in <15 minutes
- Power users feel the interface disappears (pure flow)
- Visually distinct and memorable while remaining professional
- Matches or exceeds bolt.diy polish while feeling calmer and more intentional

---

This document gives frontier models (and your future self) a clear, cohesive vision for Monastery's interface.

Would you like me to:
- Add wireframe descriptions or ASCII mockups?
- Create a separate `BRANDING.md` with logo ideas?
- Update any previous docs to reference "Monastery"?
- Generate a sample Tailwind/Leptos component structure?

Just say the word and we’ll keep building the design docs.
