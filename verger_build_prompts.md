# Verger — 10 Build Prompts for Claude Code

*A senior-engineer decomposition of `vergerblueprint.md` into ten sequential, independently-shippable build prompts. Run them in order in Claude Code, one per session, and at the end you have the finished one-operator live-service production system described in the blueprint.*

---

## How to use this document

1. **Build target:** `C:\Side projects\rhema_v3` (currently empty — this is where the new program is built).
2. **Resource mine:** `C:\Side projects\rhema_v2` — a mature prior iteration ("Rhema"). It is a *heavier* Tauri/Rust design that this blueprint deliberately simplifies, so **we do not port its Rust engine.** We do harvest its docs, data, brand, i18n, config, YouTube/network know-how, and hard-won lessons. Every prompt names exactly which v2 files to read.
3. **Run one prompt per Claude Code session.** Open `rhema_v3` in Claude Code, paste Prompt *N*, let it finish, confirm the build is green, commit, then start a fresh session for Prompt *N+1*. Fresh context per phase keeps Claude focused and mirrors how v2 was successfully built (see `rhema_v2/PLAN.md` — 20 phases, one prompt each).
4. **Each prompt ends green and shippable.** No prompt leaves the tree broken. If a prompt can't finish a piece without a human (an API key, a signing cert, a legal call), it stubs it behind config and writes the ask to `HUMAN_TASKS.md` rather than blocking.
5. **The blueprint is immutable.** Prompt 1 copies `vergerblueprint.md` in as `BLUEPRINT.md` and never edits it again. `STATUS.md` is the running log; `HUMAN_TASKS.md` is the escalation list. (This governance loop is lifted from `rhema_v2/CLAUDE.md`.)

---

## Locked decisions (made during planning — carry these through every prompt)

| Decision | Choice | Consequence |
|---|---|---|
| Control-app runtime | **Electron** desktop app | `electron-vite` + React renderer + Node main process; package to a Windows installer in Prompt 10. |
| Compositor / streamer | **OBS Studio** (external engine) | The app *drives* OBS via `obs-websocket` v5; it never composites video itself and is never a single point of failure for the live output. |
| Speech-to-text | **Pluggable ASR, both providers** | A provider interface with a **Deepgram** (cloud, low-latency Korean) adapter *and* a **faster-whisper** (local, offline) adapter; switchable in settings, cloud default with local fallback. |
| v2 relationship | **Fresh build, mine v2 for assets/docs** | Start clean; reuse data/brand/i18n/config/patterns; leave the Rust/compositor complexity behind. |
| Scope | **Whole blueprint, Phases 0–4** | The 10 prompts cover foundation → one-click live → ears → following → polish. |
| OS / language | **Windows-first, Korean + some English** | Implied by v2 and the blueprint's Korean examples; drives ASR vocab and i18n. |

---

## Target stack (Prompt 1 establishes this; later prompts assume it)

- **Shell:** Electron + `electron-vite` (or Vite + `electron-builder`), TypeScript everywhere, `contextIsolation: true`, a typed IPC bridge via `preload`.
- **Renderer (control UI):** React 19, Tailwind CSS 3, Zustand 5, `@dnd-kit/*` (cue reordering), `lucide-react` (icons), `clsx`. Dark, high-contrast, big-touch-target "booth" theme. **Mirror `rhema_v2/package.json` dependency choices**, swapping the Tauri packages for Electron ones.
- **Main process (Node):** `obs-websocket-js` (v5), `googleapis` (YouTube Data API v3), `ws` + `express` (overlay server + control WebSocket), Electron `safeStorage`/`keytar` (secret storage), `@deepgram/sdk` (cloud ASR), a `faster-whisper` sidecar (local ASR, via child process).
- **Overlay pages:** plain HTML/CSS/JS (framework-free is fine) served locally and loaded into OBS as **browser sources**, driven over a WebSocket — a layer independent of cameras and slides.
- **i18n:** `i18next` + `react-i18next` + `i18next-browser-languagedetector`, EN/KO, pseudo-locale in CI. Follow `rhema_v2/docs/I18N.md` verbatim in structure.
- **Testing:** `vitest` + `@testing-library/react` for units, `playwright` for e2e, `jest-axe` for a11y. Every phase adds tests and ends green.

---

## Standing rules (Claude: obey these in every prompt — they are also worth pasting into each session)

