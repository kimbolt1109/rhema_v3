/**
 * Verger — the service-day end-to-end walkthrough.
 *
 * This is the only test in the repo that runs the **real built app**: `out/main/index.js` launched
 * as a genuine Electron process, its real preload bridge, its real main-process services, its real
 * overlay HTTP + WebSocket server, and its real React renderer. Every other suite in the project
 * injects fakes at some seam. This one injects nothing.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS MACHINE CAN AND CANNOT PROVE
 * ---------------------------------------------------------------------------------------------
 *
 * The build prompt asks for "connect OBS → import deck → GO LIVE → ASR feed → cue → END". On this
 * machine three of those five are impossible, and pretending otherwise would produce a green test
 * that proves nothing:
 *
 * - **OBS Studio is not installed.** There is no obs-websocket to connect to, no scene to switch
 *   to, and no stream or recording to start.
 * - **There are no Google credentials and none are coming**, so no YouTube broadcast can be
 *   created, bound or transitioned.
 * - **There is no Deepgram key**, and driving the local faster-whisper sidecar through a real
 *   sermon is an accuracy question, not an integration one.
 * - **LibreOffice is not installed**, so the deck importer honestly reports itself unavailable and
 *   there is no conversion to drive.
 *
 * So this suite proves the two things that genuinely are end-to-end here, and then deliberately
 * asserts the *not-configured* paths for everything else:
 *
 * 1. **The overlay path works for real, all the way through.** Renderer → preload IPC → main
 *    process → overlay HTTP server → WebSocket → a second, actual Chromium page rendering
 *    `overlay.html` exactly as an OBS Browser Source would. Text typed into the control window
 *    appears in the other page's DOM. That is the whole browser-source contract, minus OBS's
 *    compositor.
 * 2. **The app degrades correctly rather than obscurely.** Every subsystem that cannot work on
 *    this machine says so in words, disables its own controls, and explains what to do — and the
 *    ones that *can* work keep working alongside it. An app that degrades correctly is the thing
 *    this build can actually demonstrate, so it is asserted properly rather than skipped.
 *
 * Anything asserted below has been observed. Anything that could not be observed is named in the
 * "cannot be exercised" section of `e2e/README.md` rather than quietly omitted.
 *
 * ---------------------------------------------------------------------------------------------
 * MECHANICS
 * ---------------------------------------------------------------------------------------------
 *
 * - **No browser download.** `_electron.launch()` drives the Electron binary already in
 *   `node_modules`. `npx playwright install` is not a prerequisite.
 * - **One app for the whole file, `mode: 'serial'`.** This is a walkthrough of one service, in
 *   order; a fresh launch per test would cost a minute each and would also mean four processes
 *   racing for port 7320. When a step fails the rest are skipped, which is the honest reading —
 *   you cannot fire a cue in an app that never rendered.
 * - **The UI language is pinned to English.** i18next detects from `navigator` and this app ships
 *   a complete Korean bundle, so on a Korean-locale machine every string assertion below would
 *   fail for the wrong reason. `--lang=en-US` plus the app's own `localStorage` key both point at
 *   `en`, and the first test asserts an English string so a failure of the pinning is loud.
 * - **Selectors prefer `data-testid` and ARIA roles over CSS.** Class names here are Tailwind
 *   utilities and will churn.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ElectronApplication, Page } from '@playwright/test'
import { _electron as electron, expect, test } from '@playwright/test'

// ------------------------------------------------------------------------------------------- //
// Build discovery
// ------------------------------------------------------------------------------------------- //

/**
 * Repo root — this file lives in `<root>/e2e/`.
 *
 * `path.resolve` is not decoration: `fileURLToPath` returns a *directory* path with a trailing
 * separator, and on Windows Playwright builds the Electron command line by wrapping each argument
 * in double quotes. `"C:\...\rhema_v3\"` ends in `\"`, which the shell reads as an escaped quote —
 * the app path is mangled, Electron never finds a `package.json`, and the launch times out with no
 * useful message. `path.resolve` drops the trailing separator.
 */
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The packaged main-process entry point. `package.json#main` points here. */
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

const isBuilt = existsSync(mainEntry)

const NOT_BUILT_MESSAGE = [
  `The built app was not found at ${mainEntry}.`,
  'This suite drives the real app, not a dev server, so there is nothing to launch.',
  'Run `npm run build` first, then `npm run test:e2e`.',
].join(' ')

