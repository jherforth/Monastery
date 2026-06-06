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
          // Deep blues (dark mode)
          'dark-bg': '#0A1628',
          'dark-surface': '#0F1D32',
          'dark-border': '#1A2D4A',
          'dark-tertiary': '#162744',
          // Forest green (brand accents)
          'forest': '#0A3D2A',
          'pine': '#1E6B4E',
          // Warm neutrals
          'parchment': '#F5F0E8',
          'sand': '#D4C3A3',
          // Accent lighting
          'lantern': '#F4A460',
          'amber': '#FFBF00',
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
