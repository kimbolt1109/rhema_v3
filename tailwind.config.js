/**
 * Verger "booth" theme.
 *
 * ERGO-1: there is NO light mode. Not a preference — an ergonomic requirement for a
 * live-production booth (dark room, next to a lit stage). `darkMode: 'class'` is kept
 * only so the `dark:` variant compiles; `<html>` carries `class="dark"` permanently and
 * there is no runtime toggle anywhere.
 *
 * Colours are `rgb(var(--color-x) / <alpha-value>)` wrappers over CSS custom properties
 * declared once on `:root, .dark` in the renderer stylesheet (raw RGB channel triples,
 * no `rgb()` wrapper, so Tailwind's `/opacity` modifier works). Tokens are named ONCE
 * and correctly — v2's `sky` / `electric` / `glass-fill` / `ui-*` colour aliases were
 * rebrand debt and are deliberately not recreated here.
 *
 * Surfaces are flat and solid. No backdrop blur, anywhere.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  darkMode: 'class',
  content: [
    './src/renderer/index.html',
    './src/renderer/**/*.{ts,tsx,html}'
  ],
  theme: {
    extend: {
      colors: {
        background: 'rgb(var(--color-bg) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--color-surface-2) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          hover: 'rgb(var(--color-accent-hover) / <alpha-value>)'
        },
        'accent-2': 'rgb(var(--color-accent-2) / <alpha-value>)',
        panic: 'rgb(var(--color-panic) / <alpha-value>)',
        live: 'rgb(var(--color-live) / <alpha-value>)',
        text: {
          DEFAULT: 'rgb(var(--color-text) / <alpha-value>)',
          muted: 'rgb(var(--color-text-muted) / <alpha-value>)'
        },
        border: 'rgb(var(--color-border) / <alpha-value>)',
        ring: 'rgb(var(--color-ring) / <alpha-value>)'
      },

      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['ui-monospace', '"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'monospace']
      },

      borderRadius: {
        glass: '0.875rem',
        'glass-md': '1rem',
        'glass-lg': '1.125rem'
      },

      boxShadow: {
        glass: '0 1px 2px 0 rgba(0,0,0,0.20), inset 0 1px 0 0 rgba(255,255,255,0.04)',
        glow: '0 4px 16px rgba(99,102,241,0.28)',
        float: '0 4px 16px rgba(0,0,0,0.18)',
        'inner-highlight': 'inset 0 1px 0 0 rgba(255,255,255,0.10)',
        'float-dark': '0 8px 32px 0 rgba(0,0,0,0.40), 0 2px 8px 0 rgba(0,0,0,0.20)'
      },

      /**
       * Booth touch targets. An operator hits these in the dark, often one-handed,
       * sometimes on a touchscreen. 44px is the floor (WCAG 2.2 target size), 56px is
       * the comfortable default for primary controls, 72px is for GO LIVE / PANIC-class
       * actions that must be unmissable at a glance.
       */
      spacing: {
        touch: '2.75rem', // 44px
        'touch-lg': '3.5rem', // 56px
        'touch-xl': '4.5rem' // 72px
      },
      minWidth: {
        touch: '2.75rem',
        'touch-lg': '3.5rem',
        'touch-xl': '4.5rem'
      },
      minHeight: {
        touch: '2.75rem',
        'touch-lg': '3.5rem',
        'touch-xl': '4.5rem'
      },

      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' }
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        'logo-in': {
          '0%': { opacity: '0', transform: 'scale(0.82)' },
          '60%': { opacity: '1' },
          '100%': { opacity: '1', transform: 'scale(1)' }
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.35', transform: 'scale(1)' },
          '50%': { opacity: '0.6', transform: 'scale(1.08)' }
        }
      },

      animation: {
        float: 'float 4s cubic-bezier(0.37,0,0.63,1) infinite',
        'fade-in-up': 'fade-in-up 0.4s cubic-bezier(0.34,1.56,0.64,1) both',
        'logo-in': 'logo-in 0.9s cubic-bezier(0.34,1.56,0.64,1) both',
        'glow-pulse': 'glow-pulse 4.5s ease-in-out infinite'
      }
    }
  },
  plugins: []
}
