# Control/Overlay Message Protocol — mined from rhema_v2

> Sources:
> - `C:\Side projects\rhema_v2\docs\API.md` (full, 465 lines — as-built Remote WS/REST API, "Phase 13" rewrite)
> - `C:\Side projects\rhema_v2\Rhema_Blueprint_v3.4.md` — PART 3 "IPC CONTRACT & PROCESS SECURITY" (lines 345-449, full), PART 5 "REST & WEBSOCKET API SPECIFICATION" (lines 889-957, full), PART 9 "SECURITY MODEL" §9.1-9.3 (lines 1398-1446), OPUS-008 "WebSocket Remote Server" spec (lines 2940-3011); grepped for `WebSocket`, `protocol`, `envelope`, `event`
> - `C:\Side projects\rhema_v2\PROBLEMS.md` (full delta audit, dated 2026-07-02) — lines 40-109, specifically items #22-#35, #48, #51
> - `C:\Side projects\rhema_v2\docs\adr\ADR-001B-tauri-runtime.md` (full) — records the Electron→Tauri runtime swap that this document's drift stems from

## 0. CRITICAL FRAME: two non-identical protocols exist in v2, plus a spec that was never fully built

v2 (rhema_v2) is **Tauri 2 + Rust**, not Electron, despite the original blueprint
(`ADR-001`) mandating Electron. This was a deliberate, later, undocumented-at-the-time
swap, retroactively recorded in `ADR-001B-tauri-runtime.md` (2026-07-03, owner decision)
citing "875+ passing Rust tests, working wgpu render engine" as sunk cost. Consequence
for mining purposes: **there is no Electron `ipcMain`/`contextBridge`/BrowserWindow code
in v2 at all** — PART 3 of the blueprint (the IPC contract) was written for Electron and
was ported to Tauri idioms (`#[tauri::command]` + a `command_guard` wrapper) rather than
implemented as specified. Verger, being Electron, should treat **PART 3 as the literal
target spec** (it was written for exactly Verger's runtime) rather than as a Tauri
retrofit — this is the single most reusable artifact in this note.

Three distinct message surfaces exist/were-specified across the two documents; do not
conflate them:

1. **Internal main↔renderer IPC** (blueprint PART 3) — Electron-native design, `rhema:*`
   named channels via `ipcMain.handle`/`contextBridge`, never built as specified in v2
   (Tauri equivalent: `command_guard` on `#[tauri::command]`). **This is the closest
   analog to Verger's "main/renderer/overlay" bus** and should be mined hardest.
2. **External Remote-control WebSocket+REST** (API.md, as-built; also blueprint PART 5,
   as-specified) — for phones / Stream Deck / dashboards, ports 7320/7321. This actually
   shipped in v2, but its wire format **diverged** from the blueprint's PART 5 spec (see
   §4 "Drift" below). Two different envelope shapes exist for this one surface: the
   blueprint's flat `{ type: 'slide:next' }` design (never built) and the shipped
   `{ type: 'command', action, payload }` design (API.md, real).
3. **Two more WS surfaces existed in v2 that neither source document above covers in
   depth**: a captions WS on port **8765** (bound `0.0.0.0` by design per
   `docs/NETWORK_SETUP.md`) and a multi-campus HQ↔satellite relay WS on port **3002**
   (`campus/`, referenced in PROBLEMS.md #69 as diverging from the blueprint's intended
   Neon-Postgres sync design). Neither is documented in API.md. If Verger needs
   captions or multi-site sync protocols, mine those separately — **not covered here**.

---

## 1. As-built Remote Control protocol (API.md — what actually shipped, Phase 13)

### 1.1 Ports & endpoints
- **WebSocket:** `ws://localhost:7320` (LAN if `remote_enabled` + explicit `bind_address`)
- **REST:** `http://localhost:7321`
- **Deprecated alias:** port **3001**, loopback-only (`127.0.0.1`, never LAN-reachable), kept only so pre-Phase-4b-paired devices don't need to re-pair. Do not build new integrations against it. (This 3001 alias is itself the *old* wrong port from PROBLEMS.md #27 — kept alive only for compat, not re-adopted as canonical.)

### 1.2 Envelope shapes (as shipped)