// The `list` reporter prints "skipped" without the reason, and a silent skip is how a suite ends
// up never running for a month. Say it once, on stderr, where it cannot be missed.
if (!isBuilt) console.warn(`\n[e2e] SKIPPING: ${NOT_BUILT_MESSAGE}\n`)

// ------------------------------------------------------------------------------------------- //
// Constants shared with the app
// ------------------------------------------------------------------------------------------- //

/*
 * Deliberately typed out rather than imported from `@shared/net`.
 *
 * The point of this file is to check the app from the outside, the way an operator pasting a URL
 * into OBS does. Importing `OVERLAY_SERVER_PORT` would make the test agree with the code by
 * construction: if somebody changed the port, the test would follow it and the docs, the OBS
 * scene collection and every church's existing browser source would silently be the only things
 * left wrong. A literal here fails loudly, which is the correct outcome.
 */
const OVERLAY_ORIGIN = 'http://127.0.0.1:7320'
const OVERLAY_PAGE_URL = `${OVERLAY_ORIGIN}/overlay`

/** Placeholder operator text. Nothing here is copyrighted, quoted, or scripture. */
const LOWER_THIRD_LINE_1 = 'PLACEHOLDER SPEAKER'
const LOWER_THIRD_LINE_2 = 'End-to-end rehearsal'

// ------------------------------------------------------------------------------------------- //
// Suite
// ------------------------------------------------------------------------------------------- //

test.describe.configure({ mode: 'serial' })

