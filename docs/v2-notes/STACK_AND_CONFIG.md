# Stack & Config — mined from rhema_v2
> Sources: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`,
> `vitest.config.ts`, `playwright.config.ts`, `tailwind.config.js`, `postcss.config.js`, `.gitignore`,
> `.env.example`, `index.html`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`,
> `.github/workflows/supply-chain.yml`, `.github/dependabot.yml`, `config/models.json`,
> `src/index.css`, `src/main.tsx`, `src/App.tsx`, `src/vite-env.d.ts`, `src/store/events.ts`,
> `src/hooks/useEventBus.ts`, `src/store/useRhemaStore.ts` (header only), `src/test/setup.ts`,
> `tests/e2e/smoke.spec.ts` (name only)
>
> **Note on how these were read:** the v2 working tree currently has `src/`, `src-tauri/`, `proto/`,
> and `stream-deck-plugin/` **deleted from disk but still committed** (`git status` on branch
> `problems-md-remediation` shows them as unstaged deletions). All `src/**` content below was read via
> `git show HEAD:<path>` / `git ls-tree`, not the filesystem. This is read-only (no `git checkout`/`restore`
> was run) — repo-mining rule "never edit rhema_v2" was respected.

## 1. Runtime / package manager

```json
"engines": { "node": ">=20.0.0 <25.0.0", "npm": ">=10.0.0" },
"packageManager": "npm@11.13.0"
```

`"type": "module"`, `"private": true`, `"version": "0.1.0"`, package name `"rhema"`.

## 2. npm scripts (package.json)

```json
"dev": "vite",
"build": "tsc && vite build",
"preview": "vite preview",
"tauri": "tauri",
"test": "vitest",
"test:run": "vitest run",
"test:coverage": "vitest run --coverage",
"test:e2e": "playwright test"
```

`"tauri": "tauri"` is the only Tauri-specific script — everything else is a plain Vite/React/vitest/playwright toolchain untouched by Tauri.

## 3. Dependencies — exact resolved versions (from package-lock.json)

### Runtime deps to mirror as-is in Verger

| Package | package.json range | Resolved version |
|---|---|---|
| react | ^19 | 19.2.7 |
| react-dom | ^19 | 19.2.7 |
| zustand | ^5 | 5.0.14 |
| clsx | ^2 | 2.1.1 |
| lucide-react | ^0.400 | 0.400.0 |
| tailwindcss | ^3 | 3.4.19 |
| i18next | ^23.16.8 | 23.16.8 |
| i18next-browser-languagedetector | ^8.2.1 | 8.2.1 |
| react-i18next | ^15.7.4 | 15.7.4 |
| @dnd-kit/core | ^6.3.1 | 6.3.1 |
| @dnd-kit/sortable | ^8.0.0 | 8.0.0 |
| @dnd-kit/utilities | ^3.2.2 | 3.2.2 |

### Tauri-only deps — DO NOT PORT, replace with Electron equivalents

| Package | package.json range | Resolved version | Replace with |
|---|---|---|---|
| @tauri-apps/api | ^2 | 2.11.1 | Electron `ipcRenderer`/`contextBridge` (preload script) |
| @tauri-apps/plugin-dialog | ^2 | 2.7.1 | Electron `dialog` module (main process) via IPC |
| @tauri-apps/plugin-shell | ^2 | 2.3.5 | Electron `shell` module |
| @tauri-apps/cli (dev) | ^2 | 2.11.3 | `electron` + `electron-builder` / `electron-forge` |

Exact import sites that need a rewrite (all under `src/`, confirmed via `git grep tauri-apps`):
- `src/main.tsx` — `invoke` from `@tauri-apps/api/core` (crash-reporting status check on boot)
- `src/App.tsx` — `listen` from `@tauri-apps/api/event`
- `src/hooks/useEventBus.ts` — `listen` from `@tauri-apps/api/event` (the ENTIRE backend→frontend event pipe)
- `src/store/useRhemaStore.ts` — `invoke as tauriInvoke` from `@tauri-apps/api/core` (used everywhere in the 4000-line store as the sole IPC primitive)
- `src/components/lifecycle/LifecycleQuitConfirm.tsx` — `getCurrentWindow` from `@tauri-apps/api/window`
- `src/components/media/MediaLibrary.tsx` — `convertFileSrc` (core) + `open` (plugin-dialog)
- `src/components/playlist/CueCard.tsx` — `convertFileSrc`
- `src/components/playlist/ServicePlaylist.tsx` — `open` (dialog) + `getCurrentWebview` (webview) + `convertFileSrc`
- `src/components/plugins/PluginGallery.tsx` — `open` (dialog) + `getCurrentWebview`
- `src/components/service/ServiceBuilder.tsx` — `open` (dialog)
- `src/components/songs/SongLibrary.tsx` — `open` (dialog)
- `src/test/a11y.test.tsx` — `vi.mock("@tauri-apps/api/core")` / `vi.mock("@tauri-apps/api/event")` (test-mocking pattern to replicate for whatever Electron bridge mock Verger uses)

