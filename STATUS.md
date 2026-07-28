# Verger (rhema_v3) — build status log

Running log of the 10-phase build defined in `verger_build_prompts.md`.
One cycle entry per phase. Appended, never rewritten.

---

## Cycle 0 — Bootstrap (2026-07-23)

- **Delta closed:** repo initialised and wired to `origin`
  (`github.com/kimbolt1109/rhema_v3`). `vergerblueprint.md` located (it was not in the project
  folder — recovered from `C:\Users\user\Downloads\verger-blueprint.md`, two identical copies,
  14,423 bytes) and copied in as the immutable `BLUEPRINT.md`. Created `.gitignore`, `CLAUDE.md`
  (governance loop adapted from `rhema_v2/CLAUDE.md`), `STATUS.md`, `HUMAN_TASKS.md`.
  Prior project `rhema_v2` mined by nine parallel research agents into `docs/v2-notes/`.
- **Environment verified:** node v24.17.0, npm 11.13.0, git 2.54.0.windows.1,
  gh 2.93.0 (authenticated as `kimbolt1109`).
- **Resource pool:** `C:\ClaudeFlow\projects\rhema\resources\` EXISTS with `models/`, `bin/`,
  `bibles/`, `migrations/` — reusable for the local-ASR path in Phase 7 (avoids re-downloading
  Whisper/ONNX models) and for `ffmpeg` in `bin/win/`.
- **Remaining delta:** Phases 1-10.

---

## Cycle 1 — Phase 1: Electron shell + OBS connection + governance (2026-07-23)

**Green.** `tsc --noEmit` clean on both projects · `vitest run` 168 tests / 9 files passing ·
`electron-vite build` succeeds · app launches and registers all 8 IPC handlers.

### Delta closed

- **Scaffold** — electron-vite 5 / Vite 7 / React 19 / TS 5.9 / Tailwind 3 / Vitest 4. Three
  builds (main, preload, renderer), path aliases `@shared` / `@main` / `@renderer`, two
  independently-checkable tsconfigs, two vitest projects (`node`, `renderer`).
- **Shared contract** (`src/shared/`) — `result.ts` (Result/AppError/ErrorCode),
  `log.ts` (Logger/LogRecord), `obs.ts` (state machine + `computeBackoffDelay`),
  `config.ts` (the 8 `.env` keys + zod schemas), `ipc.ts` (channel registry + `VergerApi`).
  Node-global free so the renderer can import it.
- **OBS client** — `obs-websocket-js` v5 behind an injected socket/timer/clock seam, so the
  whole reconnect state machine is tested with fake timers and no OBS. Exponential backoff
  (500ms → 30s, ×2, 25% jitter, unbounded attempts).
- **IPC bridge** — one `ipcMain.handle` per channel behind a `safeHandle` wrapper
  (sender validation → zod parse → try/catch → coded error). Sandboxed CommonJS preload
  exposing only the typed `VergerApi`; no channel strings or `ipcRenderer` reach the renderer.
- **Renderer** — booth theme (forced dark, ERGO-1), Connection screen, glanceable
  `StatusIndicator`, EN + KO locales, error boundary, zustand store that degrades when
  `window.verger` is absent.
- **Governance** — `BLUEPRINT.md`, `CLAUDE.md`, `STATUS.md`, `HUMAN_TASKS.md`, plus
  `README.md` / `docs/ARCHITECTURE.md` / `docs/DEVELOPMENT.md`.

### Decisions worth carrying forward

- **`auth-failed` is a terminal state.** A rejected OBS password never retries. Retrying
  cannot succeed, and a scrolling "reconnecting…" would bury the real cause mid-service.
- **The OBS client is locked to `Get*` requests.** `isReadOnlyRequest()` refuses anything
  else *before it reaches the socket*, making Standing Rule 2 structural rather than a
  convention. Phase 3 (`SetCurrentProgramScene`) and Phase 5 (`StartStream`/`StartRecord`)
  must widen this deliberately, with their own tests.
- **Preload is pinned to CommonJS at `out/preload/index.cjs`.** `package.json` is
  `"type": "module"`, and Electron 38 only loads an ESM preload when `sandbox: false`. Keeping
  the sandbox required pinning the format. Verified by launching Electron, not by inference.

### Defects found and fixed during verification

- **Log redaction blanked booleans.** `ConfigSummary.configured` is a
  `Record<EnvKey, boolean>` whose keys are literally `OBS_WEBSOCKET_PASSWORD`,
  `DEEPGRAM_API_KEY`… The key-pattern redactor rewrote those booleans to `[redacted]`, so the
  startup log hid which subsystems were configured *and* implied a secret was present where
  none was. Booleans are now never redacted (a boolean cannot carry a secret); strings under
  the same keys still are. Two regression tests added. **Only found by running the app** —
  every unit test passed with the bug present.
- **Architecture fragmentation.** The contract agent was blocked twice by the safety
  classifier, so the main-process agent built against no shared types and declared its own
  `EnvKey`, `Result` and `Logger`. Reconciled: those now re-export from `src/shared/`, and
  `secrets.ts` uses the project-wide `Result` (its `INVALID_KEY` became `INVALID_ARG`).

### Verification performed

- `npx tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.web.json` — both silent, exit 0.
- `npx vitest run` — 9 files, 168 tests, all passing.
- `npx electron-vite build` — main 51.5 kB, preload 1.99 kB (`.cjs`), renderer 847 kB.
- **Electron smoke test** (harness outside the repo): the sandboxed CJS preload loads,
  `window.verger` exposes all four API groups and seven `obs` methods, `window.require` and
  `window.process` are both absent (sandbox + contextIsolation hold), React mounts, and there
  are no CSP violations.
- **Real app launch** — starts, loads config, registers 8 IPC handlers, renders the Korean
  locale, and correctly reports every subsystem as "not configured" with no `.env` present.

### Not verified (and why)

- **No connection to a real OBS.** OBS Studio is not installed on this machine, so every OBS
  behaviour is covered against a hand-written mock. The `HUMAN_TASKS.md` entry stands.
- The `obs-websocket-js` adapter in `src/main/obs/index.ts` needs three `as unknown as` casts
  (the library types `call`/`on`/`off` against generated unions of every request name). It is
  smoke-verified only — the class loads and exposes the five methods — and has never spoken to
  a live OBS.
- Auth-failure detection matches WebSocket close code **4009**, read from the library source.
  The `WebSocketCloseCode` enum is not exported, so the constant is declared locally.

### Remaining delta

Phases 2-10.

---

## Cycle 2 — Phase 2: Overlay server, WebSocket bus, and the independent layer (2026-07-23)

**Green.** `tsc --noEmit` clean on both projects · `vitest run` 289 tests / 14 files passing ·
`electron-vite build` succeeds · the running app serves the overlay and pushes state on connect.

### Delta closed

- **Overlay protocol** (`src/shared/overlay.ts`) — three independent layers (`lowerThird`,
  `scripture`, `slide`), seven commands, one `channel`-discriminated envelope with `payload`
  always present, and zod schemas that *are* the types. `applyOverlayCommand` is the single,
  pure mutation point.
- **Network constants** (`src/shared/net.ts`) — one port declared once (7320), loopback-first,
  `isAllowedBindAddress` rejects `0.0.0.0`. Both the code and `docs/OBS_SETUP.md` read from it,
  so the documented URL cannot drift from the bound one.
- **Overlay server** (`src/main/overlay/`) — Express 5 + `ws` sharing ONE HTTP server;
  WebSocket upgrades accepted only on `/ws`. Inbound frames zod-validated and size-capped
  (64 KiB); a bad frame gets an error reply and keeps the connection. Heartbeat terminates a
  browser source that misses two pongs, so a dead overlay cannot linger in the client count.
- **Overlay page** (`src/overlay/`) — framework-free static HTML/CSS/JS, transparent
  background, three independently-animated layers, Korean-aware typography (`word-break:
  keep-all`), `textContent` only (never `innerHTML`), and forever-reconnect with backoff.
- **Control panel** — Overlay panel with per-layer controls, a live state readout, the
  paste-into-OBS URL, and a `HoldButton` for CLEAR ALL.
- **Docs** — `docs/OBS_SETUP.md` (the scene contract and exact browser-source settings).

### The decision this phase turns on

**State-based, not event-based.** An OBS browser source can crash or be reloaded mid-service.
Had the wire protocol been a stream of show/hide *events*, a reconnecting overlay would have
missed everything that happened while it was gone and come back blank — during a service. So
the server owns the state and the page is a pure function of it: every mutation broadcasts a
full snapshot, and a snapshot is sent immediately on connect. **Resync is not a special case,
it is the only case.** Verified against the live app: a socket that says nothing receives the
complete state the instant it opens.

### Defects found and fixed during verification

- **The overlay server was never started.** `src/main/index.ts` constructed nothing and called
  no `start()`, so port 7320 never bound, the page was never served, and OBS could never have
  loaded the browser source. Every unit test passed and the build was green. Cause: an
  orchestration error — every agent was forbidden from editing `index.ts` to prevent write
  conflicts, and no one was given ownership of wiring it in. Now started on `ready` and stopped
  on `will-quit`.
- **The advertised URL 404'd.** `express.static` was configured `index: ['index.html']` while
  the page file is `overlay.html`, so `http://127.0.0.1:7320/overlay` redirected to `/overlay/`
  and returned *Cannot GET*. The single URL an operator pastes into OBS produced a blank
  overlay. The existing test asserted `pageUrl` was the right **string** — which it was. Fixed,
  and replaced with a test that actually `fetch`es the URL and the three assets. Asserting a
  URL string is not the same as asserting the URL works.
- **The OBS client had a null logger.** `getObsClient()` was called with no arguments, so all
  OBS diagnostics went nowhere. Now passed the real logger.
- Found by the server agent itself: `removeAllListeners()` before `terminate()` stripped `ws`'s
  own internal close listener, so `wss.close()` waited forever for a client that would never
  report in and `stop()` hung. Fixed, with bounded close deadlines.

### Verification performed

- `npx tsc --noEmit` on both projects — silent, exit 0.
- `npx vitest run` — 14 files, 289 tests passing. Includes 40 reducer tests asserting that for
  **every** command the two untargeted layers are referentially identical (the blueprint's
  layer-independence guarantee as an executable assertion), and real-socket integration tests
  covering the disconnect/reconnect resync path.
- **Live app**: launched the built app, `curl -sL http://127.0.0.1:7320/overlay` → HTTP 200,
  7,453 bytes; a raw `ws` client received `{channel:'state', payload:{…revision:0}}` on open
  before sending anything.

### Not verified (and why)

- **Never loaded as a real OBS Browser Source.** OBS is not installed. The page has been
  fetched and parsed but not composited over live video, so the transparency guarantee rests on
  CSS review, not observation.
- The overlay page's rendering and reconnect logic has no automated coverage — it is
  framework-free browser JS with no test harness in this phase. Phase 10's Playwright e2e is
  where it gets driven.

### Remaining delta

Phases 3-10.

---

## Cycle 3 — Phase 3: Cameras, lower-thirds, and the action dispatcher (2026-07-23)

**Green.** `tsc --noEmit` clean on both projects · `vitest run` 437 tests / 20 files ·
`electron-vite build` succeeds · app launches with 15 IPC channels and the overlay still served.

After this phase the operator can run a service manually: cameras and overlays are two
independent controls, and the transparent-PowerPoint hack is dead.

### Delta closed

- **Camera contract** (`src/shared/camera.ts`) — four fixed slots (CAM 1 / CAM 2 / WIDE /
  PULPIT), each bound to an OBS scene chosen in settings. `sceneName: null` means unmapped, so a
  button can never fire a request for a scene that does not exist.
- **Action vocabulary** (`src/shared/actions.ts`) — every operator intent is a named action, and
  keys are merely one way to trigger one. A foot pedal and a Stream Deck are keyboard-HID
  devices, so they work the moment the keyboard does; Phase 10 adds only a remap UI.
- **CameraService** — drives OBS, and subscribes back so a scene switched *inside* OBS updates
  `activeSlot`. When the live scene maps to no button, no button lights and OBS is never
  "corrected".
- **Action dispatcher + keyboard hook** — the tap/hold state machine that lets SPACE be both
  advance (tap) and PANIC (hold 3s) on one key.