test.describe('service day — the real app, end to end', () => {
  test.skip(!isBuilt, NOT_BUILT_MESSAGE)

  let app: ElectronApplication
  let page: Page
  /** The second page: `overlay.html` rendered exactly as an OBS Browser Source would render it. */
  let overlayPage: Page | null = null
  /** Set by `afterEach` so `afterAll` only keeps the trace when it is worth reading. */
  let anyFailure = false

  test.beforeAll(async () => {
    // Build a plain string env: `process.env` is `string | undefined`-valued and Playwright wants
    // definite values.
    const launchEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) launchEnv[key] = value
    }
    // The renderer's CSP is strict and correct; Electron's dev-time nag about it is noise here.
    launchEnv.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

    app = await electron.launch({
      // `--lang` first: Electron takes the first non-switch argument as the app directory.
      args: ['--lang=en-US', repoRoot],
      cwd: repoRoot,
      env: launchEnv,
      timeout: 60_000,
    })

    // Tracing has to be started by hand. `use.trace` in playwright.config.ts applies to contexts
    // the harness creates; an ElectronApplication launched inside a test is not one of those.
    await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })

    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Pin the operator UI to English. `--lang=en-US` already biases the detector; this makes it
    // deterministic even if the OS locale wins somewhere unexpected. `verger-locale` is the app's
    // own `LOCALE_STORAGE_KEY`.
    await page.evaluate(() => {
      try {
        window.localStorage.setItem('verger-locale', 'en')
      } catch {
        // A storage-less origin is survivable — `--lang` still applies and the first assertion
        // below will say so plainly if neither worked.
      }
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return
    anyFailure = true
    // A screenshot of the control window at the moment of failure. `use.screenshot` does not cover
    // Electron pages, so it is attached explicitly.
    const shot = await page.screenshot().catch(() => null)
    if (shot !== null) {
      await testInfo.attach('control-window', { body: shot, contentType: 'image/png' })
    }
    const overlay = overlayPage
    if (overlay !== null && !overlay.isClosed()) {
      const overlayShot = await overlay.screenshot().catch(() => null)
      if (overlayShot !== null) {
        await testInfo.attach('overlay-page', { body: overlayShot, contentType: 'image/png' })
      }
    }
  })

  test.afterAll(async () => {
    if (app === undefined) return
    // `retain-on-failure`, done by hand: a trace is a few MB and nobody opens the one from a green
    // run. Stopping without a path discards it.
    const tracePath = path.join(repoRoot, 'test-results', 'service-day.trace.zip')
    await app
      .context()
      .tracing.stop(anyFailure ? { path: tracePath } : {})
      .catch(() => undefined)
    await app.close().catch(() => undefined)
  })

  // ----------------------------------------------------------------------------------------- //

  test('1 · launches, opens a window, and renders the operator shell', async () => {
    await expect(page).toHaveTitle('Verger')

    // The three pieces of chrome the shell promises: title bar, health strip, section tabs.
    await expect(page.getByRole('banner')).toContainText('Verger')
    await expect(page.getByTestId('status-strip')).toBeVisible()

    // 12 sections: connection, camera, overlay, plan, transcript, automation, goLive, status,
    // goLiveSettings, cameraSetup, asrSettings, shortcuts.
    //
    // An exact count on purpose. It is deliberately brittle so that a section silently
    // disappearing from the nav — or being added and never wired, which is exactly what happened
    // to ShortcutSettings in Phase 10 — fails here rather than going unnoticed.
    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(12)

    // If locale pinning failed, this is where it says so rather than three tests later.
    await expect(page.getByRole('tab', { name: 'Connection' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Cameras' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Overlay' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Status' })).toBeVisible()

    // The renderer really is talking to the main process: version strings only exist if the
    // preload bridge loaded and `app.getVersions` answered.
    await expect(page.getByRole('banner')).toContainText(/Electron \d+\./)

    // The main window is the *only* window at this point. Anything else would mean a stray
    // devtools or a second instance, and every later assertion would be ambiguous.
    expect(app.windows()).toHaveLength(1)
  })

  test('2 · the overlay server is live and serves its page over HTTP', async () => {
    // Fetched from the test process, over the loopback interface, exactly as OBS would. This is
    // the one piece of Verger that genuinely works end-to-end on this machine.
    const response = await fetch(OVERLAY_PAGE_URL)
    expect(response.status).toBe(200)

    const body = await response.text()
    // The three independent layers BLUEPRINT.md §6 requires, present in the served markup.
    expect(body).toContain('id="lower-third"')
    expect(body).toContain('id="scripture"')
    expect(body).toContain('id="slide"')

    // The documented paste-into-OBS URL is `/overlay`, and the server answers it with a 301 to
    // `/overlay/`, which serves the page. That is fine — an OBS Browser Source is Chromium and
    // follows it — but it is asserted explicitly rather than glossed over, because the redirect
    // must stay on loopback. A browser source that could be bounced to another host would be a
    // hole in Standing Rule 7, and the final URL below is what proves it does not.
    const withoutRedirect = await fetch(OVERLAY_PAGE_URL, { redirect: 'manual' })
    await withoutRedirect.arrayBuffer()
    expect([200, 301, 302, 307, 308]).toContain(withoutRedirect.status)
    expect(new URL(response.url).origin).toBe(OVERLAY_ORIGIN)

    // The control window agrees the server is up, rather than the test being the only witness.
    await page.getByRole('tab', { name: 'Overlay' }).click()
    const serverPanel = page.getByRole('region', { name: 'Overlay server' })
    await expect(serverPanel).toContainText('Running')
    await expect(serverPanel).toContainText(OVERLAY_PAGE_URL)
  })

  test('3 · the Connection screen reports OBS as NOT CONFIGURED, with guidance', async () => {
    await page.getByRole('tab', { name: 'Connection' }).click()

    // OBS Studio is not installed on this machine and no OBS_WEBSOCKET_URL exists, so
    // "not configured" is the correct end-to-end behaviour to assert. A connection here would be
    // the bug.
    await expect(page.getByRole('heading', { name: 'OBS connection' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'OBS connection' })).toContainText(
      'Not configured',
    )

    // Guidance, not a dead end: what to install, where the setting lives, and where the full
    // checklist is.
    const guidance = page.getByText('OBS is not set up yet')
    await expect(guidance).toBeVisible()
    const callout = page.locator('section', { has: guidance })
    await expect(callout.first()).toContainText('OBS Studio 30 or newer')
    await expect(callout.first()).toContainText('WebSocket Server Settings')
    await expect(callout.first()).toContainText('HUMAN_TASKS.md')

    // The form is still there and still usable — not configured means "nothing to dial", not
    // "controls removed".
    await expect(page.getByRole('form', { name: 'OBS connection settings' })).toBeVisible()
    // `getByRole('textbox', …)` rather than `getByLabel(…)`: the OBS health light carries an
    // `aria-label` that also mentions the WebSocket address, and a label-only query matches both.
    await expect(page.getByRole('textbox', { name: 'OBS WebSocket address' })).toBeEditable()
  })

  test('4 · a lower third fired in the control window appears in the overlay page', async () => {
    // Open the overlay URL in a second real Chromium page. This is what an OBS Browser Source is,
    // minus the compositing — same engine, same origin, same WebSocket.
    const windowPromise = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const win = new BrowserWindow({
        width: 1280,
        height: 720,
        show: true,
        // A browser source is never "occluded" in OBS; make sure Chromium does not throttle the
        // socket here either.
        webPreferences: { backgroundThrottling: false },
      })
      await win.loadURL(url)
      return win.id
    }, `${OVERLAY_PAGE_URL}?debug=1`)

    overlayPage = await windowPromise
    await overlayPage.waitForLoadState('domcontentloaded')

    // `?debug=1` reveals the page's own HUD. `open` means the WebSocket actually attached and the
    // server pushed the opening snapshot — the state-based resync contract from Phase 2.
    await expect(overlayPage.locator('#debug-status')).toHaveText('open')
    await expect(overlayPage.locator('#lower-third')).toHaveAttribute('aria-hidden', 'true')

    // The revision before we touch anything, so the assertion below proves a *change*.
    const revisionBefore = Number(await overlayPage.locator('#debug-revision').textContent())
    expect(Number.isFinite(revisionBefore)).toBe(true)

    // --- fire it from the control window -----------------------------------------------------
    await page.getByRole('tab', { name: 'Overlay' }).click()
    await page.locator('#overlay-lower-third-line1').fill(LOWER_THIRD_LINE_1)
    await page.locator('#overlay-lower-third-line2').fill(LOWER_THIRD_LINE_2)
    await page.getByRole('button', { name: 'Show lower third' }).click()

    // --- and assert it arrived in the other page ---------------------------------------------
    // renderer → preload IPC → main → overlay server → WebSocket → browser source DOM.
    await expect(overlayPage.locator('#lower-third-line1')).toHaveText(LOWER_THIRD_LINE_1)
    await expect(overlayPage.locator('#lower-third-line2')).toHaveText(LOWER_THIRD_LINE_2)
    await expect(overlayPage.locator('#lower-third')).toHaveAttribute('aria-hidden', 'false')
    await expect(overlayPage.locator('#lower-third')).toHaveClass(/is-visible/)

    const revisionAfter = Number(await overlayPage.locator('#debug-revision').textContent())
    expect(revisionAfter).toBeGreaterThan(revisionBefore)

    // The layers are independent (BLUEPRINT.md §6): showing a lower third touched neither of the
    // other two.
    await expect(overlayPage.locator('#scripture')).toHaveAttribute('aria-hidden', 'true')
    await expect(overlayPage.locator('#slide')).toHaveAttribute('aria-hidden', 'true')

    // The control window's own readout agrees with what is on screen.
    await expect(page.getByRole('region', { name: 'On screen now' })).toContainText('Visible')

    // --- and hide it again, so the path is proven in both directions -------------------------
    await page.getByRole('button', { name: 'Hide lower third' }).click()
    await expect(overlayPage.locator('#lower-third')).toHaveAttribute('aria-hidden', 'true')

    // Leave the booth tidy: close the browser source. The main window stays open, so the app does
    // not quit.
    await overlayPage.close()
    overlayPage = null
  })

  test('5 · the Camera panel is disabled and says why (no OBS on this machine)', async () => {
    await page.getByRole('tab', { name: 'Cameras' }).click()

    await expect(page.getByRole('heading', { name: 'Cameras' })).toBeVisible()

    // The reason is stated in words, before the operator finds out by pressing something dead.
    await expect(page.getByText('Not connected to OBS')).toBeVisible()
    await expect(page.getByText('Camera switching needs a live obs-websocket connection')).toBeVisible()

    // All four slots, all disabled. `data-slot` is the stable hook; the labels are operator-
    // configurable and the colours are not assertions.
    for (const slot of ['cam1', 'cam2', 'wide', 'pulpit']) {
      const button = page.locator(`button[data-slot="${slot}"]`)
      await expect(button).toBeVisible()
      await expect(button).toBeDisabled()
    }

    // Nothing is claimed to be live, and OBS's program scene is honestly "not reported yet"
    // rather than a stale guess.
    await expect(page.getByRole('status')).toContainText('None of these four buttons is live.')
    await expect(page.getByTestId('camera-program-scene')).toHaveText('Not reported yet')
  })

  test('6 · a cue added in the Plan editor appears, and survives a renderer reload', async () => {
    await page.getByRole('tab', { name: 'Plan' }).click()
    await expect(page.getByRole('heading', { name: 'Service plan' })).toBeVisible()

    const cueList = page.getByTestId('cue-list')
    const before = await cueList.locator('> li').count()

    await page.locator('#new-cue-type').selectOption('lowerthird')
    await page.getByTestId('plan-add-cue').click()

    await expect(cueList.locator('> li')).toHaveCount(before + 1)

    // `CueRow` renders the `<li>` itself, so the id is on the row, not on a descendant.
    const newRow = cueList.locator('> li').nth(before)
    const cueId = await newRow.getAttribute('data-cue-id')
    expect(cueId).not.toBeNull()
    await expect(page.getByTestId(`cue-row-${cueId ?? ''}`)).toContainText('Lower third')

    // Persistence, properly. Reloading the renderer destroys every zustand store, so a cue that
    // is still there afterwards can only have come back from the main process over IPC — which
    // is where the plan actually lives. Merely switching tabs would have proven nothing: the
    // stores are module-scoped and outlive an unmounted panel.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('tab', { name: 'Plan' }).click()

    await expect(page.getByTestId('cue-list').locator('> li')).toHaveCount(before + 1)
    await expect(page.getByTestId(`cue-row-${cueId ?? ''}`)).toBeVisible()

    // The deck importer is honest about LibreOffice being absent rather than offering a button
    // that fails. This is the correct behaviour on this machine, so it is asserted, not skipped.
    await expect(page.getByTestId('importer-unavailable')).toBeVisible()
    await expect(page.getByTestId('plan-import')).toBeDisabled()
  })

  test('7 · GO LIVE is blocked with a stated reason, not an obscure failure', async () => {
    // `exact` matters: there is also a "Go Live settings" tab, and the accessible-name match is
    // substring-and-case-insensitive by default.
    await page.getByRole('tab', { name: 'GO LIVE', exact: true }).click()

    const goLive = page.getByTestId('go-live-button')
    await expect(goLive).toBeVisible()
    await expect(goLive).toBeDisabled()

    // Why, in a sentence, next to the button. Without OBS there is nothing to stream or record,
    // and that is what it says.
    const reason = page.getByTestId('go-live-disabled-reason')
    await expect(reason).toBeVisible()
    await expect(reason).toContainText('not connected to OBS')

    // Nothing is live and nothing is recording, and both say so in words rather than by colour.
    await expect(page.getByTestId('live-indicator')).toContainText('NOT LIVE')
    await expect(page.getByTestId('recording-indicator')).toContainText('NOT RECORDING')

    // YouTube has no credentials on this machine. The panel states exactly what GO LIVE would and
    // would not do in that state instead of failing at the fifth step mid-service.
    await expect(
      page.getByText('YouTube is not set up — GO LIVE will stream and record, but publish nothing'),
    ).toBeVisible()
    await expect(page.getByText('What GO LIVE will still do')).toBeVisible()
    await expect(page.getByText('What GO LIVE will not do')).toBeVisible()
  })

  test('8 · the Status dashboard renders every health light with a text label', async () => {
    await page.getByRole('tab', { name: 'Status' }).click()

    await expect(page.getByRole('heading', { name: 'Subsystem status' })).toBeVisible()

    // Scoped to the dashboard's own section: the always-on strip at the top of the shell renders
    // the same seven lights, and an unscoped locator would be ambiguous.
    const lights = page.locator('section[aria-label="Subsystem lights"]')
    await expect(lights).toBeVisible()

    const subsystems = ['obs', 'overlay', 'asr', 'youtube', 'recording', 'stream', 'automation']
    for (const id of subsystems) {
      const light = lights.locator(`[data-subsystem="${id}"]`)
      await expect(light).toBeVisible()
      // Colour is never the only signal — every light carries its level as words.
      const label = light.locator(`[data-testid="health-level-${id}"]`)
      await expect(label).toBeVisible()
      await expect(label).not.toBeEmpty()
      // And a machine-readable level, so a failure names the state rather than the pixel.
      await expect(light).toHaveAttribute('data-health-level', /.+/)
    }

    // The one question that matters mid-service, answered in plain words. Nothing is streaming or
    // recording on this machine, so the honest answer is "no".
    const answer = page.getByTestId('service-answer')
    await expect(answer).toBeVisible()
    await expect(answer).toHaveAttribute('data-going-out', 'false')
    await expect(answer).toContainText('No — nothing is going out right now.')

    // The overlay light proves the two halves of this suite agree: the same server the test
    // fetched over HTTP in step 2 is the one the dashboard is reporting on.
    await expect(lights.locator('[data-subsystem="overlay"]')).not.toHaveAttribute(
      'data-health-level',
      'down',
    )
  })
})
