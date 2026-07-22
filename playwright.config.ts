/**
 * Playwright configuration — the end-to-end suite only.
 *
 * Verger's e2e suite drives the **real built Electron app** through Playwright's Electron support
 * (`_electron.launch`). It never opens Chromium, Firefox or WebKit as a standalone browser, so
 * `npx playwright install` is deliberately not a prerequisite: the only browser involved is the one
 * inside the Electron binary that `npm install` already put in `node_modules`.
 *
 * Three settings here are load-bearing rather than taste:
 *
 * - **`workers: 1` / `fullyParallel: false`.** The app binds `127.0.0.1:7320` for the overlay
 *   server and takes Electron's single-instance lock. Two workers would mean two instances, and the
 *   second would either quit on the lock or fail to bind the port — an infrastructure failure
 *   dressed up as a product bug. One worker is not a performance compromise, it is the only
 *   correct value.
 * - **`retries: 0`.** A retried e2e run relaunches the app and re-binds the port while the previous
 *   process may still be releasing it, which turns a real failure into an intermittent one. A
 *   flaky-looking pass is worse than an honest fail here, so failures stand.
 * - **`projects` is unset.** A project list would imply a browser channel; there is none. The
 *   suite's only "device" is Electron.
 *
 * Artefacts: traces and screenshots are retained on failure. Note that `use.trace` /
 * `use.screenshot` only apply to fixtures Playwright itself creates — an `ElectronApplication`
 * launched inside a test is not one of those, so `e2e/service-day.spec.ts` starts tracing on the
 * Electron context by hand and attaches a screenshot itself when a test fails. The values below
 * still apply to anything the harness does create, and they document the intent in one place.
 */

import { defineConfig } from '@playwright/test'

/** Is this running on CI? Only used to tighten `forbidOnly` and the reporter. */
const isCI = process.env.CI !== undefined && process.env.CI !== ''

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,

  // Launching Electron, waiting for the overlay server to bind, and then walking eight screens is
  // comfortably slower than a web test. 3 minutes is generous on purpose: a timeout that fires
  // during a slow cold start teaches nothing.
  timeout: 180_000,

  expect: {
    // Long enough to cover an IPC round trip plus a WebSocket broadcast to the overlay page, short
    // enough that a genuinely stuck assertion fails inside a coffee break.
    timeout: 20_000,
  },

  // One app, one port, one instance. See the note above.
  workers: 1,
  fullyParallel: false,

  retries: 0,
  forbidOnly: isCI,

  // `list` prints each step as it happens, which is what you want while watching an app launch.
  // The HTML report is written but never auto-served: opening a browser at the end of a headless
  // run is a surprise, not a feature.
  //
  // The folder names are Playwright's defaults on purpose: `.gitignore` already carries
  // `playwright-report/`, `test-results/` and `blob-report/`. Renaming them to something prettier
  // would mean either editing `.gitignore` or committing megabytes of traces by accident.
  reporter: isCI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['github']]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  outputDir: './test-results',

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // A click that cannot find its target inside 15s is a broken selector, not a slow machine.
    actionTimeout: 15_000,
  },
})
