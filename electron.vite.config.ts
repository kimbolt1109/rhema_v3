import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const srcDir = resolve(rootDir, 'src')

/**
 * Path aliases. These MUST stay in sync with `tsconfig.base.json` `compilerOptions.paths`
 * and with `vitest.config.ts`.
 *
 * Note: `@main` is aliased in every build for symmetry with the tsconfig paths, but the
 * renderer must never actually import main-process code — `tsconfig.web.json` drops the
 * `@main/*` mapping so such an import fails typecheck before it can fail at bundle time.
 */
const alias = {
  '@shared': resolve(srcDir, 'shared'),
  '@renderer': resolve(srcDir, 'renderer'),
  '@main': resolve(srcDir, 'main')
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      // electron + node builtins + package.json dependencies are externalized rather
      // than bundled. `externalizeDeps` is electron-vite v5's replacement for the now
      // deprecated `externalizeDepsPlugin()`; it defaults to true and is set explicitly
      // here so the intent is not accidentally lost on a future config edit.
      externalizeDeps: true,
      sourcemap: true,
      minify: false,
      lib: {
        entry: resolve(srcDir, 'main/index.ts')
      }
    }
  },

  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      externalizeDeps: true,
      sourcemap: true,
      minify: false,
      lib: {
        entry: resolve(srcDir, 'preload/index.ts')
      },
      // Preload is pinned to CommonJS with an explicit `.cjs` extension.
      //
      // This is NOT cosmetic. `package.json` sets `"type": "module"`, so a `.js` preload
      // would be interpreted as ESM, and Electron only loads an ESM preload when the
      // renderer runs with `sandbox: false`. We want `sandbox: true` (see
      // `src/main/window.ts`), and a sandboxed preload MUST be CommonJS. Emitting `.cjs`
      // makes the format explicit regardless of the surrounding package type.
      //
      // If you change this, you must also change `sandbox` in the BrowserWindow
      // webPreferences and the preload path the main process resolves.
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },

  renderer: {
    root: resolve(srcDir, 'renderer'),
    resolve: { alias },
    plugins: [react()],
    // Predictable dev-server behaviour for CI/scripts and for the Playwright e2e run
    // added in Phase 10.
    clearScreen: false,
    server: {
      port: 5273,
      strictPort: true,
      host: '127.0.0.1'
    },
    build: {
      outDir: resolve(rootDir, 'out/renderer'),
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(srcDir, 'renderer/index.html')
        }
      }
    }
  }
})
