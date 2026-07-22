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
