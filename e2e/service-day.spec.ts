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
 * - **Deck conversion depends on the machine.** A bare box has neither PowerPoint nor LibreOffice and
 *   the importer honestly reports itself unavailable; this dev box has PowerPoint, installed to
 *   render the church's real decks, and it reports available. The suite therefore asserts that the
 *   notice and the Import button AGREE with each other, rather than asserting which machine it is on.
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
// Navigation
// ------------------------------------------------------------------------------------------- //

/*
 * Everything that is not the live service now lives behind one gear button.
 *
 * The console used to be thirteen tabs across the top of the shell, and this suite clicked them
 * directly. After the TASK 2 redesign the operating surface is the slide grid and the bottom bar,
 * and those thirteen sections are inside a slide-over drawer — so every step below opens the drawer
 * first. Routing that through two helpers rather than repeating it keeps the diff honest about what
 * actually changed: the *navigation*, not the assertions.
 */

/** Open the setup drawer if it is not already open. Idempotent — the console is `inert` while open. */
async function openDrawer(page: Page): Promise<void> {
  const drawer = page.getByTestId('settings-drawer')
  if (await drawer.isVisible()) return
  await page.getByTestId('bottom-bar-settings').click()
  await expect(drawer).toBeVisible()
}

/** Open the drawer and select one section by its visible name. */
async function gotoSection(page: Page, name: string): Promise<void> {
  await openDrawer(page)
  await page.getByRole('tab', { name, exact: true }).click()
}

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
    //
    // `verger.preflightSeen` is pinned for the same reason. Verger opens the setup drawer on
    // Preflight the first time it runs on a machine, and this suite is about the *operating*
    // surface — so the marker is set deliberately here rather than left to depend on whether some
    // earlier run happened to write it. Test 1 asserts the drawer really is shut as a result.
    await page.evaluate(() => {
      try {
        window.localStorage.setItem('verger-locale', 'en')
        window.localStorage.setItem('verger.preflightSeen', '1')
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

  test('1 · launches and renders the operating surface: a slide grid and one bar', async () => {
    await expect(page).toHaveTitle('Verger')

    // The whole surface, and nothing else. The redesign deleted the title bar, the health strip and
    // the thirteen-tab nav, so their ABSENCE is asserted as carefully as the grid's presence:
    // "cluttered" was the problem being fixed, and a panel creeping back onto this surface is
    // exactly the kind of regression nobody notices until they are operating in the dark.
    await expect(page.getByRole('region', { name: 'Slide grid' })).toBeVisible()
    await expect(page.getByTestId('bottom-bar')).toBeVisible()
    await expect(page.getByRole('banner')).toHaveCount(0)
    await expect(page.getByTestId('status-strip')).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(page.getByTestId('settings-drawer')).toHaveCount(0)

    // No plan is open on this machine, and the grid says so in words rather than showing an empty
    // rectangle. (If locale pinning failed, this is where it says so rather than three tests later.)
    await expect(page.getByText('No service plan is open.')).toBeVisible()

    // The bar is honest with nothing configured. No ASR means no pending suggestion, which means
    // there is no confidence to report — so an em dash and an empty fill, never a misleading 0%.
    await expect(page.getByTestId('bottom-bar-percent')).toHaveText('—')
    await expect(page.getByTestId('bottom-bar-progress')).toHaveAttribute('data-percent', '')

    /*
     * The tally is asserted for COHERENCE, not for one value, because it legitimately depends on the
     * machine now. Verger reads OBS's own WebSocket settings and connects at launch, so:
     *
     *  - no OBS installed          -> nothing discovered, nothing dialled  -> offline
     *  - OBS installed, not running -> dialling and retrying               -> transitioning
     *  - OBS installed and running  -> connected                          -> offline until streaming
     *
     * Pinning `offline` here pinned "OBS is absent from this developer's laptop", which is not a fact
     * about the product. What must hold on every machine is that the dot and the words agree — a dot
     * saying one thing while the text beside it says another is the actual defect.
     */
    const tally = await page.getByTestId('bottom-bar').getAttribute('data-tally')
    expect(['offline', 'transitioning']).toContain(tally)

    const obsWords = (await page.getByTestId('bottom-bar-obs').textContent()) ?? ''
    if (tally === 'offline') {
      // Nothing in flight: either OBS was never configured, or it answered and is simply not live.
      expect(obsWords).toMatch(/Not configured|Connected|Idle|Disconnected/i)
    } else {
      // Amber means something is genuinely in progress, and the words have to say so too.
      expect(obsWords).toMatch(/Connecting|Reconnecting/i)
    }

    // Streaming is never in progress at launch on a test machine, whatever OBS is doing.
    await expect(page.getByTestId('bottom-bar')).not.toHaveAttribute('data-tally', 'live')

    // The main window is the *only* window at this point. Anything else would mean a stray
    // devtools or a second instance, and every later assertion would be ambiguous.
    expect(app.windows()).toHaveLength(1)
  })

  test('1b · the setup drawer holds all thirteen sections, and Esc closes it', async () => {
    await page.getByTestId('bottom-bar-settings').click()
    const drawer = page.getByTestId('settings-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer).toHaveAttribute('aria-modal', 'true')

    // 13 sections: preflight, connection, camera, overlay, plan, transcript, automation, goLive,
    // status, goLiveSettings, cameraSetup, asrSettings, shortcuts.
    //
    // An exact count on purpose. It is deliberately brittle so that a section silently
    // disappearing from the nav — or being added and never wired, which is exactly what happened
    // to ShortcutSettings in Phase 10 — fails here rather than going unnoticed.
    await expect(page.getByRole('tab')).toHaveCount(13)
    for (const name of ['Preflight', 'Connection', 'Cameras', 'Overlay', 'Status', 'Shortcuts']) {
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible()
    }

    // The renderer really is talking to the main process: version strings only exist if the preload
    // bridge loaded and `app.getVersions` answered. They live here now rather than in the deleted
    // title bar, because they are the first thing anybody asks for in a bug report.
    await expect(drawer).toContainText(/Electron \d+\./)

    // Esc closes it, and closing unmounts it rather than merely hiding it — several of these
    // screens own IPC subscriptions.
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
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
    await gotoSection(page, 'Overlay')
    const serverPanel = page.getByRole('region', { name: 'Overlay server' })
    await expect(serverPanel).toContainText('Running')
    await expect(serverPanel).toContainText(OVERLAY_PAGE_URL)
  })

  test('3 · the Connection screen reports OBS as NOT CONFIGURED, with guidance', async () => {
    await gotoSection(page, 'Connection')

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
    await gotoSection(page, 'Overlay')
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
    await gotoSection(page, 'Cameras')

    // Scoped to the drawer, because there are now legitimately TWO sets of camera buttons: these,
    // and the four on the bottom bar. Both carry `data-slot`, and both are correctly disabled with
    // no OBS — so an unscoped locator matches two elements and Playwright refuses it. Asserting on
    // the panel's own set keeps this test about the panel.
    const drawer = page.getByTestId('settings-drawer')

    await expect(drawer.getByRole('heading', { name: 'Cameras' })).toBeVisible()

    // The reason is stated in words, before the operator finds out by pressing something dead.
    await expect(drawer.getByText('Not connected to OBS')).toBeVisible()
    await expect(
      drawer.getByText('Camera switching needs a live obs-websocket connection'),
    ).toBeVisible()

    // All four slots, all disabled. `data-slot` is the stable hook; the labels are operator-
    // configurable and the colours are not assertions.
    for (const slot of ['cam1', 'cam2', 'wide', 'pulpit']) {
      const button = drawer.locator(`button[data-slot="${slot}"]`)
      await expect(button).toBeVisible()
      await expect(button).toBeDisabled()
    }

    // Nothing is claimed to be live, and OBS's program scene is honestly "not reported yet"
    // rather than a stale guess.
    await expect(drawer.getByRole('status')).toContainText('None of these four buttons is live.')
    await expect(drawer.getByTestId('camera-program-scene')).toHaveText('Not reported yet')

    // And the bar's own four are disabled for the same reason — the control the operator actually
    // reaches for mid-service must not look pressable when it cannot work.
    for (const slot of ['cam1', 'cam2', 'wide', 'pulpit']) {
      await expect(page.getByTestId('bottom-bar').locator(`button[data-slot="${slot}"]`)).toBeDisabled()
    }
  })

  test('6 · a cue added in the Plan editor reaches the grid, and survives a renderer reload', async () => {
    await gotoSection(page, 'Plan')

    // Scoped to the drawer throughout. The grid's empty state is headed "No service plan is open.",
    // and Playwright's accessible-name match is substring-and-case-insensitive by default — so an
    // unscoped query for "Service plan" matches the grid's heading as well as the editor's.
    const drawer = page.getByTestId('settings-drawer')
    await expect(drawer.getByRole('heading', { name: 'Service plan', exact: true })).toBeVisible()

    const cueList = drawer.getByTestId('cue-list')
    const before = await cueList.locator('> li').count()

    await drawer.locator('#new-cue-type').selectOption('lowerthird')
    await drawer.getByTestId('plan-add-cue').click()

    await expect(cueList.locator('> li')).toHaveCount(before + 1)

    // `CueRow` renders the `<li>` itself, so the id is on the row, not on a descendant.
    const newRow = cueList.locator('> li').nth(before)
    const cueId = await newRow.getAttribute('data-cue-id')
    expect(cueId).not.toBeNull()
    await expect(drawer.getByTestId(`cue-row-${cueId ?? ''}`)).toContainText('Lower third')

    // --- and now the part the redesign added ---------------------------------------------------
    // Close the drawer and the cue must be ON THE OPERATING SURFACE as a tile. This is the whole
    // premise of the new UI: the grid is not a view of the plan kept in sync by hand, it IS the
    // plan. Before this, the plan lived in a tab and nothing proved the live surface ever saw it —
    // Phase 6's `PlanRunner` was fully unit-tested and never mounted anywhere at all.
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(page.getByText('No service plan is open.')).toHaveCount(0)
    await expect(page.locator(`li[data-cue-id="${cueId ?? ''}"]`)).toBeVisible()
    // A lower-third cue has no picture to show, so its tile shows the label instead of an image.
    await expect(
      page.locator(`li[data-cue-id="${cueId ?? ''}"] [data-testid="slide-tile-image"]`),
    ).toHaveCount(0)

    // Persistence, properly. Reloading the renderer destroys every zustand store, so a cue that
    // is still there afterwards can only have come back from the main process over IPC — which
    // is where the plan actually lives. Merely switching tabs would have proven nothing: the
    // stores are module-scoped and outlive an unmounted panel.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')

    // Asserted on the grid FIRST, before reopening the drawer: the operating surface has to come
    // back populated on its own, without anybody visiting a settings screen to wake it up.
    await expect(page.locator(`li[data-cue-id="${cueId ?? ''}"]`)).toBeVisible()

    await gotoSection(page, 'Plan')
    await expect(drawer.getByTestId('cue-list').locator('> li')).toHaveCount(before + 1)
    await expect(drawer.getByTestId(`cue-row-${cueId ?? ''}`)).toBeVisible()

    // Whether a deck can be converted is a fact about the MACHINE, not about the app — this dev box
    // has PowerPoint installed and a bare CI box has neither it nor LibreOffice. So assert the two
    // states are COHERENT rather than asserting which one we happen to be in. Both incoherent
    // combinations are the real bug: an "unavailable" notice beside an enabled Import button offers
    // something that cannot work, and a missing notice beside a disabled button gives the operator a
    // dead control with no explanation.
    //
    // (This assertion previously hard-coded "unavailable". It stopped being true the day PowerPoint
    // was installed to render the church's real decks, which is exactly the kind of environment
    // assumption that should never have been a bare assertion.)
    const importerUnavailable = await drawer.getByTestId('importer-unavailable').count()
    if (importerUnavailable > 0) {
      await expect(drawer.getByTestId('plan-import')).toBeDisabled()
    } else {
      await expect(drawer.getByTestId('plan-import')).toBeEnabled()
    }
  })

  test('7 · GO LIVE is blocked with a stated reason, not an obscure failure', async () => {
    // `exact` matters: there is also a "Go Live settings" tab, and the accessible-name match is
    // substring-and-case-insensitive by default. `gotoSection` passes `exact: true` for this reason.
    await gotoSection(page, 'GO LIVE')

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
    await gotoSection(page, 'Status')

    await expect(page.getByRole('heading', { name: 'Subsystem status' })).toBeVisible()

    // Still scoped to the dashboard's own section. The always-on strip that used to duplicate these
    // seven lights at the top of the shell is gone — the bottom bar answers "is it going out?" now —
    // so this is no longer ambiguous, but scoping keeps the assertion about the dashboard.
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

  test('9 · a keyboard-focused control really carries the one 2px chalk outline', async () => {
    // The companion to the drift guard in `src/renderer/styles/typography.test.ts`. That test
    // proves no component re-declares a ring; this one proves the single global rule it now
    // depends on actually paints — measured on a real control in the packaged app, with the real
    // stylesheet loaded. Between them, a control cannot ship ringless: it can no longer suppress
    // the outline locally, and if the global rule were deleted this test goes red.
    //
    // `:focus-visible` deliberately does NOT engage for a mouse click, so the focus has to come
    // from the keyboard — which is also the operator who actually needs the ring.
    await page.keyboard.press('Tab')

    const ring = await page.evaluate(() => {
      const el = document.activeElement
      if (el === null || el === document.body) return null
      const style = getComputedStyle(el)
      return {
        tag: el.tagName,
        focusVisible: el.matches(':focus-visible'),
        width: style.outlineWidth,
        style: style.outlineStyle,
        colour: style.outlineColor,
        offset: style.outlineOffset,
      }
    })

    expect(ring, 'Tab moved focus to a real control').not.toBeNull()
    expect(ring?.focusVisible).toBe(true)
    expect(ring?.width).toBe('2px')
    expect(ring?.style).toBe('solid')
    expect(ring?.offset).toBe('2px')
    // CHALK (--color-ring: 201 199 192), not a hue. A focus ring answers "where is my keyboard";
    // spending a saturated colour on it would put a decorative hue beside a red tally lamp.
    expect(ring?.colour).toBe('rgb(201, 199, 192)')
  })

  test('10 · a caption reaches the browser source, and the OFF switch really clears it', async () => {
    // The test that would have caught the bug this feature shipped with. `src/overlay/protocol.js`
    // is a hand-kept mirror of the shared protocol and its normaliser builds an explicit literal —
    // it dropped `caption` entirely, so the layer could never render. Nothing failed; captions were
    // simply always blank. Only driving the real page over the real socket shows that.
    const windowPromise = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const win = new BrowserWindow({
        width: 1280,
        height: 720,
        show: true,
        webPreferences: { backgroundThrottling: false },
      })
      await win.loadURL(url)
      return win.id
    }, `${OVERLAY_PAGE_URL}?debug=1`)

    overlayPage = await windowPromise
    await overlayPage.waitForLoadState('domcontentloaded')
    await expect(overlayPage.locator('#debug-status')).toHaveText('open')
    await expect(overlayPage.locator('#caption')).toHaveAttribute('aria-hidden', 'true')

    // --- the operator switches captions on, in the UI they would actually use ------------------
    await gotoSection(page, 'Overlay')
    const status = page.getByTestId('caption-status')
    await expect(status).toHaveAttribute('data-caption-enabled', 'false')
    await page.getByTestId('caption-toggle').click()
    await expect(status).toHaveAttribute('data-caption-enabled', 'true')

    // --- put a caption on the layer -----------------------------------------------------------
    // Sent through the overlay bridge rather than spoken: there is no recogniser on this machine, and
    // the path under test is protocol -> server -> socket -> page, which is the half that was broken.
    // The text is an invented placeholder — Standing Rule 4.
    const CAPTION_TEXT = 'PLACEHOLDER SPOKEN LINE'
    await page.evaluate(async (text) => {
      await window.verger?.overlay.send({
        channel: 'command',
        name: 'caption.show',
        payload: { text, draft: false },
      })
    }, CAPTION_TEXT)

    await expect(overlayPage.locator('#caption-text')).toHaveText(CAPTION_TEXT)
    await expect(overlayPage.locator('#caption')).toHaveAttribute('aria-hidden', 'false')

    // Layer independence (BLUEPRINT.md §6): a caption touched none of the other three.
    await expect(overlayPage.locator('#lower-third')).toHaveAttribute('aria-hidden', 'true')
    await expect(overlayPage.locator('#scripture')).toHaveAttribute('aria-hidden', 'true')
    await expect(overlayPage.locator('#slide')).toHaveAttribute('aria-hidden', 'true')

    // --- and now the property the whole feature rests on --------------------------------------
    // Switching captions OFF must clear what is already on the congregation screen, not merely stop
    // the next line. Standing Rule 1: design for veto, not trust. This asserts the kill switch on
    // the real DOM of a real browser source, with text visibly on it a moment earlier.
    await page.getByTestId('caption-toggle').click()
    await expect(status).toHaveAttribute('data-caption-enabled', 'false')
    await expect(overlayPage.locator('#caption')).toHaveAttribute('aria-hidden', 'true')

    await overlayPage.close()
    overlayPage = null
  })
})
