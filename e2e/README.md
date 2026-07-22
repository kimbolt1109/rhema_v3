# Verger — end-to-end tests

One suite, `service-day.spec.ts`, that launches the **real built Electron app** and walks a mock
service through it. It is the only test in this repo that injects nothing: real main process, real
preload bridge, real overlay HTTP + WebSocket server, real React renderer, real IPC.

Everything else — 1,738 unit and integration tests across 59 files — proves a component against a
seam. This proves the components are actually connected to each other.

---

## Running it

```bash
npm run build      # required: the suite drives out/main/index.js, not a dev server
npm run test:e2e   # === npx playwright test
```

Useful variants:

```bash
npx playwright test -g "overlay"            # one step by name (serial mode still runs the earlier ones)
npx playwright test --reporter=list         # the default
npx playwright show-report playwright-report                     # the HTML report from the last run
npx playwright show-trace test-results/service-day.trace.zip    # only written when a test fails
```

**`npx playwright install` is not needed.** The suite uses Playwright's Electron support
(`_electron.launch`) and drives the Electron binary that `npm install` already put in
`node_modules`. No Chromium, Firefox or WebKit download is involved; the only browser engine in play
is the one inside Electron — which is exactly the engine an OBS Browser Source uses, so it is also
the right one to be testing against.

If `out/main/index.js` is missing, the whole suite **skips** (it does not fail) and prints the
reason to stderr:

```
[e2e] SKIPPING: The built app was not found at …\out\main\index.js. This suite drives the real
app, not a dev server, so there is nothing to launch. Run `npm run build` first, then
`npm run test:e2e`.
```

### Constraints worth knowing before you edit the config

- **One worker, no parallelism, no retries.** The app binds `127.0.0.1:7320` and takes Electron's
  single-instance lock. A second worker would be a second instance fighting for both. Retries would
  relaunch while the previous process is still releasing the port, turning a real failure into an
  intermittent one.
- **The UI language is pinned to English.** The app ships a complete Korean bundle and detects the
  language from `navigator`/`localStorage`, so on a Korean-locale machine every string assertion
  would fail for the wrong reason. The suite launches Electron with `--lang=en-US` *and* writes the
  app's own `verger-locale` key, then asserts an English string in step 1 so a failure of the
  pinning is loud and immediate.
- **Artefacts land in `test-results/` (failure screenshots, trace) and `playwright-report/` (HTML).**
  Those are Playwright's default folder names, chosen because `.gitignore` already lists them —
  a prettier name would have meant either editing `.gitignore` or committing megabytes of traces.
  The trace is only written when a test fails; a green run leaves nothing behind worth keeping.

---

## What it covers

Eight steps, run in order as one service. `mode: 'serial'` — if a step fails the rest are skipped,
because you cannot fire a cue in an app that never rendered.

| # | Step | What it actually proves |
|---|---|---|
| 1 | **Launch and shell** | Electron starts, one window opens, the title is `Verger`, the health strip and all 11 section tabs render, and the title bar shows a real Electron version — which only appears if the preload bridge loaded and `app.getVersions` answered over IPC. |
| 2 | **Overlay server is live** | The test process `fetch`es `http://127.0.0.1:7320/overlay` over loopback, exactly as OBS would, and gets HTTP 200 with all three layer elements in the markup. It also asserts the redirect to `/overlay/` stays on the loopback origin, and that the control window's own panel agrees the server is *Running*. |
| 3 | **OBS reports NOT CONFIGURED, with guidance** | The status region says *Not configured*, the callout names OBS Studio 30+, `Tools → WebSocket Server Settings` and `HUMAN_TASKS.md`, and the connection form is still present and editable. Not-configured means "nothing to dial", not "controls removed". |
| 4 | **A lower third reaches a real browser source** | The single most valuable assertion in the file. A second Chromium page is opened on the overlay URL, its debug HUD confirms the WebSocket attached and the opening snapshot arrived, then text typed into the control window's Overlay panel is asserted **in the other page's DOM** — `renderer → preload IPC → main → overlay HTTP server → WebSocket → browser-source DOM`. The state revision is asserted to have advanced, the two untargeted layers are asserted untouched (BLUEPRINT.md §6 layer independence), and the layer is then hidden again so the path is proven in both directions. |
| 5 | **Camera panel disabled, with a reason** | All four slot buttons are disabled, the panel says *Not connected to OBS* and explains why, nothing claims to be live, and the program scene reads *Not reported yet* rather than a stale guess. |
| 6 | **A cue is added and survives a renderer reload** | A cue is added in the Plan editor, then the renderer is **reloaded**, which destroys every Zustand store. The cue coming back can only have come from the main process over IPC — merely switching tabs would prove nothing, since the stores are module-scoped and outlive an unmounted panel. Also asserts the deck importer honestly disables itself (no LibreOffice on this machine). |
| 7 | **GO LIVE is blocked, with a stated reason** | The button is disabled and a sentence next to it says it is because Verger is not connected to OBS. The live and recording indicators say `NOT LIVE` / `NOT RECORDING` **in words**, and the YouTube-not-configured callout states exactly what GO LIVE would and would not do — rather than failing at the fifth step mid-service. |
| 8 | **Status dashboard** | All seven subsystem lights (`obs`, `overlay`, `asr`, `youtube`, `recording`, `stream`, `automation`) render, each carrying its level as a **text label** as well as a colour, plus a machine-readable `data-health-level`. The "is the service still going out?" answer is asserted to be the honest *no*. |

