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

---

## Resolved

_(none yet)_