1. **Human always wins.** Every automated action is overridable in one tap. Assist mode is the default; auto-fire is opt-in per cue. A wrong automated action mid-service is unacceptable — design for veto, not trust.
2. **OBS is the resilient engine; the app is a convenience layer.** If the app crashes, OBS keeps streaming and recording. On relaunch, the app *reconnects to OBS's current state* — it never assumes it owns that state.
3. **Always-on local recording.** Whenever streaming starts, OBS local recording starts too. It is the backup if the internet wobbles. Never make this optional.
4. **Never output bulk copyrighted text from the model.** Do **not** have any agent emit whole Bibles, verse text, or song lyrics into code — it trips content filters *and* creates legal exposure (this is a documented v2 failure, see `rhema_v2/PLAN.md` "Content-filter lesson"). Bundle only **verified public-domain** data loaded from files; fetch copyrighted translations live from a **licensed API** (ESV / API.Bible) with attribution. Follow `rhema_v2/docs/SEED_COPYRIGHT_PROCESS.md`.
5. **Secrets live in `.env` (gitignored); mirror every key name into `.env.example` with an empty value.** An empty value means "run this subsystem in degraded/not-configured mode," never crash. Model this on `rhema_v2/.env.example`.
6. **Destructive/high-stakes actions require a deliberate hold, not a tap.** "Take over from AI" must be one safe action away and must never blank the congregation screen. Copy the UX reasoning in `rhema_v2/docs/SHORTCUTS.md` (ESC-hold disables AI only; a separate held "Clear All" clears output).
7. **Loopback-first networking.** Bind servers to `127.0.0.1` by default; LAN exposure is an explicit opt-in with a concrete IP. See `rhema_v2/docs/NETWORK_SETUP.md`.
8. **End every phase green:** `npm run build` / `tsc --noEmit` clean, `vitest run` passing, and the phase's own acceptance checklist satisfied. Append a `STATUS.md` cycle entry. Escalate anything human-only to `HUMAN_TASKS.md`.

---

## Where to find resources in `rhema_v2` (quick map)