Everything else in `src/` (all `components/`, `pages/`, `hooks/` besides `useEventBus`) is Tauri-agnostic React — good candidates for straight ports once the IPC layer is swapped.

### Dev deps to mirror

| Package | range | resolved |
|---|---|---|
| typescript | ^5 | 5.9.3 |
| vite | ^6 | 6.4.3 |
| @vitejs/plugin-react | ^4 | 4.7.0 |
| vitest | ^3 | 3.2.6 |
| @vitest/coverage-v8 | ^3 | 3.2.6 |
| @playwright/test | ^1 | 1.61.1 |
| @testing-library/react | ^16 | 16.3.2 |
| @testing-library/jest-dom | ^6 | 6.9.1 |
| jest-axe | ^9.0.0 | 9.0.0 |
| @types/jest-axe | ^3.5.9 | 3.5.9 |
| jsdom | ^25 | 25.0.1 |
| postcss | ^8 | 8.5.15 |
| autoprefixer | ^10 | 10.5.2 |
| @types/react | ^19 | 19.2.17 |
| @types/react-dom | ^19 | 19.2.3 |

Note: `@cyclonedx/cyclonedx-npm` is used in CI (SBOM step) via `npx --yes`, deliberately kept OUT of package.json devDependencies so local `npm install` stays lean.

## 4. tsconfig.json (verbatim)

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "useDefineForClassFields": true,
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,

    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",

    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Strictness flags to mirror: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`. `noEmit: true` — `tsc` is used purely as a type-check gate; `vite build` does the actual emit (see `"build": "tsc && vite build"`).

### tsconfig.node.json (verbatim)

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

## 5. vite.config.ts (verbatim, minus Tauri-specific bits called out)

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @tauri-apps/cli sets TAURI_DEV_HOST when running on a device.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],

  // Tauri expects a fixed port and should fail if it is unavailable.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Don't watch the Rust backend.
      ignored: ["**/src-tauri/**"],
    },
  },
}));
```

**Gotcha for Verger**: port **1420** (dev server) / **1421** (HMR websocket) is a Tauri convention (avoids the common 3000/5173 collisions Tauri docs warn about) — not load-bearing for Electron. Verger can pick its own port, but note it so nothing downstream (e.g. a hardcoded `http://localhost:1420` in an E2E config) silently breaks. `clearScreen: false` and `strictPort: true` are worth keeping regardless (predictable dev-server behavior in CI/scripts). The `watch.ignored: ["**/src-tauri/**"]` entry should become `**/electron/**` or equivalent (Verger's main-process source tree) so Vite doesn't churn on main-process file saves.

## 6. vitest.config.ts (verbatim)

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate from vite.config.ts (which is Tauri-dev-server specific: fixed
// port 1420, strictPort, HMR-over-TAURI_DEV_HOST) so `vitest` never touches
// the Tauri dev-server settings. See PROBLEMS.md #100 / Blueprint PART 13.1
// for the frontend test-matrix requirement this satisfies.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Playwright owns tests/e2e/** (its *.spec.ts files call Playwright's
    // own `test()`, which throws if collected outside a Playwright runner).
    exclude: ["node_modules/**", "dist/**", "src-tauri/**", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Per-subsystem thresholds are documented TARGETS (PROBLEMS.md #103),
      // not yet enforced repo-wide — the frontend test harness is brand new
      // (this phase adds the first tests). Ratchet these up as coverage grows.
      thresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
      exclude: [
        "node_modules/**", "src-tauri/**", "dist/**",
        "**/*.d.ts", "src/test/**", "**/*.config.*",
      ],
    },
  },
});
```

**Key facts**: `environment: "jsdom"`, `globals: true` (no `import { describe, it } from "vitest"` needed), single setup file `src/test/setup.ts` which is **one line**:

```ts
import "@testing-library/jest-dom/vitest";
```

Coverage thresholds are **all zero** — i.e. coverage is measured/reported (`v8` provider, `text`/`html`/`lcov` reporters) but **not enforced**. v2's own comment flags this as a deliberate, temporary state ("ratchet these up as coverage grows") — worth deciding explicitly for Verger rather than silently inheriting 0/0/0/0.

`vitest.config.ts` is intentionally a **separate file** from `vite.config.ts`, specifically so the Tauri dev-server settings (fixed port, `strictPort`, HMR-over-`TAURI_DEV_HOST`) never leak into the test runner. For Verger (no Tauri dev-server quirks to isolate from), a single merged config is likely fine — but keep the separation if Verger's Electron main-process dev server has its own analogous fixed-port/HMR requirements.

## 7. playwright.config.ts (verbatim, with its own caveats preserved)

```ts
import { defineConfig, devices } from "@playwright/test";

