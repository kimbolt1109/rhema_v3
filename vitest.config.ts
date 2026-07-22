import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const srcDir = resolve(rootDir, 'src')

/** Keep in sync with `electron.vite.config.ts` and `tsconfig.base.json` paths. */
const alias = {
  '@shared': resolve(srcDir, 'shared'),
  '@renderer': resolve(srcDir, 'renderer'),
  '@main': resolve(srcDir, 'main')
}

/**
 * Two projects, because Verger has two runtimes under test:
 *
 *  - `node`     — main process, preload bridge and the shared protocol. No DOM.
 *                 OBS/YouTube/ASR clients are unit tested against mocks here; no test
 *                 in this project may require a live OBS, network, or Electron runtime.
 *  - `renderer` — React 19 booth UI under jsdom, with Testing Library + jest-axe.
 *
 * `coverage`, `reporters` and `passWithNoTests` are root-only options in Vitest 4
 * (they are excluded from `ProjectConfig`), so they live at the top level.
 */
export default defineConfig({
  test: {
    globals: true,
    // Phases land incrementally and some slices legitimately have no tests yet; a
    // missing test file must not fail the phase gate. Real coverage is enforced by
    // each phase's own acceptance checklist.
    passWithNoTests: true,

    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          globals: true,
          include: ['src/{main,preload,shared}/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'out/**', 'release/**', 'tests/e2e/**']
        }
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          globals: true,
          css: false,
          include: ['src/renderer/**/*.test.ts', 'src/renderer/**/*.test.tsx'],
          exclude: ['**/node_modules/**', 'out/**', 'release/**', 'tests/e2e/**'],
          setupFiles: [resolve(rootDir, 'vitest.setup.ts')]
        }
      }
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'out/**',
        'release/**',
        'node_modules/**',
        '**/*.config.*',
        // Overlay pages are plain framework-free HTML/CSS/JS loaded as OBS browser
        // sources; they are covered by the Phase 2 protocol tests, not by unit coverage.
        'src/overlay/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.test.tsx',
        'vitest.setup.ts',
        'tests/**'
      ]
    }
  }
})