| You need… | Read in `rhema_v2` |
|---|---|
| The exhaustive prior spec (edge cases, post-service, CCLI, confidence math) | `Rhema_Blueprint_v3.4.md` (238 KB — search it, don't read whole) |
| Autonomous build-loop governance (BLUEPRINT/STATUS/HUMAN_TASKS) | `CLAUDE.md` |
| Dependency choices to mirror (minus Tauri) | `package.json` |
| ASR pipeline design: two-tier Whisper, VAD, hallucination filter, confidence bands | `docs/AI_PIPELINE.md` |
| Control/overlay message protocol, events, RBAC | `docs/API.md` |
| Ports, bind posture, firewall, security | `docs/NETWORK_SETUP.md` |
| Hardware tiers, GPU-for-Whisper guidance | `docs/HARDWARE_REQUIREMENTS.md` |
| First-run + service-day operator flow | `docs/GETTING_STARTED.md` |
| Keyboard map + the "holds not taps" safety UX | `docs/SHORTCUTS.md` |
| i18n structure (EN/KO, pseudo-locale, RTL) | `docs/I18N.md` |
| Model registry + SHA-256 pinning pattern | `config/models.json` |
| Copyright/CCLI/EULA obligations + PD verification process | `docs/LEGAL_OBLIGATIONS.md`, `docs/SEED_COPYRIGHT_PROCESS.md` |
| Signed auto-update via Cloudflare (adapt to `electron-updater`) | `docs/AUTO_UPDATE.md`, `cloud/update-manifest/`, `cloud/workers/` |
| Secret/key contract | `.env.example` |
| Brand art | `brand/` (note: `logo.png` is currently a 0-byte placeholder — real art is a HUMAN_TASK) |

> **Heavy binaries & models:** `rhema_v2/PLAN.md` references an out-of-repo resource pool at `C:\ClaudeFlow\projects\rhema\resources\` (Whisper `ggml-*.bin` / ONNX models, `bibles/catalog.json`, `bin/win/ffmpeg.exe`) and a shared `.env`. **Verify it still exists** before relying on it; if present it saves re-downloading Whisper models and ffmpeg for the local-ASR path. If absent, the local-ASR prompt downloads models on demand.

---

# The 10 prompts

Copy the fenced block for each prompt into a fresh Claude Code session opened on `C:\Side projects\rhema_v3`.

---

## Prompt 1 — Foundation: Electron shell + OBS connection + governance

```
You are building "Verger" (working title; may be branded "Rhema v3") — a one-operator
live-service production control app — in this folder (C:\Side projects\rhema_v3).
Read the full design in vergerblueprint.md before starting. Resources you may reuse
live in C:\Side projects\rhema_v2 (a heavier prior Tauri build — mine its docs/assets,
do NOT port its Rust). Follow the Standing Rules you were given.

GOAL: A running Electron app that connects to OBS Studio and shows live connection
status. This is the skeleton every later phase builds on.

READ FIRST:
- vergerblueprint.md (whole file — sections 1-3, 8, 10 especially)
- rhema_v2/CLAUDE.md (the immutable-blueprint / STATUS.md / HUMAN_TASKS.md loop)
- rhema_v2/package.json (dependency choices to mirror, minus @tauri-apps/*)
- rhema_v2/docs/GETTING_STARTED.md, rhema_v2/.env.example

BUILD:
- Scaffold Electron + electron-vite + React 19 + TypeScript + Tailwind + Zustand +
  i18next + @dnd-kit + lucide-react. contextIsolation on; a typed preload IPC bridge;
  NO nodeIntegration in the renderer.
- Main-process OBS client using obs-websocket-js v5: connect(url,password) from config,
  auto-reconnect with backoff, expose a small typed API (getVersion, getSceneList,
  connection state) and push status events to the renderer over IPC.
- A "Connection" screen: OBS host/port/password fields, a big status indicator
  (Connected / Reconnecting / Down), OBS version + scene list when connected.
- Config + secrets: load from .env; create .env.example mirroring every key with empty
  values. Add OBS_WEBSOCKET_URL, OBS_WEBSOCKET_PASSWORD now; carry over the relevant
  key NAMES from rhema_v2/.env.example (DEEPGRAM_API_KEY, ESV_API_KEY, API_BIBLE_KEY,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SENTRY_DSN) as empty placeholders.
- Dark, high-contrast "booth" theme; large touch targets; the app must be readable at
  a glance in a dark room. Wire i18next (EN + KO) per rhema_v2/docs/I18N.md structure.
- Governance: copy vergerblueprint.md to BLUEPRINT.md (immutable). Create STATUS.md and
  HUMAN_TASKS.md. Create a CLAUDE.md for this repo adapting rhema_v2/CLAUDE.md's loop.
- Structured logging to a rolling file in userData; a global error boundary.

REUSE FROM v2: package.json (stack), docs/I18N.md (i18n wiring), CLAUDE.md (governance),
.env.example (key contract), docs/GETTING_STARTED.md (first-run intent).

DONE WHEN: `npm run build` and `tsc --noEmit` are clean; the app launches, connects to a
running OBS with obs-websocket enabled, shows Connected + the scene list, and survives
OBS being closed/reopened (auto-reconnect). Vitest has unit tests for the OBS client's
reconnect/state logic (mock the socket).

VERIFY: run the build + tests; launch and confirm connect/disconnect/reconnect; take a
screenshot of the Connection screen in both states. Append a STATUS.md cycle entry.

ESCALATE to HUMAN_TASKS.md: "Install OBS Studio 30+ and enable Tools → WebSocket Server
Settings; put the URL/password in .env." Real brand art (rhema_v2/brand/logo.png is empty).
```

---

## Prompt 2 — Layered scenes, the overlay server, and the WebSocket bus

```
Read BLUEPRINT.md (sections 3, 6, 7) and the Standing Rules. This phase creates the
independent OVERLAY layer that makes lower-thirds/scripture/slides survive camera
switches — the architectural core of the whole system.

GOAL: A local overlay web server + control WebSocket, an overlay page that renders as an
OBS browser source, and a documented OBS scene contract.

READ FIRST:
- BLUEPRINT.md sections 6 (independent layers) and 7 (Service Plan shapes)
- rhema_v2/docs/API.md (reuse its command/state/event message design and event names
  like SlideAdvanced, BibleReferenceDetected — adapt, don't copy the RBAC/ports wholesale)
- rhema_v2/docs/NETWORK_SETUP.md (loopback-first bind posture)

BUILD:
- An Express static server + a `ws` WebSocket server in the Electron main process,
  bound to 127.0.0.1 by default (LAN opt-in later). Serve overlay pages from it.
- overlay.html: a full-viewport transparent page with independent layers — lowerThird,
  scripture, slide — each animated in/out with CSS. It opens a WebSocket to the server
  and renders messages like:
    { type:"lowerthird", action:"show", line1:"홍길동", line2:"찬양 인도" }
    { type:"lowerthird", action:"hide" }
    { type:"scripture", action:"show", ref:"요한복음 3:16", text:"..." }
    { type:"slide", action:"show", src:"slides/point1.png" }
- Define a single typed message protocol (shared TS types between main, renderer, and a
  JS copy for the overlay). Server keeps last-known state per layer and RE-SENDS it when
  an overlay reconnects (watchdog resilience — the overlay can crash and re-sync).
- A renderer "Overlay" panel to fire test messages and see them appear.
- A short docs/OBS_SETUP.md: how to add the "Overlays" browser source (URL, size,
  "Shutdown source when not visible" OFF, "Refresh browser when scene becomes active"),
  and the scene layout: each camera scene has camera source(s) + the SAME persistent
  Overlays browser source on top.

REUSE FROM v2: docs/API.md (message envelope: {type, action, payload}; event catalog),
docs/NETWORK_SETUP.md (127.0.0.1 default, explicit LAN opt-in).

DONE WHEN: build/tsc/tests green; loading the overlay URL in a browser (and as an OBS
browser source) shows lower-thirds/scripture/slides animating on command; killing and
reloading the overlay re-syncs to current state. Vitest covers the protocol +
state-resync logic.

VERIFY: script a show→hide→show sequence; reload the overlay mid-sequence and confirm it
restores. Screenshot the overlay over a test camera scene. STATUS.md entry.
```

---

## Prompt 3 — Camera switching + independent lower-thirds (Blueprint Feature 3 — kills the PowerPoint pain)

```
Read BLUEPRINT.md section 6 and the Standing Rules. This phase delivers the biggest,
lowest-risk relief: cameras and overlays become two INDEPENDENT controls. After this
phase the operator can already run a service manually, no transparent-PowerPoint hack.

GOAL: One-tap camera switching and one-tap lower-thirds, fully decoupled.

READ FIRST:
- BLUEPRINT.md section 6; rhema_v2/docs/SHORTCUTS.md (the "holds not taps" safety UX and
  the keyboard map — SPACE/B/L/F/ESC-hold/Y/N); rhema_v2/docs/API.md (camera commands).

BUILD:
- Camera controls: big buttons CAM 1 / CAM 2 / WIDE / PULPIT mapped to OBS
  SetCurrentProgramScene (or source visibility toggles), with a settings screen to map
  each button to a scene/source name discovered from OBS. Show which camera is live.
- Transitions: let the operator pick the OBS transition (cut/fade) per button; transitions
  are configured once in OBS and reused.
- Lower-thirds control: line1/line2 inputs, a template picker, SHOW and HIDE — sent over
  the overlay WebSocket from Prompt 2. Switching cameras must NOT touch the lower-third,
  and showing a lower-third must NOT touch the camera. Prove this with a test.
- Keyboard + foot-pedal-ready input: implement the SHORTCUTS.md core keys (SPACE advance,
  B black, L logo, F freeze, ESC-hold = disable-AI-only, SHIFT+ESC dismiss lower-thirds,
  a separate held "Clear All"). Route through one action dispatcher so a foot pedal /
  Stream Deck (keyboard-HID) works for free now and a real pedal binds in Prompt 10.
- A lower-third template set: adapt a handful of clean CSS templates (v2 shipped ~50 JSON
  lower-third templates — reuse the JSON shape/animation ideas, not the Rust renderer).

REUSE FROM v2: docs/SHORTCUTS.md (keymap + safety UX), docs/API.md (camera_preset/move
command shapes), Phase-07 lower-third template concept (JSON template + CSS animation).

DONE WHEN: build/tsc/tests green; operator can switch cameras and toggle lower-thirds
independently; a test asserts a camera switch leaves overlay state untouched and vice
versa; keyboard shortcuts work and are remappable. STATUS.md entry.

VERIFY: record a short GIF/screenshots of: camera switch with a lower-third staying put,
then lower-third show/hide with the camera unchanged.
```

---

## Prompt 4 — One-click YouTube Live, Part A: OAuth + broadcast lifecycle (Blueprint Feature 2)

```
Read BLUEPRINT.md section 5 and the Standing Rules. This phase builds the YouTube control
layer up to (but not including) the GO-LIVE orchestration, which is Prompt 5. Build it
mock-tested so it's green without real credentials (mirror how v2 shipped cloud code).

GOAL: Google OAuth once, then create/bind a YouTube broadcast from a template.

READ FIRST:
- BLUEPRINT.md section 5 (all 5 steps + "details that matter"); rhema_v2/.env.example and
  rhema_v2/docs/LEGAL_OBLIGATIONS.md (CCLI streaming-license gating + attribution rows).

BUILD:
- Google OAuth2 desktop flow (loopback redirect) using googleapis. Scope:
  youtube + youtube.force-ssl. Store the refresh token with Electron safeStorage (or
  keytar) so future go-lives are silent. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from .env.
- YouTube service module:
    - liveBroadcasts.insert with a templated title/description ("Sunday Service — {date}"),
      privacy, scheduledStartTime, thumbnail.
    - Reuse a PERSISTENT liveStream (liveStreams.list / insert once) so the RTMP key never
      changes and OBS stays pre-configured; liveBroadcasts.bind the stream to the broadcast.
    - Helpers: transition(status) and a stream-health poll (to be driven in Prompt 5).
- A "Go Live" settings screen: title/description/privacy template, scheduled start,
  thumbnail picker, and a "connected as <channel>" state. A pre-flight CCLI check hook
  (warn if any queued song lacks copyright metadata) per LEGAL_OBLIGATIONS.md.
- Everything testable against a mocked YouTube client; NO network in unit tests.

REUSE FROM v2: .env.example (key names), docs/LEGAL_OBLIGATIONS.md (rows 2-4: CCLI
streaming-license gate, auto attribution, missing-metadata warning).

DONE WHEN: build/tsc/tests green; with a filled .env the app completes OAuth and can
create+bind a broadcast against a persistent stream (verify on YouTube Studio); with an
empty .env it shows "not configured" and never crashes. Vitest covers insert/bind/
transition against the mock.

VERIFY: run the mocked-flow tests; if a test Google account + a real stream key are
available, do one real create+bind and confirm it appears in YouTube Studio, then delete it.

ESCALATE to HUMAN_TASKS.md: create a Google Cloud project, enable YouTube Data API v3,
make an OAuth desktop client, paste ID/secret into .env; obtain/record the CCLI streaming
license number; confirm the persistent stream key is set in OBS.
```

---

## Prompt 5 — One-click YouTube Live, Part B: GO LIVE / END orchestration + auto-record

```
Read BLUEPRINT.md section 5 and the Standing Rules (especially: always-on local recording).
This phase turns Prompt 4's pieces into the single GO LIVE / END buttons.

GOAL: One button takes you live end-to-end; one button ends cleanly; recording always runs.

READ FIRST: BLUEPRINT.md section 5 steps 3-5; rhema_v2/docs/NETWORK_SETUP.md (RTMP
outbound); rhema_v2/docs/HARDWARE_REQUIREMENTS.md (streaming bitrate guidance).

BUILD:
- GO LIVE sequence (with clear per-step UI state and failure handling):
    1. Ensure broadcast created+bound (Prompt 4).
    2. OBS StartStream (obs-websocket) pushing to YouTube ingest.
    3. Start OBS local recording at the SAME time (StartRecord) — always, as backup.
    4. Poll GetStreamStatus + YouTube stream health until healthy, then
       liveBroadcasts.transition -> "live".
    5. Surface a big LIVE indicator with elapsed time + health.
- END sequence: liveBroadcasts.transition -> "complete", OBS StopStream, StopRecord;
  confirm-with-hold so it can't be hit by accident (per SHORTCUTS.md safety UX).
- Degradation: if transition fails or health never turns healthy, keep recording, show a
  clear error, and let the operator retry or fall back to manual OBS control — the app must
  never wedge the stream. If OBS is streaming but the app crashed, on relaunch detect the
  in-progress stream/recording and re-attach rather than double-starting.
- Quota-awareness note in the UI (YouTube daily quota is fine for a few services/day).

REUSE FROM v2: docs/NETWORK_SETUP.md (outbound RTMP/firewall), docs/HARDWARE_REQUIREMENTS.md
(bitrate tiers), the general "record the real feed / backup" intent from v2 HUMAN_TASKS.

DONE WHEN: build/tsc/tests green; GO LIVE performs stream+record+transition against mocks
in tests and (if creds available) for real; END reverses it; recording is verified to start
whenever streaming does; crash-mid-stream re-attach is covered by a test. STATUS.md entry.

VERIFY: mocked end-to-end GO-LIVE/END test; if possible one real dry-run to an unlisted
broadcast, confirm the local recording file exists afterward.
```

---

## Prompt 6 — Service Plan data model, authoring editor, and PowerPoint import (Blueprint Feature 1 groundwork)

```
Read BLUEPRINT.md section 7 and the Standing Rules (especially rule 4 on copyrighted text).
This phase builds the authored "order of service" that the cue engine will follow — but it
must be fully useful as a MANUAL slide/media driver first.

GOAL: Author a Service Plan of cues, import existing PowerPoint slides as slide payloads,
and drive slides/media into OBS + the overlay manually.

READ FIRST:
- BLUEPRINT.md section 7 (the Service/Cue JSON shape and trigger.mode values)
- rhema_v2/PLAN.md (Phase 04 = "sandboxed file import PPTX/PDF, media library, playlist,
  @dnd-kit ServicePlaylist" — reuse the shape and the sandbox lesson; NOTE its warning that
  PPTX per-slide images need the slide _rels media mapping parsed)
- rhema_v2/PLAN.md "Content-filter lesson" (never emit bulk slide/scripture TEXT from an agent)

BUILD:
- Implement the Service Plan schema exactly per BLUEPRINT.md section 7: a Service = ordered
  Cues; each cue { id, type (scene|slide|media|scripture|lowerthird|action), label,
  trigger {mode: manual|anchor|scripture|hotphrase, text?}, payload, options
  {autoFireThreshold?, confirmAlways?} }. Add a validator (zod) + JSON load/save.
- Cue editor UI: an ordered list with @dnd-kit reordering; add/edit/delete cues; per-cue
  trigger + payload + options editors. Import/export the plan as JSON.
- PowerPoint import: convert a .pptx to per-slide images and create one slide cue per slide
  (images become slide payloads; the operator then attaches triggers). Do the conversion in
  a child process / sandbox (untrusted input isolation) — prefer a headless LibreOffice
  (soffice --headless --convert-to) or a bundled renderer; store images under the plan's
  asset folder. Handle text-only vs image slides. DO NOT read slide text into the model as
  bulk content — treat slides as opaque image assets.
- Manual playback: selecting/advancing a slide cue shows its image via the overlay slide
  layer (Prompt 2); a media cue triggers an OBS media source (TriggerMediaInputAction) or a
  media scene. SPACE advances to the next cue (per SHORTCUTS.md).

REUSE FROM v2: PLAN.md Phase-04 import design + its documented PPTX gotchas; @dnd-kit
(already a dep); the sandbox-child-process pattern for parsing untrusted files.

DONE WHEN: build/tsc/tests green; operator can import a real .pptx, get one slide cue per
slide with a rendered image, reorder cues, save/load the plan, and manually advance slides
into the overlay/OBS. Vitest covers schema validation + plan load/save + cue advance logic.

VERIFY: import a sample deck end-to-end; screenshot the editor + a slide shown live via the
overlay. STATUS.md entry.

ESCALATE to HUMAN_TASKS.md: install the chosen PPTX->image converter (e.g. LibreOffice) if
not bundled.
```

---

## Prompt 7 — Ears: pluggable ASR with Deepgram (cloud) + faster-whisper (local) (Blueprint Feature 2)

```
Read BLUEPRINT.md sections 4 and 8 and the Standing Rules. This phase gives the system a
live transcript. Build the ABSTRACTION plus BOTH adapters (cloud default, local fallback).

GOAL: A streaming transcript of the pulpit mic, provider-switchable, with custom vocabulary.

READ FIRST:
- BLUEPRINT.md section 4 (near-real-time partials, degrade well) and section 8 (local vs
  cloud trade-offs; custom vocab / keyword boosting is essential)
- rhema_v2/docs/AI_PIPELINE.md (two-tier Whisper: tiny draft ~500ms + large-v3 final ~5s,
  Silero VAD gate, HallucinationFilter — reuse this design for the local adapter)
- rhema_v2/config/models.json (Whisper model ids/licenses + SHA-256 pin pattern)
- rhema_v2/docs/HARDWARE_REQUIREMENTS.md (GPU guidance for local Whisper)

BUILD:
- An AsrProvider interface: start(audioStream) -> emits { text, isFinal, tsStart, tsEnd }
  partials every ~200-500ms; stop(); a customVocabulary/keyword-boost list; a health/status
  signal. Mic capture in the main process (choose input device in settings).
- Deepgram adapter (@deepgram/sdk): streaming, Korean model, keyword boosting for the
  pastor's name, church name, hymn titles, recurring terms. DEEPGRAM_API_KEY from .env.
- faster-whisper adapter: run faster-whisper as a local sidecar (Python child process or a
  packaged binary). Implement the AI_PIPELINE.md two-tier scheduler (fast draft model for
  immediate feedback, larger model for accurate final that REPLACES the draft) + a VAD gate
  + a hallucination filter. Verify model files against config/models.json SHA-256 pins
  (empty pin = pass-with-warning). Check the C:\ClaudeFlow\...\resources\models pool first
  for existing ggml/onnx models before downloading.
- Settings: pick provider (Cloud default / Local / Auto-fallback to local on cloud failure),
  edit the custom-vocabulary list, choose mic + language (KO/EN).
- A live transcript panel with clear provider + latency + health readouts. If ASR fails,
  status goes red and the system silently falls back to manual (never blocks the operator).

REUSE FROM v2: docs/AI_PIPELINE.md (two-tier + VAD + hallucination filter), config/models.json
(model registry + pinning), docs/HARDWARE_REQUIREMENTS.md (tiering), and the
C:\ClaudeFlow\...\resources model pool if it exists.

DONE WHEN: build/tsc/tests green; with a Deepgram key, speaking into the mic yields live KO
partials with boosted vocab; with the local adapter, the two-tier transcript works offline
(draft then corrected). Provider switch + auto-fallback covered by tests (mock the streams —
do NOT put real audio/text fixtures of copyrighted material in the repo). STATUS.md entry.

VERIFY: run both adapters live for a minute each; record latency numbers in STATUS.md.

ESCALATE to HUMAN_TASKS.md: Deepgram account + key; for local ASR on Windows, confirm GPU /
CUDA (or accept CPU latency) and provision Whisper model files.
```

---

## Prompt 8 — The Cue Engine: scripture detector + hot-phrase + plan-follower + trust dial (Blueprint Feature 1, the core)

```
Read BLUEPRINT.md section 4 (all of it) and the Standing Rules (human always wins). This is
the brain. Build the three parallel detectors and the trust dial. Assist mode is the default
and must be genuinely useful even when the pastor goes off-script.

GOAL: Watch the transcript, suggest/pre-load the right cue, detect scripture live, and let
the operator confirm with one tap — with per-cue auto/assist/manual control.

READ FIRST:
- BLUEPRINT.md section 4 (position pointer, look-ahead window, three parallel detectors,
  the trust dial, "why it degrades well")
- rhema_v2/docs/AI_PIPELINE.md (scripture confidence bands: 0.95 exact/abbrev -> auto-show,
  0.65 Levenshtein-1 -> show with "?", 0.50 -> show with "?", below -> discard; and the
  "never auto-show unless verse text resolved" gate)
- rhema_v2/PLAN.md Phase-06 (2-tier Bible detector regex+entity, EN/KO verbal triggers,
  dwell logic, human-always-wins) and Phase-13 (theological entity lists)

BUILD:
- Scripture detector: match references in KO ("요한복음 3장 16절", "받으실 말씀은" priming) and
  EN ("Romans chapter 8", "turn to John 3:16"). Reuse the v2 confidence bands. On a confident
  hit, RESOLVE the verse text (see below) and offer a scripture overlay/slide. This works in
  fully extemporaneous preaching — the single highest-value feature.
- Verse resolution WITHOUT bundling copyrighted text: fetch from a licensed API (ESV_API_KEY /
  API_BIBLE_KEY) with attribution, OR read a VERIFIED public-domain local translation loaded
  from a data file (follow rhema_v2/docs/SEED_COPYRIGHT_PROCESS.md — quarantine anything whose
  PD status is unconfirmed, e.g. Korean KRV). Never have the model type verse text into code.
- Hot-phrase detector: a configurable phrase->action map ("let's pray" -> prayer slide,
  "let's welcome" -> welcome loop, "받으실 말씀은" -> prime scripture). Fast substring/aho-corasick.
- Plan-follower: keep a position pointer in the Service Plan + a small look-ahead window of
  the next few cues; fuzzy-match the recent transcript against those cues' anchor text. When a
  match crosses a threshold, either auto-fire (auto mode) or light up the suggested next cue
  (assist mode). Pre-load the next slide so firing is instant.
- Trust dial (per service AND per cue): Assist (default: highlight next cue, confirm by
  tap/pedal), Auto (high-confidence fires itself, low-confidence waits — honor each cue's
  autoFireThreshold and confirmAlways), Manual (passive suggestions only). A master
  "panic -> full manual" switch. Y confirms / N dismisses a pending suggestion; a one-tap
  BACK/undo. When plan-following loses alignment (off-script), it quietly waits while
  scripture + hot-phrase detectors keep working — never get stuck.

REUSE FROM v2: docs/AI_PIPELINE.md (confidence bands + auto-show gate), PLAN.md Phase-06/13
(bilingual triggers, entity matching, dwell, human-always-wins), docs/API.md
(BibleReferenceDetected event shape).

DONE WHEN: build/tsc/tests green; feeding a scripted transcript through the engine (a) detects
KO+EN scripture refs at the right confidence bands, (b) fires hot-phrases, (c) advances the
plan by fuzzy match in assist and auto modes, (d) always honors manual override / BACK, and
(e) keeps scripture+hotphrase working when plan alignment is lost. All covered by unit tests
with SYNTHETIC transcripts (no copyrighted fixtures). STATUS.md entry.

VERIFY: run the engine against a canned off-script transcript and confirm it never
auto-fires below threshold and never blocks the operator. Record precision notes in STATUS.md.

ESCALATE to HUMAN_TASKS.md: ESV / API.Bible keys; Korean Bible PD/licensing decision
(KRV status is contested per v2 — license, confirm PD, or use a licensed API).
```

---

## Prompt 9 — Resilience & safeguards (Blueprint section 9)

```
Read BLUEPRINT.md section 9 (the failure-modes table) and the Standing Rules. This phase makes
the system trustworthy for a live, un-repeatable event. Every failure mode in the blueprint
gets a defined, tested fallback.

GOAL: No single failure stops the service; every degradation is visible and recoverable.

READ FIRST: BLUEPRINT.md section 9; rhema_v2/docs/GETTING_STARTED.md ("Emergency Recovery");
rhema_v2/docs/SHORTCUTS.md (PANIC + CTRL+D checkpoint recovery).

BUILD each safeguard from the blueprint table:
- Internet drops mid-stream: rely on OBS auto-reconnect + the always-on local recording
  (Prompt 5). Detect + surface "stream reconnecting" without touching recording.
- ASR errors / provider down: auto-fall back to manual, red status light, engine keeps
  running in manual — never blocks the operator (Prompt 7/8 hooks).
- Wrong auto-trigger: assist-mode default + instant override + one-tap BACK/undo (Prompt 8).
- Overlay browser source crashes: a watchdog detects a dropped overlay socket and reloads it;
  the overlay re-syncs state on reconnect (Prompt 2 state cache). Test the crash+resync.
- Control-app crash: OBS keeps streaming/recording; on relaunch the app reconnects to OBS's
  CURRENT state (stream/record in progress, current scene) instead of resetting it.
- Operator overload: a "panic -> full manual" master switch (halts all automation, keeps
  stream+recording live), and a status dashboard with a light per subsystem (OBS, overlay,
  ASR, YouTube, recording) that is readable at a glance in the dark.
- A last-checkpoint recovery (CTRL+D style) that rewinds recent automation state safely.

REUSE FROM v2: docs/GETTING_STARTED.md (recovery flows), docs/SHORTCUTS.md (PANIC semantics:
never cuts video), the v2 watchdog/deadman-switch concepts (Phase-19) — reimplement simply in
Node, don't port Rust.

DONE WHEN: build/tsc/tests green; integration tests SIMULATE each failure (kill overlay socket,
kill+relaunch app against a still-streaming OBS, ASR throwing, YouTube transition failing) and
assert the defined fallback happens and the stream/recording is never dropped by the app.
STATUS.md entry.

VERIFY: run the failure-injection suite; manually kill the overlay source in OBS and confirm
auto-reload + resync; screenshot the subsystem status dashboard.
```

---

## Prompt 10 — Polish, monitoring, packaging & end-to-end (Blueprint Phase 4)

```
Read BLUEPRINT.md sections 10-12 and the Standing Rules. Final phase: the "extra arms"
refinements, a monitoring view, a real installer, and a full end-to-end verification.

GOAL: A packaged, installable Windows app with foot-pedal support, weekly templates,
multi-language, monitoring, docs, and a green e2e pass.

READ FIRST:
- BLUEPRINT.md sections 10 (Phase 4 bullet), 11 (decisions), 12 (summary)
- rhema_v2/docs/AUTO_UPDATE.md + cloud/ (adapt the signed-manifest idea to electron-updater)
- rhema_v2/docs/I18N.md (finish EN/KO coverage + pseudo-locale CI), docs/ACCESSIBILITY.md
- rhema_v2/docs/SHORTCUTS.md (remappable bindings), docs/HARDWARE_REQUIREMENTS.md

BUILD:
- Foot pedal / Stream Deck: real HID/MIDI pedal binding for confirm/advance/next-camera
  (the action dispatcher from Prompt 3 already abstracts this) + a remap UI.
- Confidence tuning: operator-facing sliders for auto-fire thresholds + per-cue overrides,
  with sensible defaults from the v2 confidence bands.
- Weekly templates: save a service as a reusable template; "new service from template"
  re-templates the YouTube title/thumbnail and clones the cue skeleton for the week.
- Multi-language: finish i18next EN/KO coverage of the operator UI per docs/I18N.md; run the
  pseudo-locale build in CI to catch un-extracted strings.
- Monitoring dashboard: subsystem health (OBS/overlay/ASR/YouTube/recording), stream health,
  ASR latency, current mode + position pointer — glanceable in a dark booth.
- Packaging: electron-builder Windows NSIS installer; app icon/brand; optional auto-update via
  a signed manifest (adapt rhema_v2/docs/AUTO_UPDATE.md + cloud/update-manifest to
  electron-updater). Generate a bundled third-party LICENSE/NOTICE file (Electron is MIT;
  list overlay/YouTube/ASR deps) per rhema_v2/docs/LEGAL_OBLIGATIONS.md.
- Docs: write GETTING_STARTED.md, SHORTCUTS.md, and a service-day runbook for THIS app
  (adapt the v2 versions). Finalize HUMAN_TASKS.md.

REUSE FROM v2: docs/AUTO_UPDATE.md + cloud/ (update pattern), docs/I18N.md (i18n finish),
docs/SHORTCUTS.md + docs/ACCESSIBILITY.md (bindings + a11y), docs/LEGAL_OBLIGATIONS.md (NOTICE).

DONE WHEN: build/tsc/tests green; `electron-builder` produces a Windows installer that
installs and launches; a Playwright e2e test drives a full mock service (connect OBS -> import
deck -> GO LIVE (mock) -> ASR feed -> scripture/cue in assist mode -> lower-third -> END) and
passes; i18n pseudo-build shows no un-extracted strings. Append a STATUS.md "COMPLETE" cycle.

VERIFY: install the built artifact on a clean Windows profile and run the service-day runbook
manually; run the Playwright e2e; capture a short screen recording of the full flow.

ESCALATE to HUMAN_TASKS.md: Windows code-signing (EV cert) for the installer + updater;
real brand art; Cloudflare/R2 (or other host) for the update manifest if auto-update is wanted;
final legal review of any bundled translations + CCLI/EULA wording.
```

---

## Prompt → Blueprint mapping (coverage check)

| Prompt | Blueprint phase / section | Problem solved |
|---|---|---|
| 1 — Electron shell + OBS connection | Phase 0 · §3, §8 | Foundation; app talks to OBS |
| 2 — Overlay server + WebSocket bus | Phase 0 · §6, §7 | The independent overlay layer |
| 3 — Cameras + lower-thirds (decoupled) | Phase 0 · §6 | **#3** — kills the transparent-PowerPoint pain |
| 4 — YouTube OAuth + broadcast lifecycle | Phase 1 · §5 | **#2** groundwork |
| 5 — GO LIVE / END + auto-record | Phase 1 · §5 | **#2** — one-click live |
| 6 — Service Plan + editor + PPT import | Phase 3 · §7 | **#1** groundwork; manual slide/media driver |
| 7 — Pluggable ASR (Deepgram + Whisper) | Phase 2 · §4, §8 | **#1/#2** — the "ears" |
| 8 — Cue engine + scripture + trust dial | Phase 2→3 · §4 | **#1** — safe auto-following |
| 9 — Resilience & safeguards | (cross-cutting) · §9 | Trustworthy for live, un-repeatable events |
| 10 — Polish, monitoring, packaging, e2e | Phase 4 · §10-12 | Ship it |

All three blueprint problems (#1 slide/video following, #2 going live, #3 lower-thirds+cameras), all three detectors (scripture, hot-phrase, plan-follower), the trust dial, every failure-mode row in §9, and every Phase 0–4 milestone are covered.

## A few senior notes

- **The order front-loads relief and back-loads risk** — exactly as the blueprint asks. After Prompt 3 you already have a calmer service (manual, decoupled). After Prompt 5 the many-clicks pain is gone. The hard AI (Prompts 7–8) only lands once a reliable manual system exists underneath it as the fallback.
- **Prompts 4–5 and 7 are the ones that need accounts/keys.** Do the `HUMAN_TASKS.md` items for those before (or right as) you run them, or they'll finish in "not configured" mode — which is fine and green, just not live.
- **Keep each session scoped to one prompt.** v2 learned the hard way that letting an agent roam the whole project causes drift; narrow scope + verify-green each phase is why its 20-phase build held together.
- **Don't let scope creep back in.** v2's plugin SDK, DMX lighting, PTZ camera AI, multi-campus, biometrics, and native compositor are all *out* of this blueprint on purpose. If one seems tempting, it's a post-1.0 extension, not a Phase 0–4 requirement.
