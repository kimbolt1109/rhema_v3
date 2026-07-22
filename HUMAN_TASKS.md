# Verger (rhema_v3) — human tasks

Everything here needs a human: an account, a key, a purchase, a legal call, or physical hardware.
The build never blocks on these — the affected subsystem ships in "not configured" mode (per
Standing Rule 5) and this list records the exact steps to light it up.

Format: `- [ ] [TYPE] task — why it blocks, exact resolution steps.`
Types: `[SETUP]` `[ACCOUNT]` `[KEY]` `[LEGAL]` `[HARDWARE]` `[DECISION]` `[PURCHASE]`

---

## Open

- [ ] [SETUP] **Install OBS Studio 30+ and enable its WebSocket server.**
  Blocks: every OBS-driven feature (Phases 1, 3, 5, 9). Without it the app runs but shows
  "Down" on the Connection screen.
  Steps: install OBS Studio 30 or newer → `Tools → WebSocket Server Settings` → tick
  *Enable WebSocket server*, note the port (default `4455`) and click *Show Connect Info* to copy
  the password → put them in `.env` as `OBS_WEBSOCKET_URL=ws://127.0.0.1:4455` and
  `OBS_WEBSOCKET_PASSWORD=<password>`.

- [ ] [DECISION] **Real brand art.** `rhema_v2/brand/logo.png` is a 0-byte placeholder, so there
  is no logo to inherit. Blocks: app icon, installer branding, the overlay logo layer (Phase 10).
  Steps: supply a square PNG at 1024×1024 (app icon source) and a transparent SVG/PNG wordmark
  for the lower-third and logo-slate overlays. Drop them in `brand/`.

- [ ] [SETUP] **Install LibreOffice** (needed by Phase 6, PowerPoint import).
  Blocks: converting a `.pptx` into per-slide images. Not installed — checked both
  `C:\Program Files\LibreOffice` and `C:\Program Files (x86)\LibreOffice`.
  Steps: install LibreOffice, then confirm `soffice.exe --headless --convert-to png` runs.
  Phase 6 will stub the converter behind config and report "not configured" if it is absent.

- [ ] [HARDWARE] **Confirm the local-ASR plan for Phase 7.** This machine has an
  **NVIDIA GeForce GTX 1650 with 4 GB VRAM** and **Python 3.14.6**. Two problems:
  4 GB will not comfortably hold `large-v3`, so the local tier realistically tops out around
  `small`; and `faster-whisper`/`ctranslate2` may not yet publish wheels for Python 3.14.
  Steps: decide whether to (a) accept a smaller local model, (b) install a second Python
  (3.11/3.12) for the ASR sidecar, or (c) rely on cloud Deepgram and treat local as
  best-effort. Phase 7 ships the pluggable interface regardless.

---

## Notes

- The out-of-repo resource pool `C:\ClaudeFlow\projects\rhema\resources\` **exists** and is
  reusable: `bin/win/ffmpeg.exe`, `models/` (ONNX Whisper encoder/decoder, `lid.176.bin`), and
  `bibles/catalog.json` — a curated **public-domain-only** translation catalogue (KJV, ASV,
  WEB, BSB…) with per-entry licence, attribution and pinned source URL. That catalogue is the
  right model for Phase 8's verse resolution: public-domain data downloaded at runtime, never
  committed, with copyrighted translations left to a licensed API.

---

## Resolved

_(none yet)_
