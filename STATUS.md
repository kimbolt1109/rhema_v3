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