- **Camera UI** — four `min-h-touch-xl` buttons, live state never signalled by colour alone,
  plus a settings screen that picks scenes from OBS's live list rather than free text.

### The OBS write allowlist — widened deliberately

Phase 1 locked the OBS client to `Get*` requests so Standing Rule 2 was structural. Phase 3
needs to write, so the guard is now an explicit allowlist of exactly three names:
`SetCurrentProgramScene`, `SetCurrentSceneTransition`, `SetCurrentSceneTransitionDuration`.
Everything else — `StartStream`, `StopRecord`, `SetSceneItemEnabled`, and the rest — stays
refused before it reaches the socket, and six new tests assert that. A future edit cannot
quietly widen this: it would have to add a line to that list.

Phase 5 will need `StartStream`/`StartRecord`/`StopStream`/`StopRecord`. That is the next
deliberate widening, and it should arrive with its own tests.

### The independence guarantee, proven twice

- **Service level**: `select()` issues exactly the scene/transition requests and nothing else,
  and `CameraService.test.ts` reads its own source from disk to assert the module cannot even
  *import* anything overlay-related.
- **UI level**: pressing CAM 2 sends `camera.select('cam2')` and **zero** overlay commands; the
  mirror test asserts hiding the lower-third selects no camera.

### Safety model implemented

SPACE tap (<300ms) advances; SPACE held 3s is PANIC. ESC held 2s disables automation and is
**non-destructive** — whatever is live stays live; a bare ESC tap does nothing at all. SHIFT+ESC
dismisses only the lower-third. Nothing destructive fires under 1500ms, and `isSafeBinding()`
rejects any remap that would violate that — the guard against reintroducing v2's
instant-clear-ESC regression. Shortcuts are ignored while focus is in a text field, so typing a
name into the lower-third cannot black the output.

### Judgement calls worth knowing about

- An agent added a public `call()` to `ObsClient` (it had none, and the camera seam needs it).
  It routes through the same guard, so it grants no authority beyond the three allowlisted
  writes — and it disclosed the deviation rather than hiding it.
- `setConfig()` applies a new mapping in memory *before* persisting, and reports `IO_ERROR` if
  the write fails. The operator keeps working buttons for the rest of the service; the
  alternative leaves them with no buttons mid-service.
- A failed transition-set is logged and the scene switch proceeds anyway: the operator pressed
  CAM 2 and gets CAM 2, possibly with the wrong wipe. A failed scene-set propagates.

### Not verified

Still no live OBS on this machine, so every camera switch is exercised against a mock. Nothing
here has moved a real program scene.

### Remaining delta

Phases 4-10.

---

## Cycle 4 — Phase 4: Google OAuth + YouTube broadcast lifecycle (2026-07-23)

**Green.** `tsc --noEmit` clean on both projects · `vitest run` 633 tests / 25 files ·
`electron-vite build` succeeds · app launches with 20 IPC channels and overlay / camera /
youtube all attached.

Part A only: OAuth once, then create and bind a broadcast from a template. The GO LIVE
orchestration is Phase 5 — nothing here starts a stream or a recording.

### Delta closed

- **YouTube contract** (`src/shared/youtube.ts`) — auth state, broadcast, persistent stream,
  weekly template, and the pre-flight issue list.
- **OAuthService** — installed-app loopback flow on an ephemeral 127.0.0.1 port, `access_type:
  offline` + `prompt: consent` so a refresh token is actually issued, CSRF `state` verified, a
  3-minute timeout, and the loopback server closed on *every* path including denial and
  rejection. Only the refresh token is persisted, through Electron `safeStorage`.
- **YouTubeService** — reuses ONE persistent stream (matched by title) and only creates one when
  absent, so **the RTMP key never changes and OBS stays configured**. That is the whole point:
  re-pasting a key into OBS every Sunday is the many-clicks pain this feature removes.
- **preflight.ts** — pure, exhaustively tested. Blocks on not-signed-in and no-bound-stream;
  warns on missing CCLI streaming-licence metadata (the legal gate from
  `docs/v2-notes/LEGAL_AND_CONTENT.md`) and on `public` privacy, since publishing a service
  publicly by accident is not recoverable.
- **Go Live settings UI** — template editor with a live `{date}` preview, channel readout so the
  operator can confirm the right channel, and a genuinely useful not-configured state.

### Security decisions

- **The RTMP stream key is a credential** and has no field in `PersistentStream`. It never
  crosses IPC, never reaches a log, and stays in OBS's own settings. A test asserts the rendered
  Go Live screen contains no stream-key field.
- The OAuth refresh token goes to `safeStorage` only. A test scans every logger call — message
  and fields, JSON-serialised — for the refresh token, the client secret and the auth code.
- The consent success page is a constant string; no query parameter is ever echoed back, so the
  authorisation code cannot leak into the browser page.

### Defect found and fixed during verification

- **The Google session was never restored at startup.** `OAuthService` deliberately begins in
  `signed-out` because its constructor cannot await the secrets store — but nothing called
  `restore()`. With a valid `.env` and a perfectly good stored refresh token, the Go Live screen
  would have read "signed out" on every launch and asked the operator to re-authorise every
  Sunday. `main/index.ts` now calls `youtube.refresh()` fire-and-forget at startup, which
  restores auth and populates the channel and stream. With an empty `.env` it short-circuits at
  `not-configured` and makes no network call.
  This is the same class of bug as Phase 2's never-started overlay server: every unit test
  passed, and only wiring the thing into the running app exposed it.

### Not verified (and this is the significant one)

**No Google credentials exist on this machine and none will.** Every OAuth and API path is
exercised against injected mocks with zero network access. What has NOT been proven: that the
real `google.auth.OAuth2` round-trip works, that a real broadcast is created and bound, or that
YouTube accepts the request shapes. The types are machine-checked against the installed
`googleapis` 173.0.0, and the concrete `OAuth2Client` is verified assignable to the seam — but
the end-to-end flow is unproven until someone completes the `HUMAN_TASKS.md` entry.

Also unverified: `signOut()` revokes at Google best-effort and fire-and-forget, so if revocation
fails the token is forgotten locally but may remain live at Google until revoked from the
account page. Only the local delete is asserted.

### Remaining delta

Phases 5-10.

---

## Cycle 5 — Phase 5: GO LIVE / END orchestration + always-on recording (2026-07-23)

**Green.** `tsc --noEmit` clean on both projects · `vitest run` 784 tests / 29 files ·
`electron-vite build` succeeds · app launches with 23 IPC channels and the overlay served.

After this phase the many-clicks pain is gone: one button takes you live, one ends it.

### Delta closed

- **Output layer** (`src/main/obs/outputs.ts`) — reads OBS's real stream/record state
  (timecodes, dropped frames, reconnecting flag, recording path) and exposes the
  start/stop verbs, all Result-returning.
- **`startStreamAndRecord()`** — the Standing Rule 3 primitive. It takes **zero arguments**, so
  there is no flag, option or overload by which a stream could start without a backup. A test
  asserts that signature.
- **GoLiveService** — drives the five steps in order, publishing state after every transition so
  the UI shows *which* step is running rather than a spinner.
- **GO LIVE panel** — per-step progress, elapsed time, an independent recording indicator, the
  recording file path, and END as a `HoldButton`.

### The OBS write allowlist, widened a second time

Phase 3 opened it to three camera requests. Phase 5 adds exactly four:
`StartStream`, `StopStream`, `StartRecord`, `StopRecord` — seven in total. Everything else stays
refused before reaching the socket, and the connect assertion was strengthened from "issues no
`Set*`" to "issues no `Set*`, no `Start*`, no `Stop*`", with a further test proving a whole
reconnect cycle issues only `Get*`. Launching Verger mid-service must never push a second stream.

### Failure behaviour — the part that matters on a Sunday

- A **transition failure** or a **health timeout** moves the phase to `partial`, and
  `StopStream`/`StopRecord` are **never** called. OBS keeps streaming and recording; the operator
  is told the broadcast is not public and offered a retry. `partial` exists precisely because
  collapsing it into `live` or `failed` would lie in opposite directions.
- A **StartRecord failure is loud** — the step fails and the operator is told the stream is not
  being backed up — but the stream is **not** stopped. The service in the room matters more than
  the backup.
- **YouTube not configured** marks the broadcast and transition steps `skipped`, not failed:
  GO LIVE still streams and records via OBS. That is this machine's actual state, so it is a
  supported path rather than an error.
- **END** stops the recording **last**, so a YouTube or network failure cannot cost the operator
  the local file.

### Defects found and fixed during verification