Client → Server (commands):
```json
{ "type": "command", "action": "slide_advance", "payload": {} }
```
Fields: `type` (must be `"command"`), `action` (string, see catalog below), `payload` (object, action-specific). **No ACK, no requestId** — commands return immediately; effects are observed via subsequent `state`/`event` messages. (Blueprint wanted `requestId` echo/ack correlation — PART 5.3 — this was never implemented; PROBLEMS.md #34.)

Server → Client, 4 message `type`s, each with a **different secondary key name** (a real inconsistency, flag for Verger — see §5):
```json
{ "type": "state",   "payload": { "slides_total": 10, "current_slide": 3 } }
{ "type": "event",   "event": "SlideAdvanced", "payload": { "new_index": 4, "total": 10 } }
{ "type": "preview", "payload": "<base64 JPEG>" }
{ "type": "error",   "message": "permission denied: camera commands require camera role" }
```
Note `event` messages key the event name under `event`, `state`/`preview` have no such key (payload IS the whole thing), and `error` has no `payload` wrapper at all — message is a bare top-level `message` string, no error code.

### 1.3 Auth / handshake (WS)
- Query params: `token` (required, raw 256-bit hex token — **not a JWT**), `device` (optional hint: `phone`|`tablet`|`streamdeck`|`browser`, default `unknown`).
- Token minted via the `remote_pairing_qr` Tauri command (Admin-only): mints raw 256-bit token (`crate::remote::api_tokens::mint_token`), persists **only its SHA-256 hash** in `api_tokens` table, wraps it + the LAN TLS cert fingerprint (TOFU pinning) in a `PairingPayload`, renders as QR. **Raw token shown exactly once** — no recovery, only re-pair.
- Legacy `src-tauri/src/remote/auth.rs` still implements an HS256-JWT flow (`RemoteClaims`, `issue_remote_token`) for the 3001 alias only — do not build against it.
- Revocation: Settings → Security → Revoke Token sets `api_tokens.revoked = 1`; checked on every WS connect and every REST request.
- Invalid/unrecognized/revoked token → `{ "type": "error", "message": "unauthorized: invalid token" }` then server closes with WS policy-violation close.
- **No documented ping/pong heartbeat in the shipped API** (contrast with blueprint spec in §3 below — PROBLEMS.md #33 says heartbeat was never implemented; only a 2s preview-stub tick existed).

### 1.4 RBAC — functional roles (as shipped, NOT the blueprint's 4-tier)

```
| Role         | Slides | LowerThirds | Camera | Lighting | Stream | Supervisor |
|--------------|--------|-------------|--------|----------|--------|------------|
| Supervisor   |   ✓    |      ✓      |   ✓    |    ✓     |   ✓    |     ✓      |
| Presentation |   ✓    |      ✓      |   —    |    —     |   —    |     —      |
| Camera       |   —    |      —      |   ✓    |    —     |   —    |     —      |
| Lighting     |   —    |      —      |   —    |    ✓     |   —    |     —      |
| Stream       |   —    |      —      |   —    |    —     |   ✓    |     —      |
| ReadOnly     |   —    |      —      |   —    |    —     |   —    |     —      |
```
**Supervisor-only:** `director_toggle`, `panic`, `custom_cue`. These functional roles are mapped onto an underlying 4-tier ladder (`Volunteer`/`Operator`/`Director`/`Admin`, `crate::security::Tier`) via `Tier::from_operator_role` to gate both WS and REST — i.e. the functional-role matrix above is a *view* over the blueprint's tier system, not a replacement (PROBLEMS.md #51 calls this divergence out as real, "enforced only on the remote surface").

### 1.5 Command catalog (client → server, `action` values)

| Action | Payload | Permission |
|---|---|---|
| `slide_advance` | `{}` | Presentation |
| `slide_previous` | `{}` | Presentation |
| `lower_third_show` | `{ "template_id": "speaker-v1" }` | Presentation |
| `lower_third_dismiss` | `{}` | Presentation |
| `camera_preset_recall` | `{ "camera_id": 1, "preset": 5 }` | Camera |
| `dmx_scene_activate` | `{ "scene_id": "worship-blue" }` | Lighting |
| `stream_start` | `{ "config_id": "youtube" }` | Stream |
| `recording_toggle` | `{}` | Stream |
| `director_toggle` | `{}` | Supervisor |
| `panic` | `{}` (emergency stop — halts AI, keeps stream/recording live) | Supervisor |
| `custom_cue` | `{ "cue_id": "prayer-lighting-dim" }` | Supervisor |

**Camera command shape note:** the WS action `camera_preset_recall` takes `{ camera_id: number, preset: number }` — flat integer IDs. Contrast the REST equivalents which use string path params and a slightly different field name (`presetId`, camelCase): `POST /v1/cameras/:id/preset` body `{ presetId: u8 }`, and a *separate* velocity-drive command `POST /v1/cameras/:id/move` body `{ pan, tilt, speed }` (zoom held at 0) that has **no WS command equivalent** in the shipped catalog above.

### 1.6 Event catalog (server → client, `event` values inside `{type:"event", event, payload}`)

| Event | Payload | When |
|---|---|---|
| `SlideAdvanced` | `{ new_index: u32, total: u32 }` | Slide changed (auto, manual, or AI) |
| `ServiceStarted` | `{ runbook_id: string }` | Service began |
| `ServiceEnded` | `{ duration_secs: u32 }` | Service ended |
| `CaptionReady` | `{ text: string, language: string }` | Live caption available |
| `BibleReferenceDetected` | `{ book: string, chapter: u32, verse_start: u32, verse_end?: u32, confidence: f32 }` | AI detected a scripture ref |
| `DmxSceneActivated` | `{ scene_id: string, triggered_by: TriggerSource }` | Lighting scene changed |
| `StreamStarted` | `{ platform: string, url: string }` | Stream encoder connected |
| `StreamStopped` | `{ platform: string }` | Stream disconnected |
| `PanicActivated` | (none) | PANIC button pressed |
| `DirectorModeToggled` | `{ enabled: boolean }` | Director mode toggled |
| `slide:live`, `slide:clear`, `camera:moved`, `dmx:scene:fired`, `stream:started`, `stream:error` | (see REST §1.7) | Mirrors of REST-triggered mutations, broadcast to WS clients for correlation |

Note the **naming convention is itself inconsistent within the shipped catalog**:
PascalCase event names (`SlideAdvanced`, `BibleReferenceDetected`) coexist with
colon-namespaced lowercase names (`slide:live`, `dmx:scene:fired`) in the same event
stream — the latter group are REST-mutation mirrors bolted on later, the former are the
"native" event-bus events. Flag as a naming-convention gotcha for Verger (§5).

### 1.7 REST API (port 7321)

Auth gate, in order (every `/v1/*` route including `/v1/status`):
1. Host allow-list — forged `Host` header → `403` (no detail leaked)
2. Origin allow-list — cross-site request → `403` (no detail leaked)
3. Token auth — `Authorization: Bearer <raw-token>` (preferred) or `?token=` (fallback) → `401` if missing/unknown/revoked
4. RBAC — token's role vs. route's minimum tier (`Volunteer` for reads/nav, `Operator` for state-changing) → `403`
5. Rate limit — 100 req/min per token → `429` + `Retry-After: <seconds>` header

Same hashed tokens as WS; no separate REST pairing flow.

| Method | Path | Min tier | Notes |
|---|---|---|---|
| GET | `/v1/slides/current` | Volunteer | `{ slide: { index }, look: null }` — no `looks` table in this build |
| POST | `/v1/slides/live` | Operator | Broadcasts `slide:live` WS event |
| DELETE | `/v1/slides/live` | Operator | Broadcasts `slide:clear` WS event |
| GET | `/v1/schedule` | Volunteer | `{ items: [] }` — no `schedule_items` table |
| POST | `/v1/schedule/next` | Operator | `501` `SCHEDULE_SUBSYSTEM_NOT_PRESENT` |
| GET | `/v1/songs` | Volunteer | real data, `?q=&limit=&offset=` |
| GET | `/v1/songs/:id` | Volunteer | real data, includes `sections` |
| GET | `/v1/cameras` | Volunteer | real data |
| POST | `/v1/cameras/:id/preset` | Operator | `{ presetId: u8 }`; broadcasts `camera:moved` |
| POST | `/v1/cameras/:id/move` | Operator | `{ pan, tilt, speed }`; broadcasts `camera:moved` (velocity drive, zoom held 0) |
| GET | `/v1/dmx/scenes` | Volunteer | real data |
| POST | `/v1/dmx/scenes/:id/fire` | Operator | broadcasts `dmx:scene:fired`; `404` if not found |
| POST | `/v1/dmx/channels` | Operator | `{ universe, channel, value }` raw channel write |
| GET | `/v1/macros` | Volunteer | `{ macros: [] }` — no `macros` table |
| POST | `/v1/macros/:id/fire` | Operator | `501` `MACRO_SUBSYSTEM_NOT_PRESENT` |
| POST | `/v1/ai/mode` | Operator | `{ mode: "auto"\|"director"\|"autonomous"\|"manual"\|"suggest"\|"panic"\|"off" }` |
| GET | `/v1/ai/suggestion` | Volunteer | `{ suggestion: null }` — no cloud pipeline / `ai_cache` in this build |
| POST | `/v1/ai/suggestion/accept` | Operator | idempotent ack, no pending-suggestion store |
| POST | `/v1/ai/suggestion/dismiss` | Operator | idempotent ack |
| GET | `/v1/streams` | Volunteer | `{ streams, active }` |
| POST | `/v1/streams/:id/start` | Operator | broadcasts `stream:started` or `stream:error` |
| POST | `/v1/streams/:id/stop` | Operator | |
| GET | `/v1/status` | Volunteer | health check: `{ readiness, subsystems: [{ subsystem, state, healthy }] }` from live `HealthGate` |
| POST | `/v1/webhook/planning-center` | Operator | accepts payload, `200 { received: true }`, **does not act on it** (no OAuth/HMAC verification — PROBLEMS.md #70) |

Health check example response:
```json
{ "readiness": "ready", "subsystems": [
  { "subsystem": "database", "state": "Ready", "healthy": true },
  { "subsystem": "render", "state": "Ready", "healthy": true }
]}
```

### 1.8 Rate limits & backpressure (as shipped)
- 100 req/min per token, shared `RateLimiter` (`crate::security::RateLimiter`, `CommandClass::Remote`) across WS and REST. REST: `429` + `Retry-After`. WS: closes/rejects on exceed.
- State broadcast on WS: periodic snapshot, debounced (no exact Hz given in API.md).
- Default max 64 simultaneous WS clients (tunable in settings).

---

## 2. Blueprint PART 3 — Electron IPC Contract (never built in v2 — this IS the Verger spec)

### 2.1 Full IPC channel registry (verbatim table, blueprint PART 3.1)

`R = Renderer, M = Main`. Every `on` (push) channel is delivered via a typed,
single-purpose callback in the preload bridge — **never raw `ipcRenderer.on`**.

```
rhema:slide:set-live          invoke  { slideId: string }                                    -> { ok, error? }        R→M
rhema:slide:next              invoke  {}                                                      -> { ok, slideId }      R→M
rhema:slide:prev              invoke  {}                                                      -> { ok, slideId }      R→M
rhema:slide:clear             invoke  { layer: 'all'|'text'|'bg'|'media' }                     -> { ok }               R→M
rhema:slide:get-current       invoke  {}                                                      -> { slide: SlideState } R→M
rhema:schedule:load           invoke  { serviceId: string }                                    -> { items: ScheduleItem[] } R→M
rhema:schedule:reorder        invoke  { from: number, to: number }                             -> { ok }               R→M
rhema:library:search          invoke  { query: string, limit: number }                         -> { results: ContentItem[] } R→M
rhema:file:ingest             invoke  { path: string }                                         -> { jobId: string }    R→M
rhema:ingest:progress         on      { jobId, stage, pct, etaMs }                              (push)                 M→R
rhema:output:list             invoke  {}                                                      -> { outputs: OutputConfig[] } R→M
rhema:output:assign           invoke  { displayId: string, role: OutputRole }                  -> { ok }               R→M
rhema:dmx:scene               invoke  { sceneId: string }                                      -> { ok }               R→M
rhema:dmx:set                 invoke  { universe: number, channel: number, value: number }      -> { ok }               R→M
rhema:cam:preset              invoke  { cameraId: string, presetId: number }                    -> { ok }               R→M
rhema:cam:move                invoke  { cameraId: string, pan: number, tilt: number, speed: number } -> { ok }          R→M
rhema:macro:fire              invoke  { macroId: string }                                      -> { ok, actions: number } R→M
rhema:ai:set-mode             invoke  { mode: 'auto'|'assist'|'off' }                           -> { ok }               R→M
rhema:ai:suggestion           on      { slideId, confidence, reason, expiresAt }                (push)                 M→R
rhema:ai:suggestion:accept    invoke  { suggestionId: string }                                  -> { ok }               R→M
rhema:ai:suggestion:dismiss   invoke  { suggestionId: string }                                  -> { ok }               R→M
rhema:stream:start            invoke  { targets: StreamTarget[] }                               -> { ok, error? }       R→M
rhema:stream:stop             invoke  {}                                                       -> { ok }               R→M
rhema:status:update           on      { subsystem: string, state: SubsystemState }              (push)                 M→R
rhema:performance:warning     on      { subsystem, metric, actual, budget }                     (push)                 M→R
```

Note the naming convention here IS consistent: `rhema:<domain>:<action>`, all lowercase,
colon-namespaced. This is cleaner than the shipped Remote API's mixed PascalCase/colon
convention (§1.6) — **adopt this convention for Verger's internal bus.**

### 2.2 `rhema://` custom scheme requirement
Renderer MUST be served from a registered `rhema://` custom scheme (`protocol.handle` in
main), never `file://` — `file://` gets extra Electron privileges and breaks origin
checks that sender-validation depends on. Register scheme as `standard`, `secure`,
`supportFetchAPI` **before `app.ready`**. (For Verger: substitute an app-specific scheme,
e.g. `verger://`.)

### 2.3 IPC security rules (ALL mandatory, PART 3.2)
- **(C)** Every `ipcMain.handle` validates sender origin via `event.senderFrame?.url`.
  **Treat null/undefined `senderFrame` as rejection** (frame can be destroyed before
  handler runs — unchecked null is a bypass). Accept only `rhema://`-prefixed origins;
  reject `file://`, `http(s)://`, anything else.
- **(C)** `contextBridge` MUST NOT expose raw `ipcRenderer.on`/`.send`/the whole
  `ipcRenderer` object — only named typed functions.
- **(C)** All payload fields validated with **Zod schema** before processing in main;
  reject + log any violation.
- **(H)** Hardware-triggering channels (DMX, camera, macro) check operator role from
  session store before executing.

### 2.4 `safeHandle` wrapper — full pseudocode contract (PART 3.2, OPUS TASK block)

File target: `src/main/ipc/safeHandle.ts`. Depends on `zod`, `@sentry/electron`.

```typescript
export function safeHandle<T extends z.ZodTypeAny>(
  channel: string,
  schema: T,
  handler: (event: IpcMainInvokeEvent, data: z.infer<T>, session: OperatorSession) => Promise<unknown>
): void
```

Steps, in order:
1. Validate sender: `const url = event.senderFrame?.url`. If null/undefined OR doesn't
   start with `'rhema://'`: log Sentry breadcrumb, return `{ ok: false, error: 'INVALID_SENDER' }`.
2. `schema.safeParse(payload)`. On failure: log channel + error.message, return
   `{ ok: false, error: 'INVALID_PAYLOAD' }`.
3. Look up session via `SessionStore.getByWindowId(event.sender.id)`. Null → `{ ok: false, error: 'NO_SESSION' }`.
4. Check `session.role` against a `RolePermissions` map for this channel. Fail →
   `{ ok: false, error: 'FORBIDDEN' }`.
5. For destructive/hardware channels (`dmx:set`, `dmx:scene`, `cam:*`, `macro:fire`,
   `stream:*`, `slide:clear` with layer `'all'`): per-session **token-bucket rate limit,
   default 20 ops / 5 s**. Exceed → `{ ok: false, error: 'RATE_LIMITED' }`. **This limits
   only operator-initiated commands** — it must NOT touch internal loops (e.g. a 40Hz DMX
   refresh loop or VISCA keep-alives) that never traverse IPC. One scene-change command is
   rate-limited; the packet stream it produces internally is not.
6. Call `handler(event, parsedData, session)`, wrapped in try/catch. Throw → capture to
   Sentry, return `{ ok: false, error: 'INTERNAL_ERROR' }`.

**Error codes enumerated:** `INVALID_SENDER`, `INVALID_PAYLOAD`, `NO_SESSION`,
`FORBIDDEN`, `RATE_LIMITED`, `INTERNAL_ERROR`. All errors returned as
`{ ok: false, error: string }` — **never thrown to renderer**. This is a strictly better
error shape than the shipped Remote API's bare `{ type: 'error', message: string }`
(§1.2) — it has a stable machine-matchable code, not just a human message. **Adopt the
coded-error pattern for Verger, everywhere** (IPC, overlay, and any future remote API).

Perf requirement: schema validation must complete in <1ms. Tests required (6 min):
valid path calls handler; invalid sender → `INVALID_SENDER`, handler not called; invalid
payload → `INVALID_PAYLOAD`; insufficient role → `FORBIDDEN`; handler throws →
`INTERNAL_ERROR` + Sentry capture.

### 2.5 Renderer hardening (every BrowserWindow/BrowserView, PART 3.3)
- **CSP** (both response header AND `<meta>`):
  `default-src 'self' rhema:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: rhema:; media-src 'self' blob: rhema:; connect-src 'self' rhema: https://api.anthropic.com https://api.esv.org https://api.scripture.api.bible https://api.planningcenteronline.com; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`.
  No `unsafe-eval`, ever.
- **Navigation lockdown:** on `app.on('web-contents-created')`, `contents.on('will-navigate', …)` blocks any non-`rhema://` origin; `contents.setWindowOpenHandler(() => ({ action: 'deny' }))` blocks `window.open`/`target=_blank`. External links only via `shell.openExternal` after scheme allow-listing (http/https/mailto only).
- **Permission gating:** `session.setPermissionRequestHandler` denies everything by default, grants ONLY `media` (camera/mic) to the operator window, **nothing** to output/stage windows. `setPermissionCheckHandler` mirrors this. No geolocation/notifications/MIDI-sysex/USB/clipboard-read to any web content.
- `webSecurity: true` always; `allowRunningInsecureContent: false`; `webviewTag: false` (no `<webview>`).
- Preload exposes only typed bridge functions; no dynamic `require`, never forwards raw `ipcRenderer`.

**Direct implication for Verger's overlay window:** the "output/stage window gets
nothing" rule (no capability over-grant) is exactly what v2 got wrong in its Tauri port —
PROBLEMS.md #24: `capabilities/default.json` granted `shell:allow-open` and broad `fs`
read/write/mkdir to **all** windows including `rhema-output-*`. **Do not repeat this in
Verger** — the overlay/output BrowserWindow's preload should expose a *strict subset* of
the main operator window's bridge (state-consumption only, no file/shell/hardware
commands).

### 2.6 Custom-scheme & OAuth hardening (PART 3.4)
- OAuth (e.g. Planning Center) uses PKCE with S256 + random `state` param.
- Register `rhema://` as `standard`, `secure` via `protocol.registerSchemesAsPrivileged`
  **before `app.ready`**; serve renderer from inside the signed ASAR via `protocol.handle`
  — never `file://`. `grantFileProtocolExtraPrivileges` Electron Fuse must be **false**.
- Single-instance lock (`app.requestSingleInstanceLock`) so OAuth deep-links land on the
  already-running instance via `second-instance`, not a fresh spawn.

### 2.7 IPC message limits & backpressure (PART 3.5)
- **Message-size cap: 256 KB per payload** (default), enforced in `safeHandle`. Large
  transfers go by reference (e.g. `file:ingest` passes a *path*, never raw bytes).
- **High-frequency push channels are coalesced**: main keeps only the latest payload per
  channel, flushes on fixed cadence **≤10 Hz** (examples given: `status:update` ~5Hz,
  `ingest:progress`). A slow renderer cannot build an unbounded queue.
  **Slide/AI events are explicitly NOT coalesced** — each must arrive individually.
- SQLite single-writer queue has bounded depth; on overflow, non-critical writes (usage
  logging, telemetry) are shed/batched while critical writes (live state) keep priority;
  queue depth is a health metric.

---

## 3. Blueprint PART 5 — original WS/REST spec (aspirational; NOT what shipped — contrast with §1)

This is the pre-implementation design intent. Diverges from the shipped API.md in
material ways (cataloged in §4). Useful mainly as "what a stricter version would look
like," and because its **security ordering and heartbeat design were never actually
built** in v2 (real gap, real lesson for Verger).

### 3.1 Auth / hardening rules (PART 5.1)
- Token: 256-bit random hex, first-launch generated. Only SHA-256 hash stored
  (`api_tokens.token_hash`). Compare via `crypto.timingSafeEqual` — **never `===`**
  (timing side-channel).
- Bind scope: REST(7321)/WS(7320) bind `127.0.0.1` by default; "Allow LAN remotes" adds
  the specific LAN IPv4 the operator picks — **never bind `0.0.0.0` blindly**.
- **DNS-rebinding defense (Host allow-list):** every request (REST + WS upgrade) rejected
  `403` unless `Host` header is exactly `127.0.0.1:<port>`, `localhost:<port>`, or the
  configured LAN IP:port. Token auth alone does NOT stop this (browser auto-attaches
  credentials). Reject all other Host values including any domain name.
- **CSWSH defense (Origin allow-list):** WS handshake validates `Origin` against an
  allow-list (the app's own custom-scheme origin, plus null/absent origin for native
  Remote apps only if LAN enabled). Any other browser origin → `403` before upgrade.
- **Token transport:** native Remote apps send token in the WS subprotocol or first
  message frame — **not URL query param** (leaks into logs/history). Browser WebRemote
  client gets token via one-time QR deep-link, holds in memory only (never localStorage —
  XSS exfil risk). Cookie-based transport explicitly REJECTED as a design (cookies are
  the exact CSWSH vector).
- Tokens are per-device rows; "Revoke All Sessions" sets `revoked=1` on all rows.
- Rate limit: 100 req/min per token (shared with IPC hardware rate-limit philosophy).
  Exceed → `429` + `Retry-After`.

### 3.2 REST endpoint table (PART 5.2 — 24 endpoints, camelCase field names — contrast §1.7's snake_case-in-parts shipped version)
Same route list as §1.7 but response shapes use **camelCase** consistently
(`presetId` not `preset_id`, `slideId` not `slide_id`) and richer typed responses, e.g.:
```
GET  /v1/slides/current        -> { slide: SlideState, look: LookState }
POST /v1/slides/live  {slideId} -> { ok }
GET  /v1/songs?q&limit&offset  -> { songs: Song[], total }
POST /v1/cameras/:id/preset {presetId} -> { ok }
GET  /v1/status                -> { subsystems: SubsystemStatus[] }
```
(Full 24-route table mirrors §1.7's route list; the *shapes*, not the routes, are what
changed between spec and ship.)

### 3.3 WebSocket events (PART 5.3 — 12 events spec'd, DIFFERENT shape from shipped catalog)
```
slide:live       server→client  { slideId, slideData, timestamp }
slide:clear      server→client  { layer }
ai:suggestion    server→client  { slideId, confidence, reason, expiresAt }
status:update    server→client  { subsystem, state, message }
camera:moved     server→client  { cameraId, preset, pan, tilt, zoom }
dmx:scene:fired  server→client  { sceneId, sceneName }
stream:started   server→client  { streamId, platform }
stream:error     server→client  { streamId, code, message }
slide:next       client→server  { requestId }
slide:prev       client→server  { requestId }
macro:fire       client→server  { macroId, requestId }
cam:preset       client→server  { cameraId, presetId, requestId }
```
Note: spec'd client→server messages are **flat, no envelope wrapper** — the message IS
`{ type: 'slide:next', requestId }`, unlike the shipped `{ type: 'command', action, payload }`
three-level wrapper. This flat-vs-wrapped mismatch is exactly what shipped differently.

- **(C)** Handshake order MUST be: Host check → Origin check → token check. Any failure →
  reject upgrade `403`, do not open socket, do not reveal which check failed.
  Authenticated-then-later-invalid → close code **4001**.
- **(H)** Server sends `ping` every **10s**; client MUST `pong` within **5s** or close
  code **4002**. (PROBLEMS.md #33: **never implemented** in v2 — only a 2s preview-stub
  tick existed. Real gap; implement properly in Verger if a remote-WS surface is built.)
- **(M)** All client→server messages carry `requestId`; server echoes it in the
  corresponding ack so a flaky-Wi-Fi client can correlate/detect drops. (PROBLEMS.md #34:
  **never implemented** in v2 either.)

### 3.4 OPUS-008 reference implementation shape (blueprint pseudocode, lines 2940-3011)
```typescript
class RemoteServer {
  constructor(private port: number = 7320, private tokenStore: TokenStore) {}
  start(): void
  stop(): void
  broadcast(event: RhemaEvent): void
  private authenticate(req: IncomingMessage): string | null   // token from ?token= or Authorization header
  private startHeartbeat(ws: WebSocket): NodeJS.Timer          // ping 10s / pong-timeout 5s
}
interface RemoteClient { id: string; role: OperatorRole; connectedAt: Date; lastPong: Date }
```
Auth flow: connect `ws://localhost:7320/?token=<hex>` → `authenticate()` null → `ws.close(4001,'UNAUTHORIZED')` → else register client, start heartbeat, send
`{ type: 'connected', role: client.role, serverVersion: app.getVersion() }` (a
**connection-ack message type not present anywhere in the shipped API.md** — worth
adopting for Verger, it lets a client confirm its effective role immediately on connect).
Unknown inbound message `type` → log warning, do not error, connection stays open.

---

## 4. Drift record — spec vs. shipped (PROBLEMS.md, audited 2026-07-02, items #22-#35, #48, #51)

Verbatim, condensed:

- **#26 (C):** "No REST API server exists at all" at audit time — zero of 24 PART 5.2
  endpoints, nothing on 7321, no `/v1/status`. (Later fixed by Phase 4b per API.md's own
  note — API.md is the post-fix document.)
- **#27 (C):** "WS server wrong port + wrong contract: remote WS on 3001 (spec: 7320),
  captions on 8765, campus on 3002; none of the 12 PART 5.3 events implemented — bespoke
  protocol instead."
- **#28/#29 (C):** No Host-header allow-list (DNS-rebinding open) / no Origin allow-list
  (CSWSH open) at audit time — `remote/server.rs` checked only `?token=`.
- **#30 (H):** Default bind `0.0.0.0` when remote enabled (self-documented in
  `remote/mod.rs`) — spec mandates 127.0.0.1-first. Caption server (8765) binds `0.0.0.0`
  **by design** even in the fixed build.
- **#31 (H):** Auth was JWT/HS256, not the spec'd hashed-random-token+QR-pairing design.
  No `api_tokens` table at audit time (added later, per API.md).
- **#32 (H):** No LAN TLS/`wss` with TOFU cert pinning at audit time — LAN JWTs and
  captions traveled plaintext; caption QR emitted `ws://…?token=…` (plaintext, unlike
  the WS remote surface's later TLS-fingerprint design).
- **#33 (H):** No WS heartbeat at all (only a 2s preview-stub tick) — confirmed gap,
  status as of API.md is unclear (not mentioned as fixed).
- **#34 (M):** No `requestId` echo/ack correlation.
- **#35 (M):** No per-token 100 req/min rate limit — later added (API.md documents it as
  shipped).
- **#48 (C):** T8 (DNS rebinding/CSWSH) was "the blueprint's own top-marked threat" and
  fully unmitigated at audit time.
- **#51 (M):** "RBAC model diverges: functional roles (Supervisor/Presentation/Camera/
  Lighting/Stream/ReadOnly) instead of the four-tier Volunteer/Operator/Director/Admin
  (PART 9.2), enforced only on the remote surface" — i.e. the 4-tier model was NOT
  consistently enforced elsewhere (e.g. IPC), only bridged in for the remote API via
  `Tier::from_operator_role`.
