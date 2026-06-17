# Monastery Branding Guide

## Product Identity

**Name**: Monastery  
**Tagline**: "AI's self-hosted sanctuary for coding."

### Brand Essence
Monastery represents a calm, focused sanctuary for AI-assisted coding. It's where developers retreat from the noise of modern tooling to enter a state of deep flow. The brand evokes:
- **Tranquility**: A peaceful environment free from distractions
- **Craftsmanship**: Thoughtful, deliberate creation
- **Self-reliance**: Full control over your development environment
- **Wisdom**: Ancient scribe traditions meets cutting-edge AI

---

## Visual Identity

### Logo Concept
The Monastery logo should evoke monastic architecture and scribe traditions:

**Primary Mark**: A simplified archway (representing monastery architecture) with a subtle lantern hanging within it. The arch suggests both entry into a sacred space and the bridge between human intention and AI capability.

**Alternative Marks**:
- A quill pen forming an abstract node/network pattern
- An open book with code brackets as pages
- A minimalist lantern icon (used for loading states)

**Logo Usage**:
- Primary: White/light gray on dark backgrounds
- Accent: Lantern gold (#F4A460) for highlights
- Minimum size: 24px height for clarity

### Color Palette

#### Primary Colors (Dark Mode - Default)
```
Forest Green    #0A3D2A  -- Deep, grounding base
Pine Green      #1E6B4E  -- Primary action color
Dark Background #0D1117  -- Main UI surface
Dark Surface    #161B22  -- Secondary surfaces
Dark Border     #30363D  -- Dividers and strokes
```

#### Neutral Colors
```
Parchment       #F5F0E8  -- Light mode background
Sand            #D4C3A3  -- Light mode accents
Lantern Gold    #F4A460  -- Primary accent, focus states
Amber           #FFBF00  -- Highlights, warnings
```

#### Status Colors
```
Success         #2EA043  -- Connected, complete
Warning         #D29922  -- Loading, caution
Error           #F85149  -- Disconnected, failed
```

#### Text Colors
```
Primary         #E6EDF3  -- Main text
Secondary       #8B949E  -- Supporting text
Muted           #6E7681  -- Placeholder, disabled
```

### Typography

#### Primary Font: Inter
- Weights: 400 (Regular), 500 (Medium), 600 (SemiBold), 700 (Bold)
- Usage: All UI text, buttons, labels, headings
- Rationale: Clean, readable, professional, excellent screen rendering

#### Code Font: JetBrains Mono
- Weights: 400 (Regular), 500 (Medium)
- Usage: Code editor, terminal output, file paths, technical content
- Rationale: Developer favorite, excellent ligatures, highly readable

#### Fallbacks
- Sans-serif: `system-ui, -apple-system, sans-serif`
- Monospace: `'Fira Code', 'Consolas', monospace`

---

## Iconography

### Style Principles
- **Minimal**: Single-weight strokes, no fills
- **Geometric**: Based on simple shapes (circles, squares, triangles)
- **Consistent**: 2px stroke weight, rounded caps
- **Meaningful**: Each icon should clearly represent its function

### Icon Library
Primary: **Lucide Icons** (https://lucide.dev)
- Consistent design language
- Well-maintained, React-friendly
- Matches our minimal aesthetic

### Custom Icons
For unique Monastery symbols (logo, special features):
- Use simple SVG paths
- Maintain 24x24 grid system
- Export in multiple sizes: 16, 24, 32, 48px

---

## UI Components & Patterns

### Layout Philosophy
1. **Generous Whitespace**: Elements breathe; no clutter
2. **Clear Hierarchy**: Size, color, and position guide the eye
3. **Subtle Depth**: Minimal shadows, rely on color contrast
4. **Smooth Transitions**: 150-300ms ease-in-out animations

### Component Styles

#### Buttons
- **Primary**: Pine green background, white text, rounded-lg
- **Secondary**: Dark surface background, border, hover lift
- **Ghost**: Transparent, hover background only
- Sizes: sm (py-1 px-2), md (py-2 px-4), lg (py-3 px-6)

#### Cards/Panels
- Background: Dark surface (#161B22)
- Border: 1px solid dark border (#30363D)
- Radius: rounded-lg (8px)
- Padding: p-4 minimum

#### Inputs
- Background: Dark surface
- Border: Dark border, focuses to Pine green
- Radius: rounded-xl (12px) for modern feel
- Placeholder: Muted text color

#### Badges/Status Indicators
- Small pills with dot indicator
- Success: Green dot + text
- Warning: Amber dot + text
- Error: Red dot + text

### Animations

#### Timing Functions
- Fast: 150ms cubic-bezier(0.4, 0, 0.2, 1)
- Normal: 200ms ease-in-out
- Slow: 300ms ease-out

#### Common Animations
- **Fade In**: Opacity 0 → 1
- **Slide In**: TranslateX(-10px) + opacity 0 → origin
- **Pulse Soft**: Opacity 1 → 0.7 → 1 (for loading)
- **Hover Lift**: TranslateY(-2px) + shadow increase

---

## Theme System

### Monastery Dark (Default)
The primary theme optimized for long coding sessions:
- Deep greens and dark grays
- Low eye strain
- Lantern gold accents for focus

### Scriptorium Light
Alternative light theme inspired by ancient manuscripts:
- Warm parchment backgrounds
- High contrast for bright environments
- Same pine green for actions (continuity)

### Implementation
CSS custom properties enable instant theme switching:
```css
[data-theme="monastery-dark"] { ... }
[data-theme="scriptorium-light"] { ... }
```

---

## Voice & Tone

### Writing Principles
1. **Calm**: Never urgent or alarming
2. **Clear**: Direct, no jargon without explanation
3. **Concise**: Respect user's time and attention
4. **Confident**: Assume competence, offer guidance

### Examples

**Onboarding**
- ✓ "Welcome to Monastery. Your sanctuary for AI-assisted coding."
- ✗ "Hey! Let's get you set up real quick!"

**Error Messages**
- ✓ "Connection lost. Reconnecting..."
- ✗ "ERROR: Connection failed!!!"

**Loading States**
- ✓ "Preparing your environment..."
- ✗ "Please wait..."

**Success Messages**
- ✓ "Deployment complete. Your app is live."
- ✗ "SUCCESS!!! Everything worked!"

---

## Accessibility

### Requirements
- **Contrast**: WCAG AA minimum (4.5:1 for text)
- **Focus**: Visible focus rings on all interactive elements
- **Keyboard**: Full navigation without mouse
- **Screen Readers**: Semantic HTML, ARIA labels where needed

### Implementation
- Focus ring: 2px solid Lantern Gold with 2px offset
- Skip links for keyboard users
- Proper heading hierarchy (h1 → h2 → h3)
- Alt text for all meaningful images
- Reduced motion option respects user preferences

---

## File Structure
```
packages/web-ui/
├── src/
│   ├── components/     # Reusable UI components
│   ├── hooks/          # Custom React hooks
│   ├── store/          # State management (Zustand)
│   ├── types/          # TypeScript interfaces
│   ├── utils/          # Helper functions
│   ├── assets/         # Logos, icons, images
│   └── styles/         # Global styles, themes
├── public/
│   ├── logo.svg        # Primary logo
│   └── favicon.ico     # Browser icon
└── tailwind.config.js  # Theme configuration
```

---

## Brand Applications

### In-Product
- Logo in top-left corner (always visible)
- Lantern icon for loading states
- Pine green for primary actions
- Consistent spacing and typography

### Documentation
- Same color palette
- Inter for body text, JetBrains Mono for code
- Screenshots use dark theme by default

### Marketing (Future)
- Website: Showcase the calm, focused experience
- Social: Minimal graphics, focus on product shots
- Messaging: Emphasize self-hosting, privacy, flow state

---

## Inspiration References

### Design Inspirations
- **Linear**: Clean, fast, professional
- **Arc Browser**: Modern, thoughtful details
- **VS Code**: Functional, developer-first
- **Notion**: Calm, distraction-free

### Non-Tech Inspirations
- Medieval manuscript margins (generous whitespace)
- Japanese tea ceremony (intentional, calm)
- Monastic architecture (simple, enduring)
- Library reading rooms (quiet focus)

---

*Last updated: 2026*  
*"AI's self-hosted sanctuary for coding."*