- **The go-live service was never wired into `main/index.ts`**, so the crash re-attach never ran
  at startup. Consequence: Verger crashes mid-service, the operator relaunches and presses GO
  LIVE, and Verger — seeing nothing in progress — pushes a **second stream and a second
  recording**. This is the third occurrence of the same class of bug (Phase 2's unstarted overlay
  server, Phase 4's unrestored session): every unit test passed each time. `initialize()` is now
  called at startup and adopts whatever OBS is already doing.
- **`ObsClient` had no raw event hook**, so `subscribeOutputs` silently degraded to
  refreshing only on reconnect — meaning a stream started, stopped or *dropped* inside OBS would
  not reach the UI. Added a read-only `onObsEvent(event, listener)`. It is held on the **client,
  not the socket**, so subscriptions survive reconnects — otherwise `StreamStateChanged` would go
  quiet exactly when OBS drops and returns, the one moment it matters most. Five tests, including
  one asserting that subscribing grants no write authority.

### Not verified

No OBS and no Google credentials on this machine. Nothing here has started a real stream or
recording; the obs-websocket field names (`outputActive`, `outputTimecode`, `outputSkippedFrames`,
`outputPath`) and the 500/501 "already running" status codes come from the protocol spec, not from
a live handshake. **Phase 5 is the phase most in need of a real dry-run** — one unlisted broadcast,
confirming the local recording file exists afterwards.

### Remaining delta

Phases 6-10.

---

## Cycle 6 — Phase 6: Service Plan, cue editor, PowerPoint import (2026-07-23)

**Green.** `tsc --noEmit` clean on both projects · `vitest run` 989 tests / 36 files ·
`electron-vite build` succeeds · app launches with 32 IPC channels.

The plan is a fully usable **manual** slide/media driver — no ASR, no cue engine, no network.
That manual path is the fallback Phases 7-8 degrade to, so it had to be solid first.

### Delta closed

- **Plan model** (`src/shared/plan.ts`) — Service = ordered Cues, each with a trigger and a
  payload, validated per-type. Position helpers (`advance`, `stepBack`) that clamp rather than
  wrap: running off the end mid-service is a no-op, never a jump back to the welcome slide.
- **PlanService** — routes each cue type to the overlay, camera or OBS; atomic save; load
  validation that names the offending cue (`cue 2 ("PLACEHOLDER TITLE", id "cue-2")`).
- **Deck import** — a hardened PPTX reader over `fflate` with zip-bomb, entry-count, slide-count
  and path-traversal limits, and the `_rels` media mapping the v2 notes flagged. Numeric slide
  ordering is asserted explicitly (`slide10` must sort after `slide2` — a string sort silently
  scrambles a service).
- **Cue editor** with keyboard-accessible `@dnd-kit` reordering, and **PlanRunner** with NOW/NEXT
  and next-slide preloading.

### Standing Rule 4, enforced by schema

The `scripture` payload has **no `text` field**, so a plan carrying verse text is invalid by
construction — not by discipline. Imported slides are treated as opaque images; their text is
never read, logged or stored. All fixtures are placeholders.

### The defect that would have broken this phase in production

**Slide assets were `file://` URLs.** The overlay page is served from
`http://127.0.0.1:7320/overlay`, and Chromium — which is what an OBS Browser Source is — refuses
`file:` subresources inside an `http:` document; the page's CSP (`img-src 'self' data:`) rejects
them too. **Every imported slide would have silently failed to appear on the congregation
screen**, with every unit test passing. Found because the agent that wrote it said plainly that
it was unverified end-to-end rather than assuming it worked.

Fixed by serving the open plan's asset folder from the same origin: a new `/assets` route on the
overlay server whose root is set at runtime by the plan service (it moves with the plan), plus
`overlayAssetUrl()` which percent-encodes each segment so filenames with spaces or Hangul — both
routine for a Korean church's deck — actually resolve. Three regression tests: an image round-trips
byte-for-byte over HTTP, the route 404s when no plan is open rather than serving last week's
slides, and three traversal shapes are refused (the asset folder holds files extracted from an
untrusted `.pptx`, so a traversal would turn the overlay into an arbitrary-file-read endpoint).

### The OBS write allowlist held

A media cue needs `TriggerMediaInputAction`, which is **not** on the allowlist. The agent
correctly refused to widen it, returning a clear error saying it needs a reviewed change instead
— and covered that with a test. That is the guard working as intended: it made a phase stop and
ask rather than quietly punch through. **Media cues therefore do not fire yet**; widening the
allowlist is a deliberate follow-up.

### Not verified

- **No PPTX renderer exists on this machine.** LibreOffice is not installed and cannot be
  (no `winget`), so `detectImporter()` honestly reports `available: false` and the UI disables
  import with an explanation. The embedded-media fallback extracts pictures the deck already
  contains — which works for image-per-slide decks, and yields nothing for text-only slides.
  No real deck has been converted.
- No slide has been rendered in a real OBS Browser Source; the asset route is proven by HTTP
  fetch, not by compositing over live video.

### Remaining delta

Phases 7-10.

---

## Cycle 7 — Phase 7: Pluggable ASR (Deepgram cloud + faster-whisper local) (2026-07-23)

**Green.** `tsc --noEmit` clean on both projects · `vitest run` 1,326 tests / 44 files ·
`electron-vite build` succeeds · app launches with 39 IPC channels.

### Delta closed

- **ASR contract** (`src/shared/asr.ts`) — provider ids, selection modes, `TranscriptSegment`,
  status, settings, the 16 kHz mono s16le audio format, and the hallucination phrase list.
- **AsrService** — owns settings, the active provider, and the fallback policy.
- **DeepgramProvider** — streaming live transcription with interim results and keyword boosting,
  reconnect backoff, keepalive, and a bounded outbound buffer that drops oldest audio rather than
  growing without limit (an OOM in the transcriber must not take down a service).
- **WhisperProvider + `whisper_sidecar.py`** — a supervised Python child process with two-tier
  draft/final transcription and VAD gating.
- **Mic capture in the renderer**, transcript panel, and ASR settings with a custom-vocabulary
  editor.

### Local ASR actually works on this machine — verified, not assumed

`ctranslate2` ships a **cp314 Windows wheel**, so a project-local venv was provisioned at
`resources/asr-venv` (gitignored, 290 MB) with faster-whisper 1.2.1 + ctranslate2 4.8.1 +
onnxruntime 1.27.0. Measured directly:

- `ctranslate2.get_cuda_device_count()` → **1** (GTX 1650, 4 GB).
- `tiny` model load: **0.8 s** (CPU int8). Inference on 3 s of audio: **0.12 s**.
- VAD returned **0 segments** for a pure 220 Hz tone — correct: a tone is not speech.
- Two real-sidecar integration tests pass: `--selftest` in the venv exits 0 (1.2 s), and the
  sidecar starts, reports `ready` on a real device, accepts PCM and shuts down cleanly (2.4 s).

4 GB will not hold `large-v3`, so the local tier defaults to `small` final / `tiny` draft at int8,
with a CPU fallback if CUDA init fails — a driver update must not stop a service.

### Design decisions worth knowing

- **`degraded` is set only when a preferred provider was *attempted and failed*.** Running local
  in `auto` mode because no key was ever configured is plain `listening` — nothing broke, and a
  permanently amber light teaches operators to ignore amber.
- **Failover is hysteretic**: 3 errors within a 15 s window before switching, no automatic switch
  back mid-session. Flipping engines every few seconds visibly rewrites the transcript, which is
  worse than staying on the fallback.
- **A rejected hallucination that already reached consumers as a draft is republished as an
  empty-text final** under the same id, so replace-by-id retracts it. Dropping it silently would
  leave a phantom "thank you for watching" on screen forever. Phase 8's cue engine will therefore
  occasionally see a final with empty text.
- `getUserMedia` runs with `echoCancellation`, `noiseSuppression` and `autoGainControl` **off** —
  they are tuned for conference calls and mangle a sermon's dynamics and room tone.

### Deviation from the build prompt

Prompt 7 says "mic capture in the main process". That is not achievable in Electron without a
native module: only the renderer has `getUserMedia`. Capture therefore lives in the renderer and
PCM flows renderer → main over `asrPushAudio`. `asrPushAudio` is deliberately exempt from zod
validation and the generic rate limiter — it fires ~36,000 times per service, and validating a
3 KB binary blob ten times a second is pure waste.

### Not verified

**No Deepgram key exists and none will**, so the entire cloud adapter is mock-tested with zero
network. Nothing has ever spoken to Deepgram. Korean recognition accuracy, real latency numbers,
and whether the keyword-boost parameter name is right for the v5 API are all unproven — the SDK
types were read, but types are not a live handshake.

No real speech has been transcribed either: the local pipeline was exercised with synthesised
tones, which proves the plumbing but says nothing about accuracy on a sermon.

### Remaining delta

Phases 8-10.

---

## Cycle 8 — Phase 8: The cue engine (2026-07-23)

**Green.** `tsc --noEmit` clean on both projects · `vitest run` 1,566 tests / 51 files ·
`electron-vite build` succeeds · app launches with 49 IPC channels.

The brain: three parallel detectors, the trust dial, and the mechanism that makes "human always
wins" true rather than aspirational.

### Delta closed

- **Scripture contract** (`src/shared/scripture.ts`) — the confidence bands (0.95 / 0.65 / 0.50)
  as named constants with their reasoning, and `canAutoShow()`, the hard gate.
- **Cue contract** (`src/shared/cue.ts`) — `CueSuggestion` as an *intent*, `shouldAutoFire()`,
  and `syncToActual()`.
- **Scripture detector** — 66-book table with Korean names and abbreviations; KO forms
  (`요한복음 3장 16절`, `요 3:16`, `시편 23편`, Sino-Korean numerals) and EN forms
  (`John 3:16`, `First Corinthians 13`, `turn to John three sixteen`).
- **Resolver + translation catalogue** — PD-first, licensed-API second, attribution carried
  through, with the KRV quarantine rule enforced as data plus a filter.
- **Engine** — plan-follower, hot-phrase and scripture detectors running independently, plus the
  trust dial and panic.
- **Suggestion panel, trust dial, hot-phrase editor.**

### The safety properties, and how they are enforced

- **The engine never writes authoritative state.** It emits an intent; something else applies it.
- **`syncToActual()` runs first on every tick.** A manual plan move snaps the pointer, zeroes the
  dwell clock and *drops the pending suggestion* — otherwise an operator taking over is still
  racing a suggestion formed a second ago. Tested directly.
- **Nothing can force an auto-fire.** `confirmAlways` and a below-threshold confidence each block
  one; nothing compels one. Tested at confidence 1.0.
- **A confident reference whose text failed to resolve does not auto-show.** Tested.
- **Off-script degrades rather than breaks**: after three misses alignment goes `lost`, the
  plan-follower stops suggesting, and scripture + hot-phrase keep working. Its own test.
- **PANIC halts automation and touches nothing else** — no stream, no recording, no overlay
  output — and resuming is explicit, never automatic.

### Detector judgement calls worth knowing

- **Fuzzy matching runs against full book names only, never abbreviations.** Otherwise "we are
  meeting in room 3:16" is one edit from "Rom" and becomes Romans. Against full names "room" is
  three edits from "Romans" and is discarded, while "Jon" is still one from "John".
- **At equal edit distance an insertion outranks a substitution.** "Jon" is one edit from both Job
  and John; canonical order alone silently picked Job. An ASR dropping a character is likelier
  than one substituting and landing on a different real book.
- **Priming can never manufacture an `exact` match**: `CONFIDENCE_FUZZY + PRIMING_BONUS = 0.75`,
  below `CONFIDENCE_EXACT`. So `받으실 말씀은` re-ranks guesses but can never make one
  auto-showable. Asserted by a test.
- **ReDoS measured, not assumed**: nine adversarial inputs complete in **1.35 ms** against a 50 ms
  budget; no unbounded quantifiers anywhere in the file.
- `maxVerse` is a deliberate conservative upper bound. Hand-authoring 1,189 per-chapter counts
  invites a typo that silently rejects a real reference mid-service — invisible to the operator.
  Too-high merely lets an absurd number through to a suggestion they can ignore.

### Defects found and fixed during verification

**The engine was wired to nothing.** `getCueEngine()` defaulted `plan` and `overlay` but not
`asr`, and `register.ts` never passed the scripture detector at all. In production the engine had
no transcript source and no detector — a brain with neither ears nor eyes — while all 1,566 tests
passed, because every engine test injects its own fakes and calls `onTranscript()` directly.
Both are now defaulted alongside `plan` and `overlay`, and the module's docblock (which claimed
`register.ts` supplied them) was corrected.

This is the **fourth** occurrence of this exact class: Phase 2's unstarted overlay server, Phase
4's unrestored session, Phase 5's unwired go-live re-attach, and now this. The pattern is
consistent — a component is built and tested in isolation, and nothing connects it to the running
app. **Phase 9 should add an integration test that boots the real wiring** rather than relying on
me catching the fifth one by hand.

### Not verified

No real speech has ever reached this engine. Detection is exercised on synthetic transcripts, and
the resolver on mocked fetches — no ESV/API.Bible key exists and no public-domain translation has
been downloaded. Korean detection accuracy against a real sermon, and end-to-end
speech → transcript → suggestion latency, are both unproven.

### Remaining delta

Phases 9-10.

---

## Cycle 9 — Phase 9: Resilience & safeguards (2026-07-23)

**Green.** `tsc --noEmit` clean on both projects · `vitest run` 1,738 tests / 59 files ·
`electron-vite build` succeeds · app launches with 53 IPC channels.

### Delta closed

- **Health contract** (`src/shared/health.ts`) — seven subsystem lights, four levels, and
  `isServiceStillGoingOut()`.
- **HealthService** — seven pure mappers turning each subsystem's own vocabulary into a level plus
  a `detail` and a `stillWorks`, published through a trailing-edge throttle (~4/s) so a burst of
  OBS reconnect chatter never floods the UI but the *last* state always arrives.
- **Checkpoint ring** — automation-only rewind, bounded at `MAX_CHECKPOINTS`.
- **Overlay watchdog** — high-water-mark client tracking with a 6 s grace period, because an OBS
  scene change drops and re-adds a source in well under a second and a watchdog that cries wolf
  gets ignored by the third Sunday.
- **Failure-injection suite** — one test per BLUEPRINT.md §9 row, simulating the actual failure.
- **Status dashboard** — the lights, plus the one question that matters mid-service answered in
  plain words at the top.

### Amber means something

`degraded` is reserved for "working, but not as configured" — ASR fell back to local, RTMP
reconnecting, dropped frames above 5%. A subsystem with no key is `not-configured`, **never
amber**. YouTube signed-out maps to `not-configured` too: a church that signs in on Sunday morning
would otherwise stare at amber for six days, and a permanently amber light teaches operators to
ignore amber.

`stillWorks` is filled in for every degraded and down state, because it is the most valuable
string on the dashboard: *"stream reconnecting — the local recording is unaffected"* is the
difference between an operator staying calm and stopping the service to investigate. A red OBS
light while the stream is fine explicitly reads as **"the service is still going out"** — OBS
keeps streaming without Verger, which is the entire architecture.

### Recovery never touches the broadcast — enforced structurally

The overlay watchdog's seam **exposes no `send`**, so "the watchdog blanked the overlay" is
impossible rather than merely avoided. The checkpoint store is handed `stopStream` / `stopRecord`
seams whose production implementations actively **refuse with an `Err`**, and a test scans
`checkpoints.ts` for any call site. Restore rewinds the plan pointer via `back()`, which fires
nothing.

### The wiring test — and proof that it works