- **#104 (M) [docs]:** "Port scheme silently diverged from blueprint with docs codifying
  the drift: docs/NETWORK_SETUP.md + API.md document 8420/3001/8765/3002 vs blueprint's
  7320(WS)/7321(REST). The blueprint's Stream Deck integration targets `localhost:7321`,
  which doesn't exist [at audit time]; the local `stream-deck-plugin/` targets the
  bespoke WS instead." (Note: an extra port, **8420**, appears in this item that is not
  explained elsewhere in either mined source — likely another ad hoc surface; if Verger
  ever needs it, it must be mined from `docs/NETWORK_SETUP.md` directly, not this note.)

**Root cause note:** API.md's own header explicitly acknowledges this history — "the
previous revision described the WS server on port 3001 with JWT-in-URL auth; both were
wrong as of Phase 4a/4b (PROBLEMS.md #27/#31)." So API.md is the *corrected*, current
document; PROBLEMS.md is the *historical* diagnostic. Both are accurate for their point
in time — use API.md for wire-format truth, PROBLEMS.md for "what mistakes were made and
fixed" (or, for #33/#104's extra port, possibly never fully fixed).

---

## 5. RBAC model comparison (for Verger's RBAC design)

**Blueprint's 4-tier ladder (PART 9.2, verbatim):**
```
Volunteer — Advance/back slides, go live, clear. Nothing else.
Operator  — All Volunteer + edit schedule, fire macros, camera presets, DMX scenes. Cannot configure hardware.
Director  — All Operator + configure hardware, edit macros/looks, full DMX programmer, AI configuration.
Admin     — All Director + user management, license management, reset all data.
```
Remote app connects as **Volunteer by default**; an Operator can elevate a Remote session
to Operator for **60 minutes** (privilege-elevation logged: who/when/expiry; requires
on-device confirmation by an already-authenticated Operator/Director, not just token
possession — PART 9.3).

**Shipped functional-role matrix** (§1.4 above) is a *different, coarser-grained*
model (per-subsystem booleans: Slides/LowerThirds/Camera/Lighting/Stream/Supervisor)
that maps down onto the 4-tier ladder only at the remote-API boundary
(`Tier::from_operator_role`) — it was never the primary RBAC model elsewhere in the app
(PROBLEMS.md #51).

**Recommendation for Verger:** pick ONE model and enforce it uniformly across IPC,
overlay, and any future remote API — do not let a second "convenience" role model grow
up around one surface the way it did in v2. The 4-tier ladder is simpler to reason about
end-to-end; the functional-role matrix is more legible to end users configuring "give
this Stream Deck camera-only access." If both are wanted, keep the mapping function
(`Tier::from_operator_role`-equivalent) as the ONLY place the two models touch, and make
every enforcement point (IPC `safeHandle`, overlay bridge, remote WS/REST) check the
same underlying tier, not re-derive functional roles independently.

---

## 6. Relevant threat-model entries (PART 9.1, condensed to protocol-relevant ones)

| ID | Sev | Threat | Control |
|---|---|---|---|
| T1 | H | Malicious renderer XSS reads IPC bridge, escalates to main | contextIsolation, sandbox, typed IPC, null-safe sender validation, custom scheme |
| T2 | H | LAN device abuses REST/WS to fire macros or clear output | Hashed token + timing-safe compare, localhost-first bind, explicit LAN opt-in, per-token rate limit |
| T8 | H | DNS rebinding / CSWSH — a visited web page resolves to 127.0.0.1 and drives the local server | Host-header allow-list + WS Origin allow-list — "the primary defense; token auth alone is insufficient because browsers auto-attach credentials" |
| T9 | M | Malicious/destructive macro fires rapid hardware actions | Per-session token-bucket rate limit on destructive channels; imported macros reviewed before first run; "Clear All" requires 2s hold even via API |
| T11 | H | Local code injection flips Electron into Node mode or swaps ASAR | Electron Fuses: `runAsNode=false`, `enableNodeCliInspectArguments=false`, `enableNodeOptionsEnvironmentVariable=false`, `onlyLoadAppFromAsar=true`, `embeddedAsarIntegrityValidation=true`, `grantFileProtocolExtraPrivileges=false` |

**(C) Linux secret-storage caveat (PART 9.1):** Electron `safeStorage` silently falls
back to plaintext-equivalent `basic_text` when no OS secret store is available. Must call
`safeStorage.getSelectedStorageBackend()` at startup; if `basic_text`: warn operator,
refuse to persist high-value secrets to disk (prompt per-session instead). Never claim
"encrypted at rest" on a `basic_text` system. Directly applicable to Verger since it's
real Electron this time (v2/Tauri used `keyring` crate instead, per ADR-001B's
equivalence table).

---

## Verger application notes

The Tauri engine, wgpu render compositor, and all Rust hardware-protocol code are **not
being ported** — only the message/protocol *shapes*, security patterns, and lessons
below carry forward.

1. **PART 3 (IPC Contract) is the primary spec, not API.md.** Because v2 never actually
   built Electron IPC (it built Tauri commands instead), PART 3's channel registry and
   `safeHandle` wrapper are fresh, unimplemented, Electron-native designs — implement
   them close to verbatim for Verger's main↔renderer↔overlay bus, renaming `rhema:*` →
   `verger:*` and `rhema://` → `verger://`.

2. **Pick ONE envelope shape and use it identically across IPC, overlay window, and any
   future remote WS/REST.** v2 has three different shapes for what's conceptually the
   same "typed message" idea: (a) IPC's flat named-channel `invoke`/`on` pairs (PART 3.1,
   never built), (b) the blueprint's flat `{ type: 'slide:next', requestId }` WS design
   (PART 5.3, never built), (c) the shipped `{ type: 'command'|'event'|'state'|'preview'|'error', action|event?, payload? }`
   nested-and-inconsistent design (API.md, real). Don't repeat pattern (c)'s
   inconsistency (different secondary key name — `action` vs `event` — depending on
   `type`, and `error` skipping the `payload` wrapper entirely). For Verger's Prompt-2
   protocol, prefer a single discriminated union, e.g.:
   ```typescript
   type Envelope =
     | { channel: 'command'; name: CommandName; requestId: string; payload: CommandPayloads[CommandName] }
     | { channel: 'event';   name: EventName;   payload: EventPayloads[EventName] }
     | { channel: 'state';   payload: StateSnapshot }
     | { channel: 'error';   code: ErrorCode; message: string; requestId?: string }
   ```
   with `payload` **always** present (even if `{}`) and the discriminant field name
   **never changing**.

3. **Adopt the coded-error pattern from `safeHandle` (§2.4), not API.md's bare-message
   error (§1.2).** Enumerate `INVALID_SENDER | INVALID_PAYLOAD | NO_SESSION | FORBIDDEN | RATE_LIMITED | INTERNAL_ERROR`
   (extend as needed) as a Verger-wide `ErrorCode` union, used identically by IPC, the
   overlay bridge, and any remote surface. Never throw raw errors across a process/window
   boundary.

4. **Zod-validate every message, both directions, at the boundary — not just IPC.** PART
   3.2's "all payload fields validated with Zod before processing in main" should extend
   to the overlay window's inbound bridge calls too. Keep one shared `protocol.ts` (or a
   small internal package) with Zod schemas that double as the TypeScript types — single
   source of truth for command names, event names, and payload shapes, imported by main,
   renderer, and overlay alike. This directly prevents v2's #27/#104-style drift (docs
   and code silently diverging) because there's only one file to update.

