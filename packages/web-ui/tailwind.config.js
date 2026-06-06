/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        monastery: {
          // Theme-dependent (uses CSS variables — switches with data-theme)
          'dark-bg': 'var(--bg-primary)',
          'dark-surface': 'var(--bg-secondary)',
          'dark-tertiary': 'var(--bg-tertiary)',
          'dark-border': 'var(--border-color)',
          'text-primary': 'var(--text-primary)',
          'text-secondary': 'var(--text-secondary)',
          'text-muted': 'var(--text-muted)',
          // Brand colors (static — same in both themes)
          'forest': '#0A3D2A',
          'pine': '#1E6B4E',
          'parchment': '#F5F0E8',
          'sand': '#D4C3A3',
          'lantern': '#F4A460',
          'amber': '#FFBF00',
          // Status
          'status-success': 'var(--status-success)',
          'status-warning': 'var(--status-warning)',
          'status-error': 'var(--status-error)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-in': 'slideIn 0.3s ease-out',
        'pulse-soft': 'pulseSoft 2s infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideIn: {
          '0%': { transform: 'translateX(-10px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
      },
    },
  },
  plugins: [],
}