Four times this build produced a component that was fully unit-tested and connected to nothing
(Phase 2's unstarted overlay server, Phase 4's unrestored session, Phase 5's unwired re-attach,
Phase 8's earless engine). `src/main/wiring.test.ts` now exercises the **real composition root**:
every `IPC_CHANNEL_VALUES` entry has a handler under production defaults; no channel answers
`Err(INTERNAL)` on an unconfigured machine (unconfigured is a *designed* state, not an error);
the overlay server binds and serves `pageUrl` with HTTP 200; the cue engine reaches the ASR
singleton and holds a detector; go-live adopts an already-streaming OBS; and every production
factory stays zero-arg callable.

**I verified the test actually catches the bug rather than merely existing**: I reintroduced the
Phase 8 defect (engine built with no ASR source) and the suite failed on
*"reaches the ASR service for transcripts and holds a scripture detector"*. Reverted, green again.
A regression test is worth exactly what it catches.

### Not verified

Every failure is *simulated* through injected seams and loopback sockets. No real internet drop,
no real OBS crash, no real browser-source failure has been observed — OBS is still not installed.
The fallbacks are proven against the model of the failure, not the failure itself.

### Remaining delta

Phase 10.

---

## Cycle 10 — Phase 10: Polish, packaging, e2e — COMPLETE (2026-07-23)

**Green.** `tsc --noEmit` clean on both projects · `vitest run` **1,925 tests / 65 files** ·
`electron-vite build` succeeds · **8/8 Playwright e2e tests pass against the real app** ·
`i18n-audit` exits 0 · **a Windows installer is produced: `release/0.1.0/Verger-0.1.0-x64-setup.exe`,
93 MB**.

### Delta closed

- **Foot pedal / Stream Deck + remap UI** — persistence and remapping over the existing keyboard
  path, no native HID dependency, because both device classes enumerate as keyboard HID. Capture
  records whatever code the pedal sends. `isSafeBinding()` is enforced on save, so a destructive
  action can never be remapped onto a tap.
- **Weekly templates and confidence tuning** — sliders seeded from the real constants, each
  explaining the consequence of lowering it.
- **i18n completion** — an audit script that finds missing, unused and divergent keys, a
  pseudo-locale, and tests asserting EN/KO key parity and matching interpolation placeholders.
- **Packaging** — electron-builder NSIS installer, plus `NOTICE.md` (249 KB) generated from the
  production dependency tree, and an updater that will not install during a service.
- **Playwright e2e** — 8 tests driving the real built Electron app.
- **Docs** — `GETTING_STARTED.md`, `RUNBOOK.md`, a rewritten `README.md`, and a finalised
  `HUMAN_TASKS.md` grouped by what each item unblocks.

### The single most valuable e2e assertion

Test 4 — *"a lower third fired in the control window appears in the overlay page"* — opens the
overlay URL in a second page and checks the DOM after firing from the control UI. That is the
whole renderer → IPC → overlay server → browser-source path proven end to end, in the real app.
It is the one thing this machine can genuinely prove about the product, and it now passes.

### Two more instances of the recurring wiring bug — the fifth and sixth

Both were **reported honestly by the agents that wrote them**, which is why they were fixed:

- **`ShortcutSettings` was unreachable.** Built, 64 tests passing, and never rendered — not even
  in the Vite bundle graph. `App.tsx` still passed a hardcoded binding list. Now the app owns the
  binding state and feeds both the keyboard hook and the settings screen.
- **The scripture resolver was never connected.** `registerIpc` hard-coded `scripture: null`, so
  `cueResolveScripture` answered NOT_CONFIGURED *even with `ESV_API_KEY` set* — a detected
  reference was offered with no text and nothing said why. Now defaulted via
  `getScriptureResolver()`, with `scripture: null` still available to disable it explicitly.

The Phase 9 wiring test did not catch either: one is renderer-side, and the other looked like a
legitimately-optional dependency. The lesson generalises — **"optional dependency" and
"unconnected wire" are indistinguishable from inside a unit test.**

### Two tests caught my own mistakes during integration

- The **e2e** failed on `toHaveCount(11)` after I added a 12th tab. Correct behaviour; updated to
  12 with a comment explaining the brittleness is deliberate.
- The **i18n audit** failed on `app.section.shortcuts`, missing from both locales — I had added
  the tab and not its strings. Added (`Shortcuts` / `단축키`), audit now exits 0.

### FINAL STATE

All ten prompts complete. 1,925 unit tests, 8 e2e tests, both typechecks clean, a working
installer, and every phase pushed to `github.com/kimbolt1109/rhema_v3`.

### What has never been verified — read this before trusting anything

This build has **never connected to a real OBS, YouTube, or Deepgram**, because none exists on
this machine and none was obtainable. Specifically unproven:

- **No camera has ever been switched, no stream started, no recording made.** All OBS behaviour is
  covered against a hand-written mock.
- **No YouTube broadcast has been created.** OAuth and the API are mock-tested with zero network.
- **No real speech has been transcribed.** The local faster-whisper sidecar genuinely runs
  (model loads in 0.8 s, inference 0.12 s, CUDA visible) but has only ever been fed synthesised
  tones. Deepgram has never been contacted.
- **No real `.pptx` has been converted** — LibreOffice cannot be installed here.
- **No overlay has been composited over live video** in an OBS Browser Source; the page has been
  fetched and driven, not broadcast.
- **The installer is unsigned** — no code-signing certificate exists, so Windows SmartScreen will
  warn.
- **No foot pedal or Stream Deck has been attached.** That they work is an inference from both
  being keyboard-HID, plus a test proving capture records an arbitrary key code.

The failure-mode work in Phase 9 is proven against *models* of each failure, not the failures
themselves. `HUMAN_TASKS.md` lists the verification still owed, in the order a real operator
would need it.

## Cycle 10 — COMPLETE

Blueprint achieved across all ten prompts. Awaiting human review and a real-environment dry run.

## Cycle 11 — Portable build, self-serve PowerPoint rendering, auto-anchor, Preflight, operator docs

Post-blueprint work driven by a real operator preparing to test on a church PC. Branch
`portable-and-ui`.

Delivered:

- **External `config.json`** next to the launcher (OBS host/port/password, overlay port, ASR
  engine), resolved deterministically beside the exe when packaged; the dev `.env` flow is
  byte-for-byte unchanged.
- **Portable `--dir` packaging** — `npm run portable` builds a copy-to-USB `win-unpacked` folder
  (audit confirmed zero native deps) with `START.bat` (drive-letter-safe, pause-on-crash),
  `config.json`, the operator docs, and the pre-baked plans.
- **Local-Whisper packaging fix** — the packaged app now resolves the faster-whisper runtime under
  `process.resourcesPath` (was hardcoded to `process.cwd()` with `isPackaged:false`, so offline
  transcription could never start when packaged).
- **Opt-in auto-anchor from slide text** — importing a deck can pre-fill each slide's trigger from
  its own words, so read-aloud parts auto-advance. Safe under the default assist mode (suggests,
  never self-fires). Slide text is read only when asked, lives only in the operator's local plan,
  and is never logged; tests use placeholder strings (Standing Rule 4).
- **In-app PowerPoint slide rendering (the important one)** — real-deck testing exposed that
  LibreOffice's one-shot `--convert-to png` renders only slide 1, leaving text-only slides blank.
  Added a PowerPoint renderer, preferred on Windows: the importer spawns a bundled PowerShell COM
  helper (`resources/powerpoint/export-slides.ps1`) that opens the deck READ-ONLY with macros
  force-disabled — in PowerPoint's own process, not inside Electron — and exports every slide. The
  app now renders every slide itself; it falls back to LibreOffice then embedded pictures.
- **Preflight screen** (auto-shown on first launch on a new machine) — OBS / scenes /
  overlay-server / browser-source / audio-device / config checks with plain-language fixes, plus
  Test-lower-third and Test-camera-scenes buttons reusing the real overlay/camera paths.
- **Operator docs shipped on the USB** — `RUNBOOK.md`, `obs/OBS-SETUP.md`, `SETUP-ASR.bat`,
  `ASR-SETUP.md` (shortcuts, panic semantics, and setup steps verified against the source).

Verification update (correcting the Cycle 10 "never verified" list):

- **A real `.pptx` HAS now been converted.** LibreOffice *and* PowerPoint were installed this
  session; the operator's two real decks (102 and 48 slides) were imported through the app's own
  `importDeck` via PowerPoint — 102/102 and 48/48 slides rendered, 75 and 43 slides auto-anchored,
  0 invalid cues — and baked into the USB folder as ready-to-open plans.
- Still unverified and owed to the on-site test: a real live OBS connection, a real dry-run go-live
  with recording confirmed, real speech transcribed against a live mic, and the installer remains
  unsigned. The GUI has not been launched headlessly — the operator's church-PC test is the final
  proof.

1964 unit tests green; tsc node + web clean; i18n audit PASS.

## Cycle 12 — UI redesign: slide grid + bottom bar + settings drawer

TASK 2 of the operator's handoff, on branch `portable-and-ui`. The console was thirteen tabs, a
title bar, a health strip and an always-present suggestion strip. It is now two things — a slide
grid and one bar — with everything else behind a gear icon. **A re-composition, not a rewrite:**
all thirteen screens render inside the drawer unchanged, with the same props and the same tests.

Delivered:

- **Slide grid** (`components/SlideGrid.tsx`) — the whole surface, modelled on PowerPoint's slide
  sorter. `repeat(auto-fill, minmax(220px, 1fr))`, 16:9 tiles, slide number in the corner. NOW gets a
  thick accent ring + glow, NEXT a thinner dimmer one, everything else dims. Tap to jump. The grid
  follows the current slide and **stops following for 1.5s whenever the operator scrolls by hand**,
  so looking ahead mid-service does not fight the app. Tiles are numbered by *plan index* and every
  cue gets one, including non-slide cues — a slides-only grid would make "jump to tile 40" fire a
  different cue than the one under the operator's finger.
- **Bottom bar** (`components/BottomBar.tsx`) — 80px, and **the bar itself is the progress
  indicator**: a fill across its full width whose width is the cue engine's match confidence for the
  next cue. Left: tally dot (red = ON AIR, amber = standby, grey = off air), elapsed, REC, OBS state.
  Centre: the big tabular-nums percentage plus now → next. Right: four camera buttons, the
  lower-third toggle, GO LIVE / END (END via `HoldButton` when `endRequiresHold`), and the gear.
  With nothing pending it shows an em dash, never `0%` — "nothing to report" and "reported no
  confidence" are different facts. Streaming without recording gets a red `NO REC` alert
  (Standing Rule 3).
- **Settings drawer** (`components/SettingsDrawer.tsx`) — slide-over, `Ctrl+,` to open, `Esc` to
  close, backdrop-click to close, `role="dialog" aria-modal="true"`, focus moved in and handed back.
  Reuses the old `app.section.*` label keys, so no new copy and no window where `ko` lagged `en`.
  Closed it renders `null`, so none of the thirteen screens' IPC subscriptions are live. The runtime
  versions moved into its header — they are the first thing any bug report needs and the title bar
  they used to live in is gone.
- **Two new colour tokens** — `tally` (on-air red) and `warn` (amber). The theme had neither; the
  health strip uses `accent-2` for `degraded`, which is right there and wrong beside a grid that
  rings the current slide in indigo.
- **`config.json`'s `assets.plan` is now read at launch.** It had been in the schema, unread, since
  the portable build landed, while `RUNBOOK.md` told the operator it selected the plan. It matters
  more now: the grid *is* the console, so a launch with no plan open is a blank window. The shipped
  config points at `plans/11am/plan.json`, resolved relative to the folder `config.json` sits in — so
  it means the same thing whatever drive letter the USB stick gets.

Bugs found and fixed (all pre-existing, all invisible):

- **Every slide thumbnail in the app was a 404.** `CuePreview.defaultAssetUrl` built
  `/plan-assets/…` behind an `ASSUMPTION:` comment; `OverlayServer` serves `OVERLAY_ASSET_PATH`
  (`/assets`) and has since Phase 6. Nothing failed loudly — a broken `<img alt="">` is an empty box,
  and every unit test injected its own resolver, so the default resolver was the one path nobody
  exercised. Now built from `@shared/net`'s `overlayAssetUrl`, with a regression test asserting the
  component has no second opinion about the route.
- **The renderer's CSP would have blocked those images anyway.** `img-src 'self' data:`, and the
  renderer is loaded with `loadFile`, so its origin is `file://` and `'self'` does not cover
  `127.0.0.1`. Widened to `http://127.0.0.1:*` — loopback only, exactly like `connect-src`.
- **The documented keyboard shortcuts did nothing.** `App.tsx` filtered the operator's keymap down to
  `confirm` and `dismiss` before handing it to the keyboard hook, and the only handler registrations
  in the renderer were `SuggestionPanel`'s two and `PlanRunner`'s two — the latter on a dispatcher it
  created itself. So on the shipped app `Y` and `N` worked and nothing else did: SPACE did not
  advance, `1`–`4` did not switch cameras, SPACE-hold did not PANIC. `RUNBOOK.md` listed them all as
  working. `input/useServiceActions.ts` is now the single registration site for all nine implemented
  actions, and the shell filters the keymap through `isImplementedAction` so a key bound to an
  unimplemented action keeps its browser default instead of being swallowed.
- **A failed image fetch was silent.** `CuePreview` and `SlideGrid` now fall back to the labelled
  placeholder on an image error, so a plan whose `assets\slides\` folder did not reach the USB stick
  shows grey tiles with an icon — which is what `RUNBOOK.md` tells the operator to look for — instead
  of a wall of empty rectangles.
- **Phase 6's `PlanRunner` is never mounted.** Found while auditing: 494 lines and a full test file,
  referenced only from comments. `SlideGrid` now genuinely fills that role. Left in place rather than
  deleted, and recorded here so it is a decision rather than an oversight.

Deliberately NOT done, and said plainly rather than faked:

- **`output.black`, `output.logo`, `output.freeze` remain unimplemented.** obs-websocket has no
  generic "black the program" call and doing it properly needs the operator to nominate a scene,
  which is configuration this app does not have. The brief asked for `B` = blackout; `B` keeps its
  1.5s destructive-hold gesture reserved so blackout can never later arrive as a tap, PANIC stays on
  SPACE-hold where `SHORTCUTS_AND_A11Y.md` wants it, and `RUNBOOK.md` now carries a "listed but not
  implemented yet" table instead of promising three dead keys.
- `→` / `←` are `PEDAL_ALIAS_BINDINGS`, not defaults. `mergeWithDefaults` lets a stored binding
  replace the defaults for its action, so a new default would have reached a fresh install and
  silently skipped any operator who had ever customised anything — backwards for an alias whose whole
  job is working out of the box on a foot pedal.
- `PreflightScreen` still ships hardcoded English (the operator works in English; the audit reports
  it), and `CueRow`'s drag handle is 32px, under the 44px floor. Both are inside the drawer.

Verification, all run this session:

- **2108 unit tests green across 74 files** (was 1964 across 68 — six new test files: SlideGrid,
  BottomBar, SettingsDrawer, CuePreview, useServiceActions, App).
- `tsc --noEmit` clean for both projects; `npm run build` clean; i18n audit **PASS**.
- **All 9 e2e tests green against the real packaged app**, including a new one proving a cue added in
  the plan editor appears as a tile on the operating surface and is still there after a renderer
  reload — the thing `PlanRunner` never proved, because it was never on screen.
- **The slide chain proven end to end on the real exe.** Launched
  `release/0.1.0/win-unpacked/Verger.exe` and fetched
  `http://127.0.0.1:7320/assets/slides/11-slide-001.png` → **HTTP 200, image/png, 161,249 bytes**,
  byte-for-byte the file on disk, at exactly the URL `defaultAssetUrl` builds. A missing file still
  404s. That single request proves config.json → plan auto-opened → asset root mounted → `/assets`
  route → the `<img src>` the grid emits.
- USB folder rebuilt and both real decks re-baked through the app's own importer via PowerPoint:
  102/102 and 48/48 slides rendered, 75 and 43 auto-anchored. 427.7 MB.

Still owed to the on-site test, unchanged from Cycle 11: a real OBS connection, a real go-live with
recording confirmed, real speech against a live mic, and the build remains unsigned.

## Cycle 13 — Bring in any image or video, and play video on the overlay

The operator asked whether they could upload any PowerPoint, video or image, not just the two decks
that were prepared for them. The honest answer was one yes and two noes, so the two noes were built.

Where it stood:

- **`.pptx` — already worked.** `Plan → Import deck…` opens a real file dialog on any `.pptx`
  anywhere on the machine, renders every slide through PowerPoint, and **appends** to the current
  plan (so several decks can make one service). Two limits found and now documented rather than
  discovered on a Sunday: legacy `.ppt` cannot be read (the importer unzips the file, and `.ppt` is
  not a zip — Save As `.pptx` first), and a deck can only be imported once the plan has been **saved**,
  because the images are written beside the plan file.
- **Images — no route at all.** A `slide` cue could only name a file already sitting inside the plan's
  asset folder, with the relative path typed by hand.
- **Video — deliberately refused.** `PlanService` refused every `media` cue because
  `TriggerMediaInputAction` is not on `ALLOWED_WRITE_REQUESTS` (Standing Rule 2). That refusal was
  correct and stays; what it hid is that widening the allowlist would not have helped anyway, since
  that OBS action only restarts a source somebody had already added to OBS by hand.

Delivered:

- **`Add image / video…`** in the plan editor. A file dialog, then the file is **copied into the
  plan's own `assets` folder** (`slides/` for stills, `media/` for clips) and a cue is appended for
  it. Copied rather than referenced on purpose: a cue pointing at someone's Desktop breaks the moment
  the USB stick reaches the church PC. `src/main/plan/assetImport.ts` does the copying —
  extension-classified, basename-sanitised, containment-proved, and **never overwriting** (a second
  `logo.png` becomes `logo-2.png`, enforced by `COPYFILE_EXCL` rather than an exists-check, so two
  imports cannot race). Hangul filenames survive intact; `.svg` is excluded as a scriptable document.
- **Video plays on the overlay's full-frame slide layer.** `overlay.js` builds a `<video>` when the
  source is a clip and keeps the existing cross-fading `<img>` pair otherwise. No protocol change:
  `SlideState` is still `{visible, src}` and `slide.show`/`slide.hide` are still the only commands.
  A slide and a video are both full-frame content and only one can be on screen, so sharing one layer
  makes that exclusion structural instead of a convention — and it means **hiding the slide layer is
  already the stop button for a video, audio included**, which is the one thing an operator must be
  able to do instantly when a clip misbehaves on air.
- **`media` cues now route by whether they name an OBS input.** No `obsInputName` — the "operator
  added a file" case — goes to the overlay and never touches OBS. A cue that *does* name an input is
  asking Verger to drive a source inside the operator's own OBS, and gets the same allowlist refusal
  as before, unchanged. The test asserts **zero OBS calls** on the overlay path even with the guard
  wide open, so a future change cannot quietly start routing video through OBS.
- **Autoplay with audio, honestly.** Chromium blocks autoplay-with-audio without a gesture and an OBS
  Browser Source has no gesture; OBS passes `--autoplay-policy=no-user-gesture-required` so it works
  there. The page calls `play()`, retries once muted if that rejects, and reports which happened on
  the `?debug=1` HUD — so "no audio" is distinguishable from "not playing" instead of both looking
  like a frozen frame. The Browser Source needs **Control audio via OBS** on, now documented.
- Docs: `RUNBOOK.md` and `obs/OBS-SETUP.md` cover the three import routes, the supported extensions,
  the two `.pptx` limits, the audio setting, and video's place in the manual-fallback plan.

One guard worth naming: the video extension list now exists in **three** places — the importer, the
IPC boundary's dialog filter, and `overlay.js`'s own copy (the overlay page is loaded raw as a browser
source and cannot import from `src/`, exactly like `protocol.js`). Drift there is silent and ugly: a
new extension would import fine, become a `media` cue, fire, and render as a **broken image** on the
congregation screen. `assetImport.test.ts` now reads `overlay.js` as text and compares the lists.

Verification, all run this session:

- **2145 unit tests green across 75 files** (was 2108 across 74; +36 for `assetImport`, +2 for the
  media routing, +1 drift guard). `tsc` clean both projects, `npm run build` clean, i18n audit PASS,
  and all **9 e2e tests** green against the real app.
- **Proved end to end against the running app**, not just in units. A `.png` and a `.mp4` from outside
  the plan folder were imported through the real IPC path: the image landed in `assets/slides/`, the
  clip in `assets/media/`, both got the right cue type and a label from the filename, the grid
  rendered the image tile, and the overlay server served it at
  `http://127.0.0.1:7320/assets/slides/PLACEHOLDER%20logo.png` → **200, image/png, 161,249 bytes**
  (note the space correctly percent-encoded). A `.txt` was refused at the boundary. Firing the media
  cue made the overlay build a **`<video>`** with the right URL, clear the image frame, and report
  `will not play` on the debug HUD — correct, because the test file was 18 bytes of text.
- **NOT verified: decoding a real video.** There is no genuine video file on this machine, so the
  element choice, the URL, the error path and the audio plumbing are proven but playback itself is
  not. That is the first thing to try at church: add a real clip, fire it, and confirm both picture
  and sound reach the stream.

## Cycle 14 — Visual refinement: colourless chrome, state-only colour

The operator's words: "it looks kind of vibe coded and I don't like vibe coded looks". They were
right, and the diagnosis was specific rather than a matter of taste:

- **Indigo `#6366f1`** — Tailwind's default indigo-500, the most template-looking colour in the
  ecosystem — on the rings, the focus ring, every primary button, and a coloured drop-glow.
- A **coloured glow** plus a 4px ring plus a border: three treatments doing one job.
- **14px radii on everything**, a 220px slide tile sharing a corner with a 44px gear.
- A **blue-tinted near-black** `#0a0a0f` base, which is exactly the generated-dark-theme cast.
- **`opacity-50` on non-current tiles**, writing to the same channel as `disabled:opacity-60`, so a
  hundred of a hundred and two tiles read as dead controls rather than as content.
- A bottom bar of **floating text with no structure**, where the em-dash placeholder read as a stray
  horizontal rule.

Three independent design directions were explored against the reference class (ATEM Software
Control, vMix, QLab, Chamsys, camera control units) and judged; the synthesis is below.

### THE ONE COLOUR RULE, now written at the top of `index.css`

A **filled saturated field** is a STATE of the system — a lamp, a rail, a frame, the bar's left edge.
A **saturated border plus a tint of at most 18%** is an AFFORDANCE about a state — GO LIVE, END,
NO REC, the live camera cap. Saturated colour is **never a text colour and never a text background**.
Everything else is graphite.

That rule is why this now reads as equipment, and it is enforceable in review: a coloured button, a
coloured heading or a coloured icon is visibly wrong by construction.

### What changed

- **The accent is no longer a hue.** `--color-accent` is CHALK `#c9c7c0`, a dead neutral whose only
  job is brightness — focus, the gauge needle, a pressed control's tint. Hue is freed entirely for
  state, so the answer to "what colour is the accent" is "none, and that is the point".
- **Program red / preview green for NOW / NEXT.** Not a style choice: it is what every switcher this
  operator has ever touched puts in their hands. The NOW tile is the program bus — a 3px red ring, a
  2px page-black gap, a 1px red border, a 4px filled bottom rail and a badge reading NOW. NEXT is a
  single 2px green line with no rail. They differ in **structure and mass (3:1) before they differ in
  hue**, so a colour-blind operator reads them apart. Amber is thereby freed to mean exactly one
  thing: caution / in transition.
- **A `keyline` shadow — a 1px page-black gutter — on every tile.** Load-bearing, not decoration:
  program red against a mid-grey slide measures 1.02:1, so without that gutter the NOW frame would
  vanish into a real deck. Red's faces now only ever touch the page background, at 5.30:1.
- **All tile opacity deleted**, overruling all three proposals. Calm comes from the chrome instead —
  a hairline at 1.70:1, the ink gutter, letterbox bars at page-black, and the fact that a non-current
  tile carries no emphasis treatment at all. Read direction is carried by position: an already-fired
  tile gets a 2px bottom rule, which finally makes `data-fired` mean something on screen.
- **Five radii whose ratio falls as the element grows** (2px chip / 3px control / 4px panel / 6px
  tile / 0 for structure). The legacy `glass*` keys are repointed rather than renamed, so ~160 call
  sites became correct without a repo-wide edit. 14px on a 220px thumbnail was the loudest tell.
- **Six shadows, none coloured**: `edge` (a machined 1px top highlight), `keyline`, `recess`, `lamp`,
  `lift`, `panel`. `shadow-glow` is aliased to the hueless keyline so its four remaining call sites
  degrade correctly; its old value was also a hard-coded hex in violation of the theme's own rule.
- **A seven-step type scale** with tabular, lining, slashed-zero numerals everywhere a number is
  read. The old surface jumped from 11px straight to `text-4xl` with nothing between.
- **The bar is now an instrument panel**: five columns with 1px milled grooves, a fixed 320px status
  zone (the percentage used to drift sideways whenever the OBS state word changed length), a
  two-row baseline, an **opaque** gauge trough with a chalk needle and a 25/50/75 tick scale, and the
  clock as a recessed display. The three tally states are told apart by FORM — bare beside a lit lamp
  and a red edge rail, boxed in an amber hairline, or muted beside an unlit lamp — so the word never
  loses contrast and colour is never the only channel.
- **A latent bug fixed on the way**: the gauge fill was `bg-accent/25`, translucent, and swept under
  the status zone — compositing the ON AIR word down to 2.75:1. An opaque trough makes every contrast
  figure on the bar exact.
- `hover:-translate-y-0.5` deleted from tiles (a wave of lifting thumbnails reads, in peripheral
  vision, as a cue firing), `float` and `glow-pulse` keyframes deleted outright (both unreferenced),
  and the spring easing with overshoot replaced by one `ease-instrument` curve.
- `HoldButton` gained an optional `sizeClass` prop, fixing a real `min-width` collision: both it and
  `className` set `min-width`, and the winner depended on stylesheet order, so an 80px bar could not
  host a 72px-minimum control.

Deliberately NOT done, and scoped as follow-up: the thirteen drawer screens keep their existing
markup. They inherit every new token automatically and look consistent, but their ~40 uppercase
`tracking-widest` headings and ad-hoc `text-[Npx]` sizes have not been moved onto the type scale, and
their per-component focus rings have not been consolidated onto the single global outline. Nothing
there is wrong; it is simply not yet on the scale.

Verification: 2145 unit tests across 75 files (unchanged — the restyle touched no behaviour), `tsc`
clean both projects, `npm run build` clean, i18n audit PASS, all 9 e2e green. Checked by eye at
1366×768 against the real 102-slide deck, which is how the one genuine defect in the first pass was
caught and fixed: the recessed clock well containing only an em-dash read as broken hardware, so the
well now appears only when there is a time to show.

## Cycle 15 — The drawer sweep: one type scale, one focus ring, and four invisible buttons

Cycle 14 left the thirteen drawer screens on their original markup. They inherited every new colour
token and looked consistent, so the remaining gap was described as "~40 uppercase `tracking-widest`
headings and ad-hoc `text-[Npx]` sizes". **Measuring it first showed that description was wrong on
both counts**, which is the reason this entry leads with numbers:

- `tracking-widest` appeared in **zero** live drawer screens. The six hits were in `SlideGrid`,
  `BottomBar` and `HoldButton` — all already swept, all using `tracking-[0.08em]` deliberately —
  plus the never-mounted `PlanRunner`.
- Ad-hoc `text-[Npx]` was **15 sites**, not the bulk.
- The actual work was **418 default-Tailwind font-size utilities**, 52 `uppercase`, and **37
  per-component focus-ring runs**.

That gap matters because the default sizes were not merely off-scale. `fontSize` in
`tailwind.config.js` **replaces** Tailwind's scale wholesale, so `text-sm` emitted no font-size rule
at all — every one of those 418 elements was silently falling back to inherited size.

### The mapping, and the one thing that could have silently broken it

The new steps bake a `font-weight` into each `fontSize`. Before rewriting anything, the emitted
stylesheet was checked for rule order: weight utilities land at byte offsets 240–243 and `uppercase`
/ `tracking-*` at 244/254, **after** every `fontSize` rule (226–239). So an explicit `font-*` always
beats a baked weight, and no site that already declared one could be restyled by accident. Sites
with **no** weight class do pick up the scale's weight, which is intended — Inter is not bundled, so
a stock Windows church PC resolves to Segoe UI, where 500 at 12–13px is materially more legible in a
dark booth than 400.

Where a step that bakes ≥600 landed on a value or a paragraph — an `<input>`, a `<select>`, a
`<p>` — `font-normal` was pinned explicitly, because a form field's value rendered semibold reads as
a label. That is why the transcript paragraph and every text input carry an explicit weight now.

`text-sm` resolved by the element's role rather than by a blanket rule: `text-label` (15px/600) on a
`<label>`, `<button>`, heading, `<legend>`, `<th>` or `<dt>`; `text-body` (13px/500) on prose. An
uppercase eyebrow at any small size became `text-micro`, which already bakes 600 weight and 0.08em
tracking — exactly what an eyebrow wants, and the only step the scale permits to take `uppercase`.

### Four invisible buttons — a real defect, found on the way

Cycle 14 repointed `--color-accent` from indigo to CHALK `#c9c7c0`. `Button.tsx` was corrected for
this and its docstring even records why. **Four hand-rolled buttons were not**, and they kept
`bg-accent` with `text-text`:

| Control | Where |
|---|---|
| **GO LIVE** — the biggest control in the app | `GoLivePanel.tsx` |
| **Accept cue** — tapped mid-service, on screen during the service | `SuggestionPanel.tsx` |
| Retry after a partial go-live | `GoLivePanel.tsx` |
| Resume from panic | `TrustDial.tsx` |

Chalk `#c9c7c0` against text `#e8e7e2` measures **1.37:1**. Those labels were not low-contrast, they
were *invisible*, and `CueRow`'s fire button had the same fault on hover. The fix is not to recolour
the label: ERGO-1 forbids a light filled surface in a dark booth outright, so all five adopt the
outlined cap `Button.tsx` already documents — `border-accent bg-surface-2 shadow-edge
hover:bg-surface-3`, where the brightest border in the row is all "primary" has to mean. The correct
pairing measures 11.49:1.

`shadow-glow` went with them: it aliases to a page-black keyline, which is a *tile* treatment and
does nothing useful on a control.

### One focus ring, made load-bearing rather than merely stated

37 controls each re-declared `focus-visible:outline-none` plus a box-shadow ring. That pattern is
self-defeating: the `outline-none` half is precisely what suppressed the global outline, so every
control had to opt back in by hand and any that forgot shipped with **no ring at all** — the exact
defect v2 logged as focus-visible "not yet standardized" (`SHORTCUTS_AND_A11Y.md` §9.5). All 37 are
gone; the single `:focus-visible` rule in `index.css` now applies because nothing overrides it.

Two deliberate calls inside that: `HoldButton`'s ring was panic-tinted, and is now the same chalk as
everything else — a focus ring answers "where is my keyboard", not "this is dangerous", and the hold
button is already marked by its panic border and tint. `TranscriptPanel`'s scroll container keeps an
inset ring, expressed as `focus-visible:[outline-offset:-2px]`, because it sits flush inside a
bordered panel where an outset outline clips.

### Guards, so this cannot rot

`src/renderer/styles/typography.test.ts` asserts, over every non-test renderer source: no default
Tailwind size, no ad-hoc px/rem size, and no per-component focus ring. It reads source through
Vite's `?raw` glob rather than `node:fs` on purpose — the renderer tsconfig is DOM-only because "the
renderer never touches Node" is an architecture invariant, and a guard that forced `@types/node`
into `tsconfig.web.json` would erode the boundary it exists to protect. It strips comments before
matching, so a note explaining *why* a class is banned does not read as a violation, and it asserts
its own file list is non-empty so a bad glob cannot turn it into a vacuous pass.

The guard earned itself immediately by catching `text-[0.65rem]` (10.4px) in `ShortcutSettings` — a
"Hold only" badge under the 11px floor, which the initial `text-[Npx]` scan had missed because it
only looked for `px`.

e2e test 9 asserts the other half against the packaged app: Tab to a control, then measure that the
outline really is 2px solid `rgb(201, 199, 192)` at 2px offset. Between the two, a control cannot
ship ringless — it can no longer suppress the outline locally, and deleting the global rule goes red.

`tailwind.config.js` now excludes `*.test.{ts,tsx}` from `content`. A test that merely **names** a
class was emitting a real rule into production CSS: the new guard names every size it forbids, and
without that exclusion all of them shipped. The stylesheet went 46.94 kB → 45.96 kB and now contains
the seven scale steps and none of the eight defaults.

`PlanRunner` and `TuningSettings` were swept too, despite being dead code (defined, exported,
imported nowhere). Tailwind scans the whole renderer, so leaving them off-scale kept the old size
utilities in the shipped CSS and made the guard impossible to state as "zero".

### Known deviations, recorded rather than silently changed

`StatusDashboard`, `GoLivePanel` and `TrustDial` use saturated colour as a **text** colour for status
words, which THE ONE COLOUR RULE reserves for fields and borders. It is left alone: every instance
is paired with an icon shape (⊘ / ⚠ / ✓) so colour is never the only channel, and each clears
contrast on its surface. Worth a later pass; not worth a silent redesign inside a typography sweep.

Verification: **2149 unit tests across 76 files** green, `tsc` clean both projects, `npm run build`
clean, i18n audit PASS, **10/10 e2e** against the real packaged app. Checked by eye at 1366×768
across seven drawer sections — the legends now sit in the fieldset borders like panel labelling, and
GO LIVE has a readable label for the first time since Cycle 14.

---

## Cycle 16 — Live captions: the recogniser on the congregation screen, and its kill switch

Asked for as "since we already have to do STT real time maybe add a feature of showing the STTed
results". The ASR already ran and its text already reached the cue engine; nothing rendered it. Two
commits, deliberately split — `fa9ce9b` builds the engine with **no way to switch it on**, `136c3bd`
makes it reachable — so the layer could not activate on a half-finished path.

### A fourth layer, not the lower third

Layers are independent by the shape of the data, not by discipline. A caption changes several times
a second; sharing the lower third's layer would mean **speech could blank a speaker's name**.
`OVERLAY_LAYERS` gains `caption`, and the reducer test iterates `OVERLAY_COMMANDS` × `OVERLAY_LAYERS`
generically, so the new layer had to prove independence rather than be asserted to have it —
including under 50 successive `caption.show` commands at ASR partial-result rate. `clearAll` now
loops the layer list instead of naming three, so future layers auto-enrol.

### Why the safety lives in the driver, not the protocol

Every other layer carries text a human approved: a lower third is typed by the operator, scripture
comes from a licensed API, a slide was prepared during the week. **A caption is whatever the
recogniser thought it heard, on the congregation screen before anyone could veto it.** Standing Rule
1 says design for veto, not trust, so `CaptionService`:

- is **OFF by default and after every launch**, never persisted on;
- on `setEnabled(false)` sends `caption.hide` **unconditionally**, not "if we believe something is
  visible" — the moment the operator reaches for the kill switch is exactly when the service's
  belief about the screen is least worth trusting;
- treats **drafts** (in-flight partials, which visibly rewrite themselves) as opt-in;
- hides the layer after **6s of silence**, so the last sentence before a prayer is gone by the time
  heads are bowed.

The overlay page renders caption text through `setText`, never `innerHTML` — a sharper reason than
for the other layers: an ASR transcript is an untrusted string nobody approved, arriving several
times a second, reaching the congregation faster than any human could stop it. Drafts are dimmed so
a partial reads as a partial at projection distance without being read.

Standing Rule 4 is not in tension: this transcribes speech in the room. No verse text, lyric or
sermon content is authored into the repo — fixtures are invented placeholders throughout.

### Windowing is load-bearing

`caption.show` caps text at 400 characters and **rejects** anything longer rather than truncating —
so an un-windowed caption does not clip, it **stops appearing partway through a sermon, silently**,
because the schema refused it. `windowCaptionText` keeps the most recent 400 characters and prefers
to open at a word boundary, but only a **nearby** one (`CAPTION_WORD_BOUNDARY_SLACK = 40`): Korean
is written with far fewer spaces than English, so honouring a boundary 200 characters in would
discard half the caption to gain a tidy first word. A test asserts the function's cap and the
schema's cap agree, because drift between them is invisible to every other test and fatal in a
service.

### Fixed on the way — captions would never have rendered at all

`src/overlay/protocol.js` is a hand-kept mirror of `shared/overlay.ts` (the page is framework-free
and cannot import from `src/`), and its normaliser builds an explicit object literal: it **dropped
`caption` entirely**, so `renderCaption` always received `undefined`. `README.md` line 41 states the
rule that was missed. The mirror now carries the layer, and it **coerces** a missing caption rather
than rejecting the snapshot — the one layer exempt from missing-layer-is-fatal, and the exemption
follows that rule's own logic: rejecting is right when inventing "hidden" would blank something on
air, but a layer that is off by default cannot be in that position, whereas treating it as fatal
would freeze the whole overlay on stale content.

`CaptionRuntimeState`, the cap, the idle delay and `windowCaptionText` live in `shared/caption.ts`,
not beside the service. That is a constraint, not tidiness: the type crosses IPC to the booth UI and
the renderer must never import main-process code (`tsconfig.web.json` leaves `@main/*` unmapped so
the preload bridge stays the only channel). The barrel deliberately does **not** re-export it —
offering a second import path for a boundary-crossing type is how one side ends up on a stale copy.

### Three ways to switch, because "easy to turn off" was the requirement

| Control | Where | Note |
|---|---|---|
| **`C`** | anywhere, drawer open or shut | one **tap**, not a hold |
| **CC button** | bottom bar, beside L3 | program **red** when on |
| Full controls | Setup → Overlay | includes the draft setting |

`C` is a tap, deliberately inverting this repo's rule that consequential actions are holds. A hold
exists to stop a reflex doing something irreversible — but here **the dangerous state is captions
being ON**, so the operator must kill them as fast as they can move. Turning them back on is the
cheap, reversible direction.

The bar's ON state uses **program red** rather than the chalk the L3 toggle uses, and the departure
is the point: an overlay the operator authored is a *control* state, but unreviewed machine text
going out is an **output** state and belongs in the same visual language as the tally lamp. Rail
plus the letters `CC` means it reads without colour too.

**The switch is never optimistic.** `captionStore` does not touch local state before the main
process answers, and settles on the pushed `caption:state` event rather than the call's return
value. That is the opposite of what feels responsive, and it is the point: a UI that flipped to Off
the instant it was clicked would tell the operator the congregation screen is clear at the moment we
do not yet know that. **The lag is the honesty.** Tested by observing state synchronously mid-flight
— which only means something because the mock now pushes on a later tick; it used to notify
synchronously inside the invoke, which real IPC cannot do, and that synchronous double hid exactly
the behaviour worth testing.

### Found and fixed, and it predates this feature

**`/12` is not in Tailwind's opacity scale**, so `bg-panic/12` and `bg-tally/12` generated **no rule
at all**. Five sites, four of them shipped in Cycle 14 — including the **`NO REC` pill**, the
Standing Rule 3 indicator that is supposed to be a red-tinted warning and had no tint, plus
`Button`'s danger variant and `HoldButton`. All five now use the arbitrary form `/[0.12]` this
codebase already used elsewhere (`bg-tally/[0.18]`). Verified against the built stylesheet and then
on the live DOM: computed background went from `rgba(0,0,0,0)` to `rgba(239,74,62,0.12)`. Found only
because a screenshot probe reported a transparent background where a tint was expected — **no test
would have caught it**, and none of the existing ones did.

### Proof on a real socket

e2e test 10 drives a real browser source: switches captions on through the UI, puts a caption on the
layer, asserts the text in the page's DOM, asserts the other three layers are untouched, then
switches **off** and asserts the layer is hidden with text visibly on it a moment earlier. That last
assertion is the whole feature's safety property, checked rather than argued for in a comment — and
it is also the test that would have caught the `protocol.js` mirror bug above.

`RUNBOOK.md` gains a captions section written to be read **before** switching them on: that nobody
proofreads the text, that off is instant, and that "nothing appears" is normal without a recogniser
configured. It also corrects two passages that had described the pre-restyle UI since Cycle 14.

Verification: **2229 tests across 79 files**, `tsc` clean both projects, build clean, i18n audit
PASS, **11/11 e2e** against the packaged app, checked by eye at 1366×768.

---

## Cycle 17 — Read OBS's own WebSocket settings, and connect at launch

Prompted by the operator's real objection: *"the setup steps are really complicated and may not
deliver the outcome we want."* They were. `OBS-SETUP.md` asked for the **same secret three times** —
read it out of OBS's Connect Info dialog, paste it into `config.json`, then paste it **again** into
the Connection screen, which does not read `config.json`. Three chances to typo one string on a
Sunday morning, and the failure presents as "Password rejected" rather than as a typo.

OBS already stores its port and password in a plain JSON file. Verger now reads it. Setup is: switch
the WebSocket server on in OBS, launch Verger. Steps 2 and 3 of `OBS-SETUP.md` are demoted to the
unusual cases — OBS on another machine, a deliberately changed port, or a connection that did not
come up on its own.

### Read, never write

Standing Rule 2: OBS is the resilient engine and this app imposes nothing. Verger will not enable
the WebSocket server, will not set a password, and will not edit OBS's file. An operator who finds
their OBS settings changed by a program they ran once has been given a reason never to trust it
again — so switching the server on stays a human step, which is why step 1 survives.

**Precedence:** whatever the operator set explicitly wins; discovery only fills gaps. An empty
password means "not configured" under Standing Rule 5, which is exactly the case worth filling. It
trusts OBS's `auth_required` over the mere presence of a password, because **OBS keeps the last
password in the file after authentication is switched off** — writing a stale password into a
no-auth setup would turn a working configuration into a rejected handshake. A discovered port is
handed over as a bare port number so it travels through `normalizeObsUrl`, the same forgiving path a
hand-pasted OBS "Port" box takes.

**The secret stays in memory.** Never logged, not even truncated; never written into Verger's own
`config.json`; never reachable through `summarize()`. The log line names the source path and an
outcome, and nothing else.

### A probe before the dial

`ObsClient.connect` arms a reconnect backoff on failure — correct mid-service, wrong as an opening
move. Without a probe, a machine with OBS **installed but not running** got a permanent amber tally
and a panel escalating through "Reconnecting… Attempt 5… OBS went away", about an OBS that was never
there. *"Went away"* is only true after a connection existed. So the launch path asks a bare TCP
connect first (`OBS_PROBE_TIMEOUT_MS = 400`) and stays quiet when nothing is listening; pressing
**Connect** by hand still takes the full retrying path, because by then the operator has said they
expect OBS to be there. **Found by running the e2e suite, which went red on exactly that state.**

Auto-connecting is safe by construction: `ObsClient.connect` writes **nothing** to OBS — no `Set*`,
no `Start*`, no `Stop*` — it asks the version and the scene list and observes. It cannot impose
state on an OBS already mid-service; it only starts watching one. That is also why it belongs in
main rather than the renderer: observing OBS should not depend on a window being open, and on
relaunch after a crash this is what re-attaches to a live stream.

### Two stale machine-specific assertions removed

The e2e startup assertion was pinned to `data-tally="offline"`, which encoded *"OBS is absent from
this developer's laptop"* — not a fact about the product. It now asserts **coherence**: the tally may
be offline or transitioning depending on the machine, but the dot and the words beside it must
agree, and it is never "live" at launch. The wiring guard's skip reason for `obsConnect` said "OBS
Studio is not installed", which is false on any machine that has it; reworded to the
machine-independent reason.

18 tests for the reader, including one that parses **the file OBS actually wrote on this machine**
rather than a fixture I authored — a fixture only proves the parser matches my belief about the
format, and my belief is the thing that could be wrong. It asserts key names and types, never the
password's value. The probe is tested against a real listener on an ephemeral port, then against the
same port after closing it.

Verification: **2247 tests across 80 files**, `tsc` clean both projects, build clean, i18n audit
PASS, **11/11 e2e** against the packaged app.

---

## Cycle 18 — A press state, a 32px hit area, and the USB rebuild

An interface-polish pass applied *against* the rules Cycle 14 established rather than on top of
them: several of the conventional defaults are wrong for this surface and were deliberately left
out.

### The 32px hit area is a real defect, not a nicety

`CueRow`'s drag handle was `min-h-touch` plus `w-8`: **44px tall and 32px wide**, so it met the touch
floor on one axis and missed it on the other — the easy half to overlook, because the row still looks
right. `docs/v2-notes/SHORTCUTS_AND_A11Y.md` §9.4 records v2 shipping 28px hold buttons as a logged
defect (PROBLEMS.md #87), and this is the smallest target in the plan editor and the one most often
grabbed in a hurry. Now 44px in both axes.

### A press state, and why it is not `scale(0.96)`

There was none at all. In a dark booth the question *"did that register?"* has to be answerable
without looking away from the stage. It is a **shadow swap**: `shadow-edge` (a 1px machined top
highlight, what makes a cap look raised) trades for `shadow-recess` (an inset that sinks the face
into the panel), so the cap reads as physically going down.

Deliberately **not** the conventional 0.96 scale. Cycle 14 removed transform-based motion from this
surface on purpose: a control that changes **size** draws the eye in peripheral vision, and beside a
live stage anything that twitches reads as something firing. A shadow swap is invisible until you
are looking at the button you just pressed.

**Transition scope:** the bar's six controls used `transition-colors`, which does not include
`box-shadow` — the press shadow would have snapped while the background eased, reading as two
controls reacting at once. All seven sites now enumerate
`background-color, border-color, box-shadow`.

### Found while verifying, and it is its own lesson

A blanket `transition-property` was present in the shipped stylesheet. The only occurrence of that
class name anywhere in the source was **inside a comment I had just written warning against it**.
Tailwind scans comments as plain text, so the warning emitted the very rule it warned about — the
same failure mode as Cycle 15's type-scale guard, which named the sizes it forbade and shipped every
one of them. The comment is reworded and the rule is gone, verified against the built CSS.

### Checked and deliberately not changed

| Suggested | Why not |
|---|---|
| scale/translate press and enter animations | Cycle 14's no-transform rule, above |
| image outlines via hard-coded `rgba` | already done by `shadow-keyline`, which is tokenised and load-bearing — program red on a mid-grey slide is 1.02:1, so that gutter is the only reason a NOW frame reads over a real deck |
| font smoothing | already in `index.css`, and the target is a Windows church PC |
| tabular numerals | Cycle 14 applied them to every number in the app |
| concentric radii | the drawer's sections have 20px padding against a 6px outer radius — the "treat as separate surfaces" case, not a maths error |

### The USB deliverable, rebuilt

`release/0.1.0/win-unpacked` rebuilt from `b237c7e` (429 MB) and verified with **23/23 checks**. Both
decks re-baked through the app's own importer with PowerPoint as the backend — **102/102 slides, 75
auto-anchored** and **48/48 slides, 43 auto-anchored** — and `config.json` → `plans/11am/plan.json`
confirmed present in the packaged tree. The order is mandatory and now recorded in the runbook:
`npm run portable` **then** the deck bake, because the build wipes `win-unpacked/plans` and the bake
restores it.

### Open, and owed to the first real service

Recorded here rather than left in a conversation, because none of it is provable from this desk:

- **Verger has never connected to a *running* OBS.** OBS is installed on this machine and its config
  file is parsed by a real test, and the port probe is tested against a real socket — but the
  end-to-end "launch Verger, find it already Connected" **has not happened**. Cycle 17's reasoning is
  sound and its parts are tested; the whole is unverified.
- **Real speech → captions has never run.** Needs `SETUP-ASR.bat` on the church PC. Latency unknown.
- **No real go-live**, so Standing Rule 3's always-on recording is asserted by tests only.
- **No real video file** has been decoded on the target machine.
- The build is **unsigned** — SmartScreen will warn on first launch.
- One **axe accessibility check in `SettingsDrawer.test.tsx` failed once** under full-suite load and
  passed on both re-runs. The violation text was not captured, so it is **unreproduced, not fixed**.
- `PreflightScreen.tsx` still ships **3 hardcoded English strings** outside i18n.
- Cycle 15's known deviation stands: `StatusDashboard`, `GoLivePanel` and `TrustDial` use saturated
  colour as a text colour, each paired with an icon shape.

Verification: **2247 tests across 80 files**, `tsc` clean both projects, `npm run build` clean, i18n
audit PASS, **11/11 e2e** against the packaged app. Branch `portable-and-ui` at `b237c7e`, pushed;
`main` is not yet caught up.

---

## Cycle 19 — Ship OBS on the stick, pre-wired

The remaining setup friction was never Verger's. `OBS-SETUP.md` ran to seven steps and five belonged
to OBS: switch the WebSocket server on, add a browser source, set its URL, clear the CSS OBS
pre-fills, untick two checkboxes, tick a third. **Two of those fail invisibly** — a wrong checkbox
looks identical to a right one until the graphic vanishes mid-service or the video plays silent.

All of it is state in files. So it ships as files.

### The finding that reshaped the job

Cycle 17 reads OBS's settings from `%APPDATA%\obs-studio\…`. **A portable OBS does not use `%APPDATA%`
at all** — it keeps everything under `<obs>\config\obs-studio\`. So the auto-connect shipped one
cycle earlier would have found *nothing* on a stick with OBS sitting in the next folder along, and
reported "OBS may not be installed". Bundling OBS would have made setup **worse** than not bundling
it.

This was established by running one, not by reading about it: a copy of OBS plus a `portable_mode.txt`
created `<obs>\config\obs-studio\plugin_config\obs-websocket\config.json` and never touched
`%APPDATA%`. `readObsWebsocketConfig` now takes an optional `portableObsDir` and tries it **first** —
an operator who put an OBS in the Verger folder chose the OBS for this deployment, and it is the one
`START.bat` launches; an OBS installed years ago is the fallback, not the intent.

### The template is generated, because guessing OBS's formats fails silently

`obs-template/` holds a scene collection and a profile that a fresh OBS adopts as its own. Both are
undocumented OBS-internal formats, and both were nearly hand-written. A real OBS was driven over
obs-websocket instead — `scripts/derive-obs-scene-template.mts` builds the scene, then closes OBS so
it serialises its own state, and harvests the result. It disagreed with what would have been written
from memory, twice:

- **`global.ini` is empty** on OBS 32. Profile and scene-collection selection moved to `user.ini`
  under `[Basic]`. A template using the older, widely-documented layout is not rejected — it is
  **ignored**, and OBS quietly starts on its own default collection.
- The scene JSON carries a `canvas_uuid` and a `version` field a hand-written file would have omitted.

The generator is locale-independent too: a new collection's default scene is named in OBS's own
language (`장면` here), so it is deleted **by difference from the scene we made**, never by name.

### Eight lines that would have shipped this laptop to a church

The first derivation harvested OBS's profile verbatim. It contained:

| Line | Why it is harmful on the church PC |
|---|---|
| `FilePath=C:\Users\user\Videos` ×3 | a recording path that does not exist — Standing Rule 3's always-on recording fails, and nobody finds out until after the service |
| `StreamEncoder=nvenc`, `RecEncoder=nvenc`, `NVENCPreset2=p5` | **this machine has an NVIDIA GPU.** A machine without one cannot start the output at all |
| `MonitoringDeviceName=기본값` | this machine's locale |
| `CookieId=BE56F2D3855B44C8` | this machine's browser panel |

The profile is now rebuilt from an **allowlist** rather than copied — 107 lines in, 21 out. An
allowlist and not a denylist because the failure directions are not symmetric: a key we forget to
allow costs an OBS default, a key we forget to deny ships someone else's hardware. `RecFormat2=mkv`
is the one line worth keeping deliberately: an `.mp4` whose OBS crashed mid-write is unplayable, and
the recording of the service is simply gone.

`src/main/obs/obsTemplate.test.ts` is the other half. It was checked against the **unsanitised**
file to prove it is not asleep: all six guards fire on the real thing and pass the shipped one.

### The password

Generated fresh per assembly, never committed, never shown. Not a fixed one — a shared secret in a
public repo is not a secret, and obs-websocket listens on **every interface**, so on a church wifi a
known password means anyone present can drive the stream. Not blank, for the same reason. The
operator never types it: it goes into OBS's own file and Verger reads it there, which is exactly the
Cycle 17 mechanism doing what it was built for. Standing Rule 5 holds — it never enters Verger's
`config.json`.

Standing Rule 2 holds too: `assemble-portable-obs.mts` works on a **copy** and refuses outright to
touch anything under `Program Files`. It does not download OBS either — OBS is GPL, and whether to
redistribute it on a stick handed to someone else is the shipper's decision, not a build script's.

### The gap Cycle 18 recorded is now closed

Cycle 18's open list led with *"Verger has never connected to a running OBS."* It has now.

`scripts/verify-portable-obs.mts` assembles nothing and asserts everything: it drives the **real**
`readObsWebsocketConfig` and `isObsPortListening` — imported from `@main/obs/localConfig`, not
reimplemented — against a genuinely running OBS. It blanks `APPDATA` deliberately, because this
machine also has an installed OBS and reading that would be a false pass.

**16/16 checks passed**, including the two that no offline test can reach: *the generated password
authenticates*, and OBS itself reports the `Cam 1` scene with an `Overlays` source whose `shutdown`,
`restart_when_active` and `reroute_audio` are the values a mis-click would have got wrong. This is
deliberately **not** a vitest test — the repo forbids tests that need a running OBS — it is a
pre-flight for a built stick, run by hand.

### What the operator now does

If the folder has an `obs` sub-folder: start `START.bat`, add the room's camera to `Cam 1`. That is
the whole procedure. `START.bat` starts the bundled OBS first — but only when nothing is already
listening on 4455, because two OBS instances fight over the camera and the encoder, and an OBS the
operator opened themselves must always win.

Steps 4 and 7 of `OBS-SETUP.md` are marked skippable outright in that case, and step 6 shrinks to
"add this room's camera".

Verification: **2274 tests across 81 files**, `tsc` clean both projects, `npm run build` clean, i18n
audit PASS, and the 16/16 portable-OBS pre-flight against OBS 32.1.2 / obs-websocket 5.7.3.

**Still open:** no OBS is bundled into the shipped stick yet — that needs an OBS download the
repository owner supplies. Real speech → captions, a real go-live, and decoding a real video file
remain unverified, and the build is still unsigned.

---

## Cycle 20 — OBS is on the stick, and verifying it no longer dirties it

Cycle 19 ended one item short: the assembler was finished but nothing was assembled, because
redistributing OBS is the shipper's decision. That decision was made and a zip supplied. This cycle
uses it, and in doing so finds that the pre-flight written last cycle was quietly ruining the thing
it certified.

**What actually arrived was not OBS.** The supplied `OBS Studio.zip` is 784 bytes and contains one
file, `OBS Studio.lnk` — the installer's desktop shortcut, zipped. Resolving it gave
`C:\Program Files\obs-studio`, which `assemble-portable-obs.mts` refuses outright under Standing
Rule 2. The refusal is not a dead end, though; its own message names the way through, *copy the
folder elsewhere first*, and that is what was done. The install tree has no `config/` directory at
all — an installed OBS keeps its settings in `%APPDATA%` — so the copy began with nothing of this
machine's in it, which is the property that matters.

**The stick now carries OBS.** 885 MB across 2405 files, of which 457 MB and 2165 files are OBS
32.1.2. The 102-cue and 48-cue plans survived untouched; `obs:assemble` merges into the target and
does not rebuild it, so the standing warning about `npm run portable` wiping `plans/` does not apply
here.

**Then the finding: verifying the stick was contaminating the stick.** `obs:verify` starts OBS. One
launch left roughly **8 MB of this laptop** inside the folder about to be handed to a church —
Chromium GPU caches compiled for *this* GPU (`GrShaderCache/data_3` alone is 4.2 MB), a cookie
database, `Visited Links`, a hardware-listing log, `crashes/`, `profiler_data/`, `updates/`, and
OBS's own rewrite of `user.ini` from 264 bytes to 1063. Cycle 19 built a profile allowlist and a
test guard precisely to stop machine-specific values reaching a stick, and here the same leakage
walked in through the front door of the tool meant to prove the stick was clean. A 16/16 PASS was
being printed *about a folder the run had just altered*.

Worth recording what was **not** contaminated, because the first reading of the evidence was wrong:
`Verger.json` is 6376 bytes before and after. It looked inflated only because the template is that
size. The real damage was `user.ini`, `basic.ini` (205 → 208), and the cache tree.

**The fix is snapshot-and-restore, with the restore itself asserted.** `verify-portable-obs.mts` now
copies `config/` to a temp directory before starting OBS and puts it back after — and critically,
waits on the child's `exit` event rather than a fixed delay, since restoring while OBS is still
alive would simply let it write the contamination back afterwards. A 17th check compares a
`sha256`-per-file fingerprint of the tree before and after, and fails if a single byte moved.
`portable_mode.txt` confines OBS to that directory, so `config/` is the whole of what it can reach.

Restoring rather than verifying a copy is the deliberate choice: a copy only proves a copy. The
stick that goes in the envelope should be the artifact that was tested.

**Evidence.** 17/17 against the real `release/0.1.0/win-unpacked/obs`, including the two checks no
offline test can reach — the generated 24-character password authenticates, and OBS itself reports
`Cam 1` with an `Overlays` source whose `shutdown`, `restart_when_active` and `reroute_audio` are
the three values a mis-click gets wrong. The byte-identity claim was then confirmed *from outside
the script*, by hashing the config tree in PowerShell before and after: 4 files, same hashes, and no
`logs/`, `crashes/`, `profiler_data/` or `obs-browser/` directory anywhere. Before that fix landed
the stick had to be assembled twice, the first copy being discarded as dirty.

**The stick itself was stale, and nobody would have noticed.** `app.asar` was built at 23:45 on the
27th; `src/main/index.ts` and `src/main/obs/localConfig.ts` — *the portable-OBS discovery* — were
edited at 00:24 the next morning. The USB folder had never been repackaged after Cycle 19's own
feature landed, so the shipped Verger could not have found a bundled OBS at all. A staleness check
run earlier had reported the folder current, and it was: the check predated the edits. Rebuilt in
the mandatory order — `npm run portable`, re-bake the decks, `obs:assemble`, `obs:verify` — back to
885 MB / 2405 files, 102 and 48 cues, and every `portable/**` file now hash-identical to its source
(all seven had drifted).

**The packaged app was then made to prove it, because no test does.** The e2e suite launches
`out/main/index.js` through the Electron binary in `node_modules`, so `app.getPath('exe')` is
nowhere near the stick and `<exe-dir>/obs` never exists — 11/11 passes without ever exercising the
bundled-OBS path, and `obs:verify` passes `portableObsDir` explicitly, so it cannot catch a wiring
error in `index.ts` either. Between them they left the actual seam untested. So the stick's OBS and
the stick's `Verger.exe` were both launched, and `netstat` showed an ESTABLISHED socket from a
Verger process to 127.0.0.1:4455 on the bundled OBS's PID. That is discovery, password read and
authentication, performed by the packaged binary from its own directory.

**The restore added above was wrong on its first version.** `rmSync` threw `EPERM` part-way through:
`taskkill /T` ends OBS's browser subprocesses, but Windows releases their handles asynchronously,
and for a second afterwards `debug.log` and the leveldb `LOCK` files stay open. Three runs had
passed by luck before one failed. The failure mode is the bad one — the delete removes `basic/`
before it reaches the locked file, then aborts, leaving a folder that is contaminated *and* missing
the scene collection and profile, which is strictly worse than never restoring. It now retries for
ten seconds, and a restore that still fails keeps the snapshot, prints its path, and fails the
check rather than exiting quietly. Three consecutive clean 17/17 runs afterwards.

Verification: **2274 tests across 81 files**, `tsc` clean both projects, `npm run build` clean, i18n
audit PASS, **11/11 e2e** against the packaged build, and 17/17 pre-flight against OBS 32.1.2 /
obs-websocket 5.7.3, run three times consecutively with the folder byte-identical after each.

**Still open:** real speech → captions, a real go-live with recording confirmed, and decoding a real
video file remain unverified on the target machine, and the build is still unsigned. One axe check
in `SettingsDrawer.test.tsx` failed once under full-suite load and has never reproduced.
`PreflightScreen.tsx` still ships three hardcoded English strings outside i18n. Nothing asserts that
a *rebuilt* stick has been re-assembled and re-baked; `npm run portable` silently discards `obs/`
and `plans/`, and only this log says so.
