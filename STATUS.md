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