// E2E smoke-test scaffold. This targets the app's WEBVIEW content over plain
// HTTP via `vite preview` / `vite dev` — it exercises the React UI the same
// way a browser would, NOT the native Tauri shell (window chrome, native
// menus, filesystem/dialog plugins, IPC to Rust commands). Those need a real
// Tauri WebView driver (e.g. `tauri-driver` + WebDriver), a separate, heavier
// setup tracked as a follow-up.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
```

Only one spec exists: `tests/e2e/smoke.spec.ts`. **CI does NOT run Playwright at all** — no job in `ci.yml` references `test:e2e` (it needs `npx playwright install chromium` browser binaries downloaded, which was deliberately kept out of the "always-green CI path"). Local run sequence documented in the file's header comment:
```
1. npx playwright install chromium   (one-time)
2. npm run dev                        (or let webServer above start it)
3. npm run test:e2e
```

**Lesson for Verger**: the same content-vs-shell gap applies with more force — Playwright-over-`vite preview` tests only the renderer HTML/CSS/JS, never Electron's native menu, tray, IPC bridge, or window chrome. For real Electron E2E, use **Playwright's own Electron driver** (`_electron.launch()` from `playwright`, no separate `tauri-driver`-style tool needed) — this is actually simpler for Electron than it was for Tauri, worth calling out as a Verger improvement opportunity rather than copying the "separate driver, tracked as follow-up, never landed" pattern.

## 8. Tailwind theme — "booth" dark theme (VERBATIM, reproduce exactly)

`darkMode: "class"`, content globs: `["./index.html", "./src/**/*.{js,ts,jsx,tsx}"]`.

### CSS custom properties (src/index.css) — the actual color source of truth

Tailwind's `theme.extend.colors` are **all** `rgb(var(--color-x) / <alpha-value>)` wrappers around these CSS vars, defined once on `:root, .dark` (raw RGB **channel triples**, no `rgb()` wrapper, so Tailwind's `/opacity` modifier syntax works):

```css
:root,
.dark {
  /* Backgrounds — ORIGINAL Claude Design (blueprint) */
  --color-bg:          10  10  15;  /* #0a0a0f */
  --color-surface:     18  18  26;  /* #12121a */
  --color-surface-2:   26  26  38;  /* #1a1a26 */

  --color-accent:      99 102 241;  /* #6366f1 — indigo */
  --color-accent-hover:79  70 229;  /* #4f46e5 */
  --color-accent-2:   129 140 248;  /* #818cf8 — light indigo (gradient top) */
  --color-panic:      239  68  68;
  --color-live:        34 197  94;

  --color-text:       229 231 235;  /* #e5e7eb */
  --color-text-muted: 156 163 175;  /* #9ca3af */

  --color-ring:        99 102 241;
  --color-border:      36  36  51;  /* #242433 — original dark border */
}
```

**ERGO-1 (explicit design rule in the source comment, Blueprint PART 17.11): Rhema has NO light mode. Not a preference — "an ergonomic requirement for the production environment" (this is a live-production booth tool used in a dark room next to a lit stage).** `:root` and `.dark` are defined identically; `index.html` keeps `class="dark"` on `<html>` "for legacy selector compatibility only" — there is no runtime light/dark toggle anywhere. **Verger should decide up front whether it inherits this constraint** (a booth-operator console genuinely benefits from forced-dark) rather than defaulting to a light/dark toggle out of habit.

### Tailwind color tokens (tailwind.config.js `theme.extend.colors`)

```js
colors: {
  background: "rgb(var(--color-bg) / <alpha-value>)",
  surface: "rgb(var(--color-surface) / <alpha-value>)",
  "surface-2": "rgb(var(--color-surface-2) / <alpha-value>)",
  accent: {
    DEFAULT: "rgb(var(--color-accent) / <alpha-value>)",
    hover: "rgb(var(--color-accent-hover) / <alpha-value>)",
  },
  panic: "rgb(var(--color-panic) / <alpha-value>)",
  live: "rgb(var(--color-live) / <alpha-value>)",

  // Compatibility aliases onto the same indigo palette (kept so ~40
  // components using older sky/electric/glass-* class names didn't need
  // editing during a past redesign)
  sky: { DEFAULT: "rgb(var(--color-accent) / <alpha-value>)", 2: "rgb(var(--color-accent-2) / <alpha-value>)" },
  electric: "rgb(var(--color-accent) / <alpha-value>)",
  "glass-fill": "rgb(var(--color-surface) / <alpha-value>)",
  "glass-border": "rgb(var(--color-border) / <alpha-value>)",
  "ui-ring": "rgb(var(--color-ring) / <alpha-value>)",
  "ui-border": "rgb(var(--color-border) / <alpha-value>)",
}
```

**Verger lesson**: do NOT recreate the `sky`/`electric`/`glass-*` alias sprawl — that existed only to avoid touching ~40 already-written v2 components during a mid-project rebrand. Since Verger is a from-scratch rebuild, name tokens once, correctly (`background`/`surface`/`surface-2`/`accent`/`panic`/`live`) and skip the aliases entirely.

### Font stacks

```js
fontFamily: {
  sans: ["Inter", "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
  mono: ["ui-monospace", '"JetBrains Mono"', '"Cascadia Code"', "Consolas", "monospace"],
}
```

### Border radius ("edge styling: soft rounded corners")

```js
borderRadius: {
  glass: "0.875rem",      // 14px — cards
  "glass-md": "1rem",     // 16px
  "glass-lg": "1.125rem", // 18px — panels
}
```

### Backdrop blur — explicitly ZEROED

```js
backdropBlur: { glass: "0px", "glass-md": "0px", "glass-lg": "0px" }
```
Comment: "No backdrop blur: surfaces are solid Claude Design, not glass." (Despite the `glass-*` naming throughout, the current theme is deliberately **flat/solid**, not a glassmorphism style — the class names are legacy from an earlier glass-morphism design that was later replaced with solid indigo-on-near-black. Don't be misled by the `.glass-panel`/`.glass-card`/`.glass-button` class names in `index.css` into building actual blur/translucency for Verger.)

### Shadows

```js
boxShadow: {
  glass: "0 1px 2px 0 rgba(0,0,0,0.20), inset 0 1px 0 0 rgba(255,255,255,0.04)",
  glow: "0 4px 16px rgba(99,102,241,0.28)",
  float: "0 4px 16px rgba(0,0,0,0.18)",
  "inner-highlight": "inset 0 1px 0 0 rgba(255,255,255,0.10)",
  "float-dark": "0 8px 32px 0 rgba(0,0,0,0.40), 0 2px 8px 0 rgba(0,0,0,0.20)",
}
```

### Keyframes / animations

```js
keyframes: {
  float: { "0%, 100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-6px)" } },
  "fade-in-up": { "0%": { opacity: "0", transform: "translateY(10px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
  "logo-in": { "0%": { opacity: "0", transform: "scale(0.82)" }, "60%": { opacity: "1" }, "100%": { opacity: "1", transform: "scale(1)" } },
  "glow-pulse": { "0%, 100%": { opacity: "0.35", transform: "scale(1)" }, "50%": { opacity: "0.6", transform: "scale(1.08)" } },
},
animation: {
  float: "float 4s cubic-bezier(0.37,0,0.63,1) infinite",
  "fade-in-up": "fade-in-up 0.4s cubic-bezier(0.34,1.56,0.64,1) both",
  "logo-in": "logo-in 0.9s cubic-bezier(0.34,1.56,0.64,1) both",
  "glow-pulse": "glow-pulse 4.5s ease-in-out infinite",
}
```

### index.css structural pieces (beyond the CSS vars above)

- `html, body, #root { height: 100%; margin: 0; }`
- `body { background-color: rgb(var(--color-bg)); color: rgb(var(--color-text)); font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; overflow: hidden; user-select: none; }` — **note `overflow: hidden` and `user-select: none` on `body`**: this is a kiosk/console app, not a scrolling document; individual scroll regions opt in explicitly. Worth deciding deliberately for Verger, not inheriting by accident.
- Custom scrollbar (`::-webkit-scrollbar`): 8px wide/tall, transparent track, thumb = `rgb(var(--color-border))`, hover thumb = `rgb(var(--color-accent) / 0.55)`, `border-radius: 999px`.
- `@layer components` utility classes: `.glass-panel` (solid surface fill, used for sidebar/topbar/major panels), `.glass-card` (solid surface + 1px border + 14px radius + soft shadow, for floating content cards), `.glass-button` (surface-2 fill + border + 10px radius + inset highlight + hover lift `translateY(-1px)` + active `translateY(0)`, transitions on `border-color`/`box-shadow`/`transform` at 0.15–0.18s ease-out), `.glow-hover` (restrained indigo glow + lift on hover), `.float` (the float keyframe as a class), `.edge-highlight` (inset top-edge gloss line via `::before` pseudo-element).
- `@media (prefers-reduced-motion: reduce)` guard: forces all animation/transition durations to `0.01ms` and `animation-iteration-count: 1`. **Accessibility requirement to replicate in Verger.**

### postcss.config.js (verbatim)

```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

## 9. .gitignore (verbatim)

```
# Secrets
.env
.env.*.local

# Node
node_modules/
dist/
.vite/

# Rust / Tauri
src-tauri/target/
target/

# OS / editor
.DS_Store
Thumbs.db

# OMC / orchestrator state
.omc/

# Local runtime data
*.log
```

For Verger: drop the `# Rust / Tauri` block, add Electron-equivalents (`out/`, `release/`, or whatever `electron-builder`/`electron-forge` output dir is chosen), keep everything else including `.omc/` if the same orchestration tooling is in use for Verger's own dev loop.

## 10. .env.example (verbatim — contract, not values)

```
# Rhema environment contract (PROBLEMS.md #9, ADR-017)
# Copy to .env and fill. .env is gitignored — never commit real values.
# Empty values = the subsystem runs in degraded/not-configured mode (never crashes).

# --- Crash reporting (ADR-011, Phase 5) ---
SENTRY_DSN=

# --- Licensing & updates (PART 10.3/10.7, ADR-010, Phase 5) ---
RHEMA_LICENSE_API_URL=
RHEMA_UPDATE_MANIFEST_URL=
RHEMA_UPDATER_PUBKEY=

# --- Cloud AI (ADR-006 Stage 7, Phase 5) ---
ANTHROPIC_API_KEY=

# --- Bible translation providers (ADR-013, Phase 5) ---
ESV_API_KEY=
API_BIBLE_KEY=

# --- Planning Center OAuth (PART 12.1, Phase 5) ---
PCO_CLIENT_ID=
PCO_CLIENT_SECRET=

# --- Multi-site sync (ADR-017, Phase 5) ---
NEON_DATABASE_URL=

# --- Payments / license issuance (PART 10.7, Phase 5; used by cloud/workers, not the app) ---
PADDLE_API_KEY=
PADDLE_WEBHOOK_SECRET=
```

Design principle stated explicitly: **"Empty values = the subsystem runs in degraded/not-configured mode (never crashes)."** Adopt this for Verger's own env contract — no required env var should hard-crash the app; missing config should downgrade a specific feature.

## 11. config/models.json

Single file in `config/`. A **model registry with SHA-256 supply-chain pins** (schemaVersion 1). Shape per entry:

```json
{ "id": "string", "file": "relative/path", "sha256": "hex-or-empty", "sizeBytes": 12345, "license": "SPDX-or-name", "source": "URL-or-\"bundled\"" }
```

14 entries registered (Whisper ASR variants — ggml + ONNX, MiniLM embedding x2, Silero VAD, RT-DETR, CLIP, a proprietary `rhema-classifier-v1`, fastText language-ID, NLLB-200 translation). Every `sha256` field is **currently an empty string** — the file's own top-level `"//"` comment explains the loader contract: *"The loader computes each file's SHA-256 before load and REFUSES to load on mismatch. Models not listed here load with a pass-with-warning (unknown model)... `sha256 == \"\"` means the pin is not yet captured... the loader treats it as unpinned pass-with-warning."*

This entire subsystem (local ONNX/whisper.cpp AI models, hash-pinned for supply-chain defense) is **Rust/Tauri-native ML infrastructure with no direct Electron equivalent** — it's out of scope for a config/tooling port, but the **pattern** (hash-pin third-party binary model files, fail closed on mismatch, degrade gracefully when unpinned) is worth keeping if Verger ever bundles local ML models.

## 12. .github/ — CI, release, supply-chain, dependabot

### ci.yml — two parallel jobs, 3-OS matrix each (windows-latest/macos-latest/ubuntu-latest)

- **`rust` job** (drop entirely for Verger — no Rust crate): installs Tauri Linux system deps (`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev libasound2-dev`) on ubuntu only, `cargo fmt --check`, `cargo check --lib` with `RUSTFLAGS: "-D warnings"` (compiler warnings are a hard gate), `cargo clippy --all-targets` (`continue-on-error: true` — advisory only, not enforced), `cargo test --lib`.
- **`frontend` job** (the one to mirror for Verger, adjusted for Electron): `actions/checkout@v4` → `actions/setup-node@v4` (`node-version: 20`, `cache: npm`) → `npm ci` → `npx tsc --noEmit` (typecheck gate) → `npm run test:run` (vitest, non-watch) → `npm run build`.
- Triggers: `push`/`pull_request` to `[main, master]`, plus `workflow_dispatch`. `concurrency: group: ci-${{ workflow }}-${{ ref }}, cancel-in-progress: true`.
- Playwright/E2E is **not** wired into CI at all (confirmed above).

### release.yml — explicitly a STUB, unsigned artifacts only

Header comment: *"builds UNSIGNED artifacts only... code signing (Windows Authenticode / Apple Developer ID + notarization) requires certificates/credentials that are NOT present in this repo... Do not distribute artifacts produced by this workflow to end users; they will trip OS 'unknown publisher' warnings and there is no auto-update manifest wired up."* Triggers: `workflow_dispatch` + `push` tags `v*` (does not run on every push). Builds via `npx tauri build --no-default-features` (Tauri-specific — Verger replaces with `electron-builder`/`electron-forge` build+package, and will face the **identical unsigned-artifact problem** — flag this to the human early since Windows/macOS code signing certs are exactly the kind of externally-provisioned credential the user's own CLAUDE.md instructs to log to `HUMAN_WORK_LIST.md` and continue past, not block on).

### supply-chain.yml — 4 jobs

- `cargo-audit` (drop — Rust only). Comment notes it was already ADVISORY/`continue-on-error: true` because of ~26 unfixable transitive advisories from Tauri/GTK/rustls.
- `npm-audit`: `npm audit --audit-level=high` (not `critical` — "catch real issues without the job flapping on every low-severity transitive advisory"). **Keep this exact threshold choice for Verger.**
- `osv-scanner`: installs `github.com/google/osv-scanner/v2/cmd/osv-scanner@latest` via `go install`, scans `--lockfile=src-tauri/Cargo.lock --lockfile=package-lock.json`, all advisory (`|| true`). For Verger, drop the Cargo.lock arg, keep the npm one.
- `sbom`: CycloneDX SBOM generation — `cargo cyclonedx` for Rust (drop) + `npx --yes @cyclonedx/cyclonedx-npm --output-file sbom-frontend.json` for npm (keep). Uploads both as a 90-day retained artifact.
- Schedule: `cron: "17 4 * * *"` (daily) plus push/PR/`workflow_dispatch`.

### dependabot.yml — 3 ecosystems

```yaml
- package-ecosystem: cargo,      directory: /src-tauri, weekly/monday, limit 10, labels [dependencies, rust], groups.cargo-patch-minor
- package-ecosystem: npm,        directory: /,          weekly/monday, limit 10, labels [dependencies, npm],  groups.npm-patch-minor
- package-ecosystem: github-actions, directory: /,       weekly/monday,           labels [dependencies, ci]
```
Drop the `cargo` block for Verger; keep `npm` and `github-actions` blocks verbatim (same weekly/Monday cadence, same 10-PR limit, same minor/patch auto-grouping).

## 13. index.html (verbatim)

```html
<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RHEMA</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
Note the hardcoded `class="dark"` on `<html>` — consistent with the "no light mode, ever" ERGO-1 rule.

## 14. src/ top-level structure — layering to replicate the shape of, not the content

129 tracked files under `src/` (read via `git ls-tree -r HEAD -- src`, since `src/` is currently deleted from the working tree — see header note). Top-level directories:

```
src/
  App.tsx                  — root shell component; composes Sidebar/TopBar/MainArea/StatusBar/
                              CommandPalette + a stack of always-mounted overlay components
                              (PanicOverlay, HoldProgressIndicator, NotificationToasts,
                              ManualCheckPrompt, EngagementNudge, FirstRunWizard, WelcomeScreen,
                              LifecycleResumeModal, LifecycleQuitConfirm, CloudAiConsentGate) +
                              calls useEventBus()/useKeyboardShortcuts()/usePart17Cadence() hooks.
  main.tsx                 — entry point; routes between 3 window "kinds" purely by URL query
                              string, all from the SAME index.html/bundle:
                                ?output=<id>  -> <OutputView screenId>   (projector/output window)
                                ?panel=<id>   -> <PanelWindow panelId>   (torn-off console panel)
                                (neither)     -> <App />                (main operator console)
                              Also fires a one-shot invoke("crash_reporting_get") on boot.
  index.css                 — see section 8 above (theme + utility classes)
  vite-env.d.ts              — Vite client types + declare module "*.png/.jpg/.svg/etc" (asset imports)
  assets/                    — rhema-logo.png (binary asset)
  store/
    useRhemaStore.ts          — SINGLE 4002-line Zustand mega-store (create() from "zustand") — the
                                 whole app's state lives in one store, sliced by naming convention
                                 (not by separate zustand stores/slices files). Wraps
                                 @tauri-apps/api/core's `invoke` in a local `invoke<T>()` that
                                 catches 4 known "GuardError" codes (INVALID_SENDER,
                                 INVALID_PAYLOAD, FORBIDDEN, RATE_LIMITED — mirroring a Rust
                                 `security::command_guard::GuardError`) and auto-pushes a toast
                                 notification, then RE-THROWS so callers still see the rejection.
                                 Defines PageId (15 values: dashboard/service/postservice/library/
                                 cameras/lighting/audio/streaming/speakers/campus/settings/
                                 security/plugins/about/outputs), ViewMode ("normal"|"pro"),
                                 ViewTier ("simple"|"operator"|"director" — 3-tier progressive
                                 disclosure layered ONTO the same normal/pro split).
    events.ts (119 lines)      — RhemaEvent: one big discriminated union TS type, explicitly a
                                 "Mirror of the Rust RhemaEvent enum" — externally-tagged JSON to
                                 match serde's default enum serialization, e.g.
                                 `{ "SlideAdvanced": { "new_index": 1, "total": 10 } }` for a
                                 struct variant or the bare string `"PanicActivated"` for a unit
                                 variant. ~50 event variants across ~15 phase-tagged groups
                                 (service lifecycle, transcript/speech, slides, Bible detection,
                                 cameras, DMX/lighting, lower-thirds, captions/translation,
                                 speaker ID, beat/timecode, streaming/recording, panic, AI module
                                 health, media/cue playlist, post-service automation,
                                 multi-campus, operator notifications).
                                 `export const RHEMA_EVENT = "rhema://event"` — the single Tauri
                                 event-channel name EVERYTHING funnels through.
                                 `eventName(e)` helper: `typeof e === "string" ? e : Object.keys(e)[0]`.
    events.test.ts, formatBibleReference.test.ts, guardErrorNotification.test.ts,
    viewTierMigration.test.ts  — co-located *.test.ts next to the store (not a separate __tests__ dir).
  hooks/
    useEventBus.ts (37 lines) — the ENTIRE backend->frontend event pipe: one `listen<RhemaEvent>
                                 (RHEMA_EVENT, cb)` subscription (mount once near app root, in
                                 App.tsx), feeds every event into the store's `pushEvent`. Handles
                                 the "listen() rejects in a pure-browser dev context (no Tauri)"
                                 case by catching and warning, not crashing.
    useKeyboardShortcuts.ts, usePart17Cadence.ts, useSplit.ts
  components/                 — ~25 domain subfolders, each named after a console feature area:
                                 ai/ audio/ bible/ cameras/ campus/ captions/ console/
                                 (+ console/panels/) hardware/ intelligence/ layout/ lifecycle/
                                 lighting/ media/ notifications/ outputs/ overlays/ playlist/
                                 plugins/ security/ service/ shared/ songs/ speakers/ streaming/
                                 welcome/ wizard/. `shared/` holds the design-system primitives
                                 (Badge, Button, GlassCard, GlassPanel, GlossyIcon,
                                 HoldProgressIndicator, PanicOverlay, SectionTitle,
                                 StatusIndicator, ClearAllHoldButton).
                                 `console/` is the layout-switch machinery: NormalLayout vs
                                 ProDashboard vs SimpleLayout (the 3 ViewTier variants),
                                 PanelShell/PanelWindow (torn-off panel support),
                                 RenderSafeModePanel, Runbook, StatusBar; `console/panels/` holds
                                 the individual pro-console panel components (AI/Camera/Caption/
                                 Light/Program/SlideQueue).
  pages/                       — ~15 route-level view components, one per PageId value
                                 (Dashboard, Service, PostService, Library, Cameras, Lighting,
                                 Audio, Streaming, Speakers, Campus, Settings, Security, Plugins,
                                 About, Outputs) — thin composition wrappers around
                                 domain-specific components/ subfolders, selected by MainArea.tsx
                                 based on the store's current PageId, NOT by a router library
                                 (no react-router in dependencies — routing is store-state-driven).
  output/
    OutputView.tsx             — the projector/screen output window content (see main.tsx routing)
  lib/
    serviceSession.ts           — the one piece of "service"-style logic that got its own file
                                   outside the mega-store (no src/services/ directory exists in v2).
  media/
    mediaDevices.ts              — `primeAndEnumerate` — camera/mic device enumeration, imported
                                    by the store.
  i18n/
    index.ts, direction.ts, pseudo.ts, locales/en.json — i18next setup; direction.ts exports
    useDocumentDirection() for RTL (Arabic/Hebrew) <html dir> sync, called in main.tsx's Root()
    for every window kind including output/panel windows. pseudo.ts suggests a pseudo-localization
    testing mode.
  test/
    setup.ts                     — see section 6. Also holds a11y.test.tsx which mocks
                                    @tauri-apps/api/core and @tauri-apps/api/event with vi.mock().
  remote-panel/                  — a SEPARATE static PWA (app.js, index.html, styles.css, sw.js,
                                    manifest.json, icon.svg) — not part of the React/Vite bundle,
                                    a phone/tablet remote-control surface served independently.
  caption-pwa/
    index.html                   — another separate static PWA entry (captions display surface).
```

No `src/services/` directory exists — service-layer logic is either inlined in the mega-store or (rarely, e.g. `serviceSession.ts`) in `lib/`. **This is called out explicitly as a pattern to reconsider for Verger** (see application notes below) rather than copy.

Other **repo-root** directories that exist in v2 but are out of this note's scope (covered by other mining passes, presumably): `src-tauri/` (the Rust crate — not ported), `proto/` (protobuf, likely `rhema_campus.proto` for multi-campus sync), `stream-deck-plugin/`, `cloud/` (README + `update-manifest` + `workers`), `tests/e2e/smoke.spec.ts`.

## Verger application notes

What the Electron/TypeScript rebuild should do differently, since the Tauri/Rust engine is not being ported:

1. **Replace the IPC primitive everywhere.** v2's entire backend communication is exactly two primitives: `invoke(cmd, args)` (Tauri command call, request/response) and `listen(eventName, cb)` (Tauri event subscription, fire-and-forget push). Electron's equivalents are `ipcRenderer.invoke`/`ipcMain.handle` (request/response, same shape) and `ipcRenderer.on`/`webContents.send` (push events) — exposed to the renderer through a `contextBridge`-based preload script (never disable `contextIsolation`). Since v2 already funnels every command through a single wrapped `invoke<T>()` in the store and every event through a single `useEventBus()` hook subscribed to one channel name (`"rhema://event"`), Verger can port this 1:1 as a thin `window.verger.invoke(cmd, args)` / `window.verger.on(eventName, cb)` bridge — the **shape** of the abstraction (one wrapped invoke, one event channel, one subscribing hook) is worth keeping even though the underlying transport changes completely.

2. **Port the GuardError-toast pattern, but rename it.** The `invoke()` wrapper's behavior — catch specific error codes, auto-push a toast notification, then re-throw so the caller's own error handling still runs — is a good pattern independent of Tauri. If Verger's main process has any analogous guard/permission layer, replicate the "parse known error codes from the rejection, side-effect a notification, never swallow" shape.

3. **Decide the RhemaEvent-style discriminated union early, and decide the wire format deliberately** (don't default to "mirror serde's externally-tagged enum encoding" just because v2 did) — v2's `{ VariantName: {...fields} }` / bare-string-for-unit-variant shape exists specifically because it's serde's default Rust enum JSON representation. Electron's main process is TypeScript, not Rust, so there's no serde constraint forcing that shape — a flatter `{ type: "SlideAdvanced", newIndex, total }` (discriminated union on a `type` field) is more idiomatic TS and avoids the `eventName(e) = typeof e === "string" ? e : Object.keys(e)[0]` workaround v2 needed. Still worth enumerating the ~50 event variants as a checklist of "things the engine needs to be able to tell the UI," even though the exact shape will differ (a separate mining pass presumably owns the full RhemaEvent enumeration — event names only, not payload semantics, are noted here).

4. **Reconsider the "no `services/` layer, one 4000-line store" architecture.** v2's `useRhemaStore.ts` grew to 4002 lines because every domain's state AND its invoke-calling actions live in one Zustand store with no service-layer indirection. This is a known-costly pattern at this scale (single file, single merge-conflict magnet, hard to test in isolation). For Verger, prefer either (a) multiple domain-scoped Zustand stores, or (b) a thin `services/` layer that owns IPC calls per domain with slim per-domain stores consuming it — do not reflexively recreate the monolith.

5. **The `sky`/`electric`/`glass-*` Tailwind alias sprawl was rebrand debt, not a design decision — skip it.** Define the real token names once (`background`, `surface`, `surface-2`, `accent`/`accent-hover`, `panic`, `live`, plus the border/ring/text tokens from `index.css`) and use them directly everywhere; there's no legacy call-sites to preserve in a fresh rebuild.

6. **The `.glass-*` class names describe a flat/solid theme, not glassmorphism** (`backdropBlur` is explicitly zeroed). If Verger wants actual glass/blur effects, that's a new design decision — don't assume the v2 name implies the v2 look. If Verger wants the *current* v2 look (dark near-black `#0a0a0f` background, indigo `#6366f1` accent, solid flat surfaces, 14px card radius, soft shadows, no blur), the tokens in section 8 are the exact spec to reproduce.

7. **Decide the dark-only ("ERGO-1") constraint deliberately.** It's a considered operational requirement for a live-production booth tool (dark room, avoid a bright UI competing with a lit stage), not an oversight. If Verger targets the same use case, keep it and skip building a light theme/toggle at all (saves real design + QA effort). If Verger's scope has broadened beyond the booth-only context, this needs an explicit product decision, not a silent inheritance.

8. **`overflow: hidden; user-select: none;` on `<body>` is a kiosk-app choice.** Confirm this is still wanted for Verger (it disables page-level scrolling and text selection app-wide, relying on individual components to opt in to their own scroll regions) rather than carrying it over by default.

9. **CI**: mirror the `frontend` job from `ci.yml` almost verbatim (checkout → setup-node@20 w/ npm cache → `npm ci` → `tsc --noEmit` → `npm run test:run` → `npm run build`, 3-OS matrix), drop the `rust` job entirely, and swap the `release.yml`/`supply-chain.yml` Tauri-specific steps (`tauri build --no-default-features`, `cargo-audit`, `cargo cyclonedx`, the Cargo.lock osv-scanner arg) for `electron-builder`/`electron-forge` equivalents. Keep the `npm audit --audit-level=high` threshold, the daily supply-chain cron (`17 4 * * *`), and the dependabot npm/github-actions blocks (weekly/Monday, patch+minor auto-grouping, 10-PR cap) as-is. **The unsigned-release-artifact problem (no code-signing certs present) will recur identically for Electron** — log it to `HUMAN_WORK_LIST.md` immediately per the standing operating principle rather than rediscovering it later.

10. **Vitest coverage thresholds are currently 0/0/0/0 by design in v2** ("ratchet up as coverage grows," never actually ratcheted in the mined snapshot). Verger should pick real thresholds from day one if coverage enforcement matters, rather than inheriting the placeholder.

11. **Playwright**: reuse the same `testDir`/`fullyParallel`/`forbidOnly-on-CI`/`trace: on-first-retry` shape, but replace the `webServer` + `baseURL: http://localhost:1420` (renderer-only, browser-context) approach with Playwright's built-in Electron support (`_electron.launch()`), which can drive the real Electron window/IPC — something v2 never got to for Tauri (it stayed a browser-only smoke test with native-shell E2E "tracked as a follow-up" that never landed, per the file's own comments). This closes a real coverage gap v2 had.

12. **`main.tsx`'s query-string window-routing trick (`?output=<id>`, `?panel=<id>`) is transport-agnostic and worth keeping as-is** — it's just `URLSearchParams` branching in the renderer entry point, nothing Tauri-specific. Electron's `BrowserWindow` can load the same `index.html` with different query strings per window (main console / output-display window / torn-off panel window) exactly like v2 does.

13. **`remote-panel/` and `caption-pwa/` are separate static PWAs served independently of the main Vite/React bundle** (own `index.html`, `sw.js`, `manifest.json`). If Verger needs equivalent remote-control/caption-display surfaces, decide explicitly whether they're served from the Electron main process (e.g. a small embedded HTTP server) or genuinely hosted elsewhere — this was presumably served by the Tauri/Rust backend in v2 and has no automatic Electron equivalent.
