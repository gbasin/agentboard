/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        surface: 'var(--surface)',
        surfaceStrong: 'var(--surface-strong)',
        accent: 'var(--accent)',
        accentSoft: 'var(--accent-soft)',
        approval: 'var(--approval)',
        waiting: 'var(--waiting)',
        working: 'var(--working)',
        idle: 'var(--idle)',
        danger: 'var(--danger)',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(255,255,255,0.2), 0 10px 30px rgba(15, 23, 42, 0.15)',
      },
      keyframes: {
        rise: {
          '0%': { opacity: 0, transform: 'translateY(12px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        pulseSoft: {
          '0%, 100%': { transform: 'scale(1)', opacity: 0.9 },
          '50%': { transform: 'scale(1.03)', opacity: 1 },
        },
      },
      animation: {
        rise: 'rise 0.5s ease-out both',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
