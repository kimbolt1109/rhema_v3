# Verger (rhema_v3) — build governance

Verger is a **one-operator live-service production control app**: an Electron desktop app that
drives OBS Studio, YouTube Live, an independent overlay layer, and an ASR-fed cue engine.

This file governs how work is done in this repo. It is adapted from `rhema_v2/CLAUDE.md`.

---

## The immutable contract

- **`BLUEPRINT.md` is the single immutable source of truth.** Never edit it. It defines "done".
- **`verger_build_prompts.md`** is the agreed 10-phase decomposition of the blueprint. Also immutable.
- **`STATUS.md`** is the running log. Append one cycle entry per completed phase.
- **`HUMAN_TASKS.md`** is the escalation list for anything only a human can do (accounts, keys,
  certs, legal calls, hardware).
- **`docs/v2-notes/`** is distilled knowledge mined from the prior `rhema_v2` project. Treat it as
  reference, not as gospel — `BLUEPRINT.md` wins on any conflict.
- Any other file may be created or modified to satisfy the blueprint.

---

## Standing rules (every phase obeys these)

1. **Human always wins.** Every automated action is overridable in one tap. Assist mode is the
   default; auto-fire is opt-in per cue. Design for veto, not trust.
2. **OBS is the resilient engine; this app is a convenience layer.** If the app crashes, OBS keeps
   streaming and recording. On relaunch the app *reconnects to OBS's current state* — it never
   assumes it owns that state.
3. **Always-on local recording.** Whenever streaming starts, OBS local recording starts too.
   Never optional.
4. **Never output bulk copyrighted text.** No agent may emit Bible verse text, whole Bibles, or
   song lyrics into code or fixtures. Bundle only *verified public-domain* data loaded from files;
   fetch copyrighted translations live from a licensed API (ESV / API.Bible) with attribution.
   See `docs/v2-notes/LEGAL_AND_CONTENT.md`.
5. **Secrets live in `.env` (gitignored); mirror every key name into `.env.example` with an empty
   value.** An empty value means "run this subsystem in degraded/not-configured mode", never crash.
6. **Destructive/high-stakes actions require a deliberate hold, not a tap.** "Take over from AI"
   is one safe action away and must never blank the congregation screen.
7. **Loopback-first networking.** Bind servers to `127.0.0.1` by default; LAN exposure is an
   explicit opt-in with a concrete IP.
8. **End every phase green.** `npm run build` + `tsc --noEmit` clean, `vitest run` passing, the
   phase's own acceptance checklist satisfied, a `STATUS.md` cycle entry appended, and a commit
   pushed to `origin/main`.

---

## Phase loop

For each of the 10 prompts in `verger_build_prompts.md`, in order:

1. **Read** `BLUEPRINT.md` + the phase prompt + the `docs/v2-notes/` files it names.
2. **Delta** — itemize the concrete gaps between current tree and the phase's DONE-WHEN.
3. **Dispatch** — implement, splitting independent modules across parallel agents scoped to
   **disjoint file sets**. Never let two agents write the same file.
4. **Integrate & verify** — `tsc --noEmit`, `npm run build`, `vitest run`. Fix until green.
5. **Log** — append a `## Cycle N — Phase M` entry to `STATUS.md`; add any human-only blockers to
   `HUMAN_TASKS.md`.
6. **Ship** — commit and push to `origin/main`.

Never block on a human. If a phase needs a key, an account, or a cert, stub it behind config so
the subsystem reports "not configured", write the ask to `HUMAN_TASKS.md`, and continue.

---

## Architecture invariants

- **Layers are independent.** Camera, lower-third, scripture, and slide are separate layers.
  Changing one never disturbs another. A camera switch must not touch overlay state, and showing
  an overlay must not touch the camera. This is asserted by tests, not by convention.
- **One typed message protocol** shared between main process, renderer, and the overlay pages.
- **The overlay server caches last-known state per layer** and re-sends on overlay reconnect.
- **`contextIsolation: true`, no `nodeIntegration`** in the renderer. All privileged work happens
  in the main process behind a typed `preload` IPC bridge.
- **Untrusted input (PPTX, media) is parsed in a child process**, never in the main process.

---

## Out of scope (do not reintroduce)

v2's plugin SDK, DMX lighting, PTZ camera AI, multi-campus sync, biometrics, and the native Rust
compositor are all deliberately **out**. They are post-1.0 extensions, not Phase 0–4 requirements.