5. **Reuse the sender-origin validation pattern verbatim.** `event.senderFrame?.url`
   null-or-mismatch → reject, is Electron-idiomatic and directly reusable. Treat a
   destroyed/absent `senderFrame` as a rejection, never a pass-through — call this out
   explicitly in code review since it's an easy bypass to introduce accidentally.

6. **Overlay/output window gets a strictly smaller bridge than the operator window.**
   v2's Tauri port got this wrong (PROBLEMS.md #24 — all windows including
   `rhema-output-*` got broad `fs`/`shell` capabilities). In Verger, the overlay
   `contextBridge` preload should expose only state-consumption APIs (subscribe to
   `state`/`event` pushes) — no file, shell, or hardware-command invocation — enforced by
   using a **separate, smaller preload script** for the overlay BrowserWindow, not a
   shared one with runtime role checks.

7. **High-frequency channels: coalesce to ≤10Hz; never coalesce discrete events.** Directly
   reuse PART 3.5's rule: `status:update`-style channels keep-only-latest + fixed-cadence
   flush; `slide:advanced`/AI-suggestion-style discrete events always deliver individually,
   uncoalesced. Cap message payload size (256 KB was v2's number — sane default to keep).

8. **If/when Verger adds a remote-control WS/REST surface** (phones, Stream Deck), treat
   API.md (§1) as the known-working reference implementation to copy for the *external*
   protocol, but fix its two real gaps before shipping: implement the 10s-ping/5s-pong
   heartbeat with close codes 4001 (auth reject) / 4002 (heartbeat timeout) (never
   actually built per PROBLEMS.md #33), and implement `requestId` echo/ack correlation on
   commands (never actually built per PROBLEMS.md #34) — both were spec'd in PART 5.3 and
   both matter on "flaky church Wi-Fi" per the blueprint's own reasoning. Use ports 7320
   (WS) / 7321 (REST) if reusing v2's convention — don't reintroduce 3001/8765/3002/8420,
   which is documented ad hoc port sprawl v2 itself flags as a docs/reality drift problem
   (#104).

9. **RBAC: enforce one tier model everywhere, decide the mapping function once.** See §5.
   Recommend starting with the blueprint's 4-tier `Volunteer/Operator/Director/Admin`
   ladder as the sole enforcement primitive (checked in IPC `safeHandle`, the overlay
   bridge, and any remote surface identically); layer a functional/UI-facing role label
   on top only for display/config purposes if wanted, never as a second enforcement path.

10. **Electron-specific hardening in PART 3.3/3.4/9.1 (CSP, Fuses, `safeStorage`
    `basic_text` Linux fallback, navigation lockdown, permission-request denial-by-default)
    is directly applicable and was never exercised in v2 (Tauri equivalents differ) —
    treat as fresh, unverified-in-practice guidance, not battle-tested carryover.
