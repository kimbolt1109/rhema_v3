/**
 * Verger "booth" theme.
 *
 * ERGO-1: there is NO light mode. Not a preference — an ergonomic requirement for a
 * live-production booth (dark room, next to a lit stage). `darkMode: 'class'` is kept
 * only so the `dark:` variant compiles; `<html>` carries `class="dark"` permanently and
 * there is no runtime toggle anywhere.
 *
 * Colours are `rgb(var(--color-x) / <alpha-value>)` wrappers over CSS custom properties
 * declared once on `:root, .dark` in the renderer stylesheet — read the header comment
 * there, because THE ONE COLOUR RULE lives in it and this file only plumbs it:
 *
 *   a filled saturated field is a STATE; a saturated border + a <=18% tint is an
 *   AFFORDANCE about a state; saturated colour is never text and never a text background.
 *
 * Consequently `accent` is not a hue. It is CHALK — a neutral whose only job is brightness,
 * so that hue can mean state and nothing else. Anything reaching for a coloured button is
 * visibly wrong by construction.
 *
 * Surfaces are flat and solid. No backdrop blur, no coloured shadow, anywhere.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        background: 'rgb(var(--color-bg) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--color-surface-2) / <alpha-value>)',
        // Hover / pressed fill, so an interaction never has to borrow a state colour.
        'surface-3': 'rgb(var(--color-surface-3) / <alpha-value>)',
        // The confidence gauge's trough. Opaque by design — see the note in index.css.
        meter: 'rgb(var(--color-meter) / <alpha-value>)',

        // CHALK. Emphasis without hue: focus, the gauge needle, a pressed control's tint.
        accent: {
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          hover: 'rgb(var(--color-accent-hover) / <alpha-value>)'
        },
        // Dim amber — "degraded but stable". Retasked from light indigo.
        'accent-2': 'rgb(var(--color-accent-2) / <alpha-value>)',

        // State. Program red / preview green / standby amber / fault.
        tally: 'rgb(var(--color-tally) / <alpha-value>)',
        live: 'rgb(var(--color-live) / <alpha-value>)',
        warn: 'rgb(var(--color-warn) / <alpha-value>)',
        panic: 'rgb(var(--color-panic) / <alpha-value>)',

        text: {
          DEFAULT: 'rgb(var(--color-text) / <alpha-value>)',
          muted: 'rgb(var(--color-text-muted) / <alpha-value>)',
          dim: 'rgb(var(--color-text-dim) / <alpha-value>)'
        },
        border: 'rgb(var(--color-border) / <alpha-value>)',
        // Authored line work: zone rules, gauge ticks, the bar's top edge, the fired-cue rule.
        'border-strong': 'rgb(var(--color-border-strong) / <alpha-value>)',
        ring: 'rgb(var(--color-ring) / <alpha-value>)'
      },

      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['ui-monospace', '"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'monospace'],
        /**
         * Numerals. An alias of the mono stack rather than a new dependency: Consolas resolves on
         * a stock Windows church PC and is tabular by default. Every number in the app — the
         * confidence percentage, the clock, slide numbers, camera digits, ports — is `font-num`;
         * every word is the sans stack.
         */
        num: ['ui-monospace', '"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'monospace']
      },

      /**
       * Seven steps, and nothing between them.
       *
       * The old surface jumped from `text-[11px]` straight to `text-4xl` with nothing in between,
       * which is what "no type scale" looks like. 11px is the floor on purpose: 10px is unreadable
       * in a dark booth at arm's length whatever its contrast. `micro` is the only step that may
       * take `uppercase`, and only on fixed non-prose legends (ON AIR, REC, PGM, NOW, GO LIVE …).
       */
      fontSize: {
        micro: ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.08em', fontWeight: '600' }],
        meta: ['0.75rem', { lineHeight: '1rem', letterSpacing: '0', fontWeight: '500' }],
        body: ['0.8125rem', { lineHeight: '1.125rem', letterSpacing: '-0.01em', fontWeight: '500' }],
        label: ['0.9375rem', { lineHeight: '1.25rem', letterSpacing: '-0.014em', fontWeight: '600' }],
        title: ['1.0625rem', { lineHeight: '1.375rem', letterSpacing: '-0.018em', fontWeight: '600' }],
        readout: ['1.375rem', { lineHeight: '1.375rem', letterSpacing: '-0.01em', fontWeight: '500' }],
        metric: ['2.125rem', { lineHeight: '2rem', letterSpacing: '-0.025em', fontWeight: '600' }]
      },

      /**
       * Five radii, and the radius-to-size ratio FALLS as the element grows — which is the
       * optically correct behaviour and the direct fix for one-radius-everywhere. A 220px slide
       * tile and a 44px gear cannot share a corner.
       *
       * `glass*` are LEGACY ALIASES kept only so the ~160 existing `rounded-glass*` call sites keep
       * working; they now mean control / panel / tile and are scheduled for rename. 14px on a 220px
       * thumbnail was the loudest generated-web-app tell in the product.
       */
      borderRadius: {
        sharp: '0',
        chip: '0.125rem', // 2px  — number chips, badges, pills, the clock well
        control: '0.1875rem', // 3px  — 44-56px controls, inputs, drawer rows
        panel: '0.25rem', // 4px  — 112px actions, Button.tsx, cards, modals
        tile: '0.375rem', // 6px  — the 220x124 slide tiles, and nothing else
        glass: '0.1875rem', // legacy === control
        'glass-md': '0.25rem', // legacy === panel
        'glass-lg': '0.375rem' // legacy === tile
      },

      /**
       * Elevation by edge, keyline and recess — never by blur, and never by colour. There is no
       * coloured drop shadow anywhere in this app.
       */
      boxShadow: {
        // The 1px machined top highlight that makes a cap look pressable when surface-2 is only
        // 1.10:1 above surface. Tokenised chalk at 5%, replacing a pure-white 10% (ERGO-4).
        edge: 'inset 0 1px 0 0 rgb(var(--color-accent) / 0.05)',
        /**
         * LOAD-BEARING, not decoration: the 1px page-black gutter between a state frame and slide
         * artwork. Program red against a mid-grey thumbnail is 1.02:1 — invisible. This gutter is
         * the only reason the NOW frame reads over a real deck, so it is on every tile.
         */
        keyline: 'inset 0 0 0 1px rgb(var(--color-bg))',
        // Sinks a numeric display into the panel: the elapsed clock well, inputs.
        recess:
          'inset 0 1px 2px 0 rgb(0 0 0 / 0.5), inset 0 0 0 1px rgb(var(--color-border))',
        // Seats a filled colour block so it reads as a lamp in a panel, not a flat swatch.
        lamp: 'inset 0 0 0 1px rgb(0 0 0 / 0.55)',
        // The bar's separation from the grid, cast upward. The hairline itself is a real border.
        lift: '0 -8px 20px -12px rgb(0 0 0 / 0.9)',
        // The only genuinely floating layers: the settings drawer, modals.
        panel:
          '-16px 0 40px -12px rgb(0 0 0 / 0.75), 0 0 0 1px rgb(var(--color-border))',

        // Legacy aliases so untouched call sites degrade to something correct rather than breaking.
        // `glow` was `0 4px 16px rgba(99,102,241,0.28)` — an indigo halo, and a hard-coded hex in
        // violation of this theme's own no-literal-colours rule.
        glow: 'inset 0 0 0 1px rgb(var(--color-bg))',
        'float-dark':
          '-16px 0 40px -12px rgb(0 0 0 / 0.75), 0 0 0 1px rgb(var(--color-border))'
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

      // One easing for the whole instrument: fast out, zero overshoot. A spring that overshoots is
      // a marketing easing and has no place on a control surface.
      transitionTimingFunction: {
        instrument: 'cubic-bezier(0.2, 0, 0, 1)'
      },

      /**
       * `float` and `glow-pulse` are deleted outright — a breathing coloured glow was the loudest
       * vibe-coded artefact in this config, and neither was referenced anywhere in the renderer.
       * What remains is opacity-only and interruptible.
       */
      keyframes: {
        'fade-in-up': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        'logo-in': {
          '0%': { opacity: '0', transform: 'scale(0.98)' },
          '100%': { opacity: '1', transform: 'scale(1)' }
        }
      },

      animation: {
        'fade-in-up': 'fade-in-up 120ms cubic-bezier(0.2,0,0,1) both',
        'logo-in': 'logo-in 180ms cubic-bezier(0.2,0,0,1) both'
      }
    }
  },
  plugins: []
}