### Proof that step 4 fails when it should

A regression test is worth exactly what it catches, so this one was checked against its own bug.
With the `Show lower third` click deliberately removed from the spec and nothing else changed, the
run fails with:

```
4) a lower third fired in the control window appears in the overlay page
   Error: expect(locator).toHaveText(expected) failed
   Locator:  locator('#lower-third-line1')
   Expected: "PLACEHOLDER SPEAKER"
   Received: ""
     43 × locator resolved to <p id="lower-third-line1" class="lower-third__line1"></p>
        - unexpected value ""
```

The element is genuinely empty until the control window pushes to it — so the assertion is reading
live DOM driven by the real IPC → server → WebSocket path, not a value the test echoed back to
itself. The click was restored and the suite is green again.

---

## What it does **not** cover, and why

This is the important section. The build prompt's target flow was
*connect OBS → import deck → GO LIVE → ASR feed → scripture cue → lower third → END*. On this
machine three of those five stages are impossible, and a test that pretended otherwise would be a
green light meaning nothing.

### Not covered because the dependency does not exist here

| Not exercised | Why | What is asserted instead |
|---|---|---|
| **Connecting to OBS**, switching a program scene, starting/stopping a stream or a recording | **OBS Studio is not installed on this machine.** There is no obs-websocket endpoint, no scene, no output. | The *not-configured* and *not-connected* paths, deliberately: steps 3, 5 and 7. |
| **Creating, binding or transitioning a YouTube broadcast**; Google OAuth | **No Google credentials exist and none are coming.** | The not-configured callout in step 7, including the explicit "what GO LIVE will still do / will not do" copy. |
| **Cloud ASR (Deepgram)**; a real transcript driving a real cue | **No Deepgram key exists.** The local faster-whisper sidecar *does* work on this machine (see `STATUS.md` cycle 7), but feeding it real speech is an accuracy question, not an integration one, and there is no scripted audio fixture. | Nothing here. The ASR light is asserted to render in step 8; that is all. |
| **PowerPoint import** | **LibreOffice is not installed** and cannot be (no `winget`), so `detectImporter()` reports `available: false`. | Step 6 asserts the importer disables itself and says so, rather than offering a button that fails. |
| **The cue engine end-to-end** (transcript → detection → suggestion → confirm → overlay) | Needs an ASR feed, which needs one of the two above. The engine's own logic has ~180 unit tests and a wiring test that boots the real composition root. | Nothing here. |
| **The overlay composited over live video**, transparency, alpha behaviour in a real Browser Source | Needs OBS. Step 4 proves the page renders and updates in the same Chromium engine OBS embeds; it cannot prove the compositor blends it correctly. | Step 4, in a real Chromium page — one layer short of the real thing. |
| **The packaged NSIS installer** | `electron-builder` output is a separate artefact and the installer is **unsigned** (there is no code-signing certificate on this machine). Installing and launching it is a manual step in the service-day runbook. | Nothing here. The suite runs against `out/`, not against an installed app. |

### Not covered for methodological reasons

- **No keyboard-shortcut or hold-to-confirm coverage.** SPACE-tap/SPACE-hold, ESC-hold and the
  `HoldButton` timings are timing state machines with their own fake-timer unit tests, where a
  3-second hold costs microseconds instead of 3 real seconds per assertion. Driving them through a
  real window would make this suite slower and *less* precise.
- **No accessibility audit here.** `jest-axe` runs against the component tree in the unit suites,
  which is where a violation can be attributed to a component.
- **No visual/screenshot comparison.** Screenshots are captured on failure as evidence only. A
  pixel baseline for a dark, GPU-composited Electron window is a flake generator.
- **No assertion that the overlay is *not* reachable from the LAN.** Proving a negative about
  network exposure needs a second interface and a second host, which a test on one machine cannot
  honestly assume. What is asserted is that the documented loopback URL is the one that answers and
  that the redirect stays on it. `src/shared/net.ts` has the unit tests that reject `0.0.0.0`.

---

## Where the boundaries of "green" are

A passing run means: **the app builds, launches, serves its overlay, pushes state to a real browser
source, keeps its layers independent, persists a plan through the main process, and refuses every
unavailable subsystem in plain words instead of failing obscurely.**

It does **not** mean the app has ever talked to OBS, YouTube or Deepgram. Nothing in this repo has.
The `HUMAN_TASKS.md` entries for those are the gap, and the first real dry run — one unlisted
broadcast with a live OBS — is still the most valuable untaken step in this project.
