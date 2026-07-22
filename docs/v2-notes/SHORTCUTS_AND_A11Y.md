# Keyboard Shortcuts, PANIC/ESC Safety UX & Accessibility — mined from rhema_v2

> Sources read in full: `C:\Side projects\rhema_v2\docs\SHORTCUTS.md`, `C:\Side projects\rhema_v2\docs\ACCESSIBILITY.md`
> Sources grepped for supporting context: `C:\Side projects\rhema_v2\Rhema_Blueprint_v3.4.md` (PART 13.3, PART 17.2/17.3/17.4/17.8/17.9/17.19/17.21), `C:\Side projects\rhema_v2\PROBLEMS.md`, `C:\Side projects\rhema_v2\docs\GETTING_STARTED.md`, `C:\Side projects\rhema_v2\docs\API.md`, `C:\Side projects\rhema_v2\docs\adr\ADR-001B-tauri-runtime.md`, `C:\Side projects\rhema_v2\RHEMA_STATE.md`, `C:\Side projects\rhema_v2\PLAN.md`

This is the SPEC for Verger Prompts 3, 9 and 10 (core production keyboard model, PANIC/ESC safety
semantics, and operator-UI accessibility). rhema_v2 itself went through a **documented regression and
fix** on this exact subsystem — read the "What went wrong in v2" section before implementing; it is the
single most load-bearing lesson in this note.

---

## 1. Complete keyboard map (verbatim from `docs/SHORTCUTS.md`)

All shortcuts are active during service playback and are (mostly) remappable in Settings.

### Core production shortcuts

| Key | Action | Notes |
|-----|--------|-------|
| **SPACE (tap, <300ms)** | Advance slide | — |
| **SPACE (hold >3000ms)** | PANIC | Emergency stop; halts all AI but keeps stream/recording live |
| **B** | Black screen | Mutes all video outputs; sermon audio continues |
| **L** | Logo/branding screen | Shows configured logo slide |
| **F** | Freeze | Holds current slide; disables auto-advance |
| **ESC (hold 2000ms)** | Disable AI automation | Hands control to the operator. **Non-destructive** — whatever is currently live stays live; only AI automation stops. A quick tap does nothing. |
| **SHIFT+ESC** | Dismiss lower thirds | Removes all OverlayForge overlays *only* |
| **"Clear All" button (hold 2000ms, on-screen only, NOT a keyboard shortcut)** | Clear all overlays/output | Deliberately positioned far from Go Live |

### AI recommendation shortcuts (only active while a recommendation is pending — banner/highlight shown)

| Key | Action | Precondition |
|-----|--------|-------------|
| **Y** | Confirm recommendation | Slide recommendation or Bible reference pending |
| **N** | Dismiss recommendation | Slide recommendation or Bible reference pending |

**Priority rule:** if both a SlideMind slide recommendation and a Bible-reference recommendation are
pending simultaneously, Y/N act on the **slide recommendation** (not the Bible reference).

### Operator recovery

| Key | Action | When to use |
|-----|--------|-------------|
| **CTRL+D** | Recover last checkpoint | RHEMA crashed or state got corrupted; rewinds **~10 seconds of AI state** |

(`docs/GETTING_STARTED.md` clarifies scope: CTRL+D "recovers from the last safe checkpoint (rewinds ~10
seconds of AI state)" — it is an AI-state rewind, not a full app/undo history. On an actual app crash the
guidance is "Relaunch the app — it auto-recovers the last service state" as the primary path; CTRL+D is
for in-session state corruption while the app is still running.)

### Un-panicking

Not a distinct key — same gesture, run again: **SPACE (hold 3s) a second time** re-enables AI and resumes
normal operation. Per `GETTING_STARTED.md`: "All AI systems (cameras, lighting, captions) return to their
previous state" and "Live stream and sermon recording continue uninterrupted (PANIC never cuts video)."

---

## 2. Hold-vs-tap timing thresholds (exact numbers)

| Gesture | Threshold | Action triggered |
|---|---|---|
| SPACE tap | **< 300ms** | Advance slide |
| SPACE hold | **> 3000ms** (3s) | PANIC |
| ESC hold | **2000ms** (2s) | Disable AI automation (non-destructive) |
| "Clear All" button hold | **2000ms** (2s) | Clear all overlays/output (destructive) |
| Test methodology (blueprint KAHNEMAN-2 test row) | button press **< 2s must NOT trigger** Clear All | automated test assertion |

`KAHNEMAN-2` blueprint rule generalizes this: "Any action that is irreversible or high-stakes … MUST
require a deliberate 2-step confirmation that cannot be completed in **< 1.5 seconds**." The concrete
implementation used a round 2000ms hold, comfortably above that floor.

There is a documented escape hatch for nervous operators: SPACE can be remapped in Settings, and the
docs suggest using a **chord** (e.g. SHIFT+SPACE) instead of a bare hold if accidental PANIC is a worry.

---

## 3. "Holds, not taps" safety UX reasoning — verbatim

From `docs/SHORTCUTS.md`, section "Why ESC no longer clears the output" (cites Blueprint PART 17,
BAINBRIDGE-4 and KAHNEMAN-2):

> - **Manual takeover must be one action away, and safe.** The keyboard shortcut for "I need to take over
>   from the AI right now" (ESC) must never carry a side effect that could blank the congregation's
>   screen. Holding ESC for 2 seconds disables AI automation only — the output is untouched.
> - **Destructive actions require deliberate System 2 engagement.** Clearing the live output is
>   high-stakes and hard to undo cleanly mid-service, so it now requires a 2-second **hold** on a
>   dedicated on-screen "Clear All" button, positioned far from Go Live so a slip of the hand can't
>   trigger it. Holds (not taps, not double-clicks) force conscious, deliberate action under stress.

From the Blueprint itself (`Rhema_Blueprint_v3.4.md`), the two named psychology rules in full:

> **BAINBRIDGE-4 — Manual mode is always one action away:** The physical keyboard shortcut to disable
> all AI automation and take full manual control MUST be documented on a card attached to the keyboard.
> Rhema MUST suggest printing this card during first-run setup. The shortcut: `ESC` (hold 2 seconds).
> **ESC is non-destructive: it hands control to the human and freezes AI, but it does NOT clear or blank
> the output** (that is the separate, deliberately-distant "Clear All" 2-second hold, KAHNEMAN-2). This
> separation is intentional — a panicked operator who wants to "take over" must never accidentally black
> out the congregation's screen. Whatever is currently live stays live when ESC is pressed; only the
> automation stops.
>
> **Test:** Simulate AI failure during a 30-minute simulated service. Measure: (1) time to operator
> awareness, (2) time to manual takeover, (3) error rate in first 5 manual slide advances after
> takeover. Target: awareness < 3s, takeover < 10s, first-5-manual-advances error rate < 20%.

> **KAHNEMAN-2 — Error-prone actions MUST require System 2:** Any action that is irreversible or
> high-stakes (delete service, revoke all sessions, clear all outputs) MUST require a deliberate 2-step
> confirmation that cannot be completed in < 1.5 seconds. This time constraint forces System 2
> engagement. Example: "Clear All" requires holding the button for 2 seconds (not just a double-click —
> a hold. Holds cannot be triggered by System 1 muscle-memory.)

Also relevant — **FITTS-3** (why Clear All is physically far away, and why the AI-disable action is a
keyboard shortcut rather than a screen button at all):

> **FITTS-3 — Destructive actions MUST be far from primary actions:** "Clear All" MUST NOT be adjacent
> to "Go Live." Distance is a safety feature — the high ID of a distant button gives System 2 time to
> recognize and abort an error. The "emergency exit" (ESC to disable all AI) MUST be accessible from the
> keyboard, not a screen target, because keyboard shortcuts have zero Fitts' cost (MT approaches 0 for
> well-learned key combinations).

---

## 4. PANIC semantics — the critical invariant

**PANIC never cuts video and never blanks the congregation screen.** This is stated repeatedly and
independently across the v2 corpus:

- `docs/SHORTCUTS.md`: "PANIC | Emergency stop; halts all AI but **keeps stream/recording live**"
- `docs/API.md`: "`panic` — Emergency stop — halts all AI systems but keeps stream/recording live."
- `docs/GETTING_STARTED.md`: "**Live stream and sermon recording continue uninterrupted (PANIC never
  cuts video).**"
- Blueprint cross-cutting invariant (`PLAN.md`): "Render thread sacred (never panics, re-serves last
  frame)."
- Blueprint chaos-testing requirement (PART 13.4): kill the output renderer, kill each worker, sever the
  network, yank a display, time out a camera — and assert "**the congregation output never goes black
  unrecoverably**."

What PANIC *does* do (from the Deadman-switch design, Phase 19 in `RHEMA_STATE.md`/`PLAN.md`): sets a
`panic_mode` flag, aborts all registered AI-module abort-handles (STT/SlideMind/OverlayForge/
CameraDirector), fires emergency DMX **white** (house-lights-up style safety lighting), stops camera
PTZ tracking (camera holds position), and emits `PanicActivated` + `ManualModeEngaged` events. The
*intended* render-side behavior is a frame-swap to a logo/last-slide (not black) — v2 shipped this as a
deferred gap ("emergency wgpu texture swap on PANIC is deferred... needs a wired frame source"), i.e. the
mechanism existed but the final swap-to-safe-frame wiring was incomplete. **Verger should not repeat this
gap: wire the PANIC→safe-frame swap as part of the initial implementation, not as a follow-up.**

Un-panic is symmetric: hold SPACE 3s again → AI modules restore to previous state, stream/recording were
never interrupted.

Distinguish PANIC from ESC-hold clearly — they are **different mechanisms with different scope**:
- **ESC (hold 2s)** = light hand-back-control. Stops AI automation only. Nothing about video/output/DMX
  changes. This is the "I want to drive manually for a bit" gesture.
- **PANIC (SPACE hold 3s)** = heavier, full emergency-stop mechanism. Stops AI, forces safety lighting,
  stops camera motion, but *still* never touches stream/recording and (by design intent) never blacks the
  program output.

---

## 5. SHIFT+ESC and the separate held "Clear All"

- **SHIFT+ESC** — a distinct chord from plain ESC. Removes **all OverlayForge overlays only** (lower
  thirds / bugs). Does not touch AI automation state, does not touch the main slide/video output.
- **"Clear All"** — on-screen button, **not a keyboard shortcut at all**, requires a **2-second hold**,
  deliberately placed far from Go Live (Fitts'-Law distance-as-safety-feature, FITTS-3). This is the
  *only* control in the map that clears the live output, and it is the most deliberately hard-to-trigger
  control in the system by design.

---

## 6. What went wrong in v2 — read this before implementing

`PROBLEMS.md` (dated 2026-07-02, an audit of the **shipped v2 code** against the blueprint) documents
that the actual implementation at that time **violated** BAINBRIDGE-4/KAHNEMAN-2/FITTS-3 outright:

> **86. (H) [implementation] ESC semantics wrong (BAINBRIDGE-4/KAHNEMAN-2/FITTS-3):** plain ESC
> instantly clears overlays (destructive); no 2s-hold ESC "disable AI, output stays live"; no separate
> 2s-hold Clear All. SPACE-3s-hold PANIC is a different mechanism, and PANIC is a full-screen takeover
> rather than the light hand-back-control behavior.

> **105. (M) [docs] docs/SHORTCUTS.md documents blueprint-violating behavior** (ESC = clear overlays;
> SPACE-hold = PANIC) — doc matches code, both diverge from PART 17.

**The `docs/SHORTCUTS.md` and `docs/ACCESSIBILITY.md` files mined for this note are dated *after* that
audit** (SHORTCUTS.md: Jul 3 01:14, vs. PROBLEMS.md audit: Jul 2 23:45) and already reflect the
**corrected**, blueprint-compliant design described above (2s-hold ESC that is non-destructive; separate
2s-hold Clear All). In other words: **the design in this note is the fix, not the bug** — but the bug
happened once already, and it happened specifically because a plain single-tap ESC was overloaded to mean
both "take over" and "clear the screen." Verger's implementation must keep those two concerns on
physically/temporally separate triggers from day one — don't let them re-merge under refactoring
pressure.

Lesson generalized: **any gesture that both (a) hands control to a human under stress and (b) could be
read as "clear/destroy something" is a latent incident waiting to happen.** Keep hand-back-control
non-destructive, always.

---

## 7. Remappability rules

From `docs/SHORTCUTS.md`, "Customizing Shortcuts":

1. Open RHEMA Settings (gear icon, top-right) → Appearance → Keyboard Shortcuts.
2. Click any shortcut to rebind it, press the desired key combo, confirm.
3. **Restart RHEMA for changes to take effect** (rebinding is not hot-applied).

**Remapping restrictions:**
- **Production shortcuts** (SPACE, B, L, F, ESC) **cannot be unbound** — only remapped to a different
  key. There is always *some* key bound to each of these.
- **Y/N** for AI confirmations are **not remappable at all** ("prevent accidental rebinding during a live
  service").
- Documented caution (not enforced programmatically per the doc): avoid rebinding keys that collide with
  your slide software or streaming encoder's own shortcuts.

**Context suppression:** shortcuts are globally **disabled while a text field has focus** (Settings
search, speaker-name entry, caption edit, etc.) — this is the guard against accidental slide-advance or
PANIC while typing.

---

## 8. Foot pedal / Stream Deck / HID considerations

No dedicated "foot pedal" documentation exists anywhere in the mined v2 corpus — grepped case-insensitive
across the entire `rhema_v2` tree for `pedal`/`footswitch`, zero matches. **Do not invent foot-pedal
behavior; if Verger needs it, treat it as new design, informed by the Stream Deck pattern below (a pedal
that emulates keyboard keys behaves identically to keyboard-HID for free).**

Stream Deck integration, however, is well specified (Blueprint PART 12.4 + `docs/API.md` +
`docs/GETTING_STARTED.md`), and is instructive as the template for any future physical-control-surface
(including a pedal, if it's implemented as either literal keyboard-HID emulation or the same REST calls):

- SDK: Stream Deck Plugin SDK (TypeScript). Plugin id: `com.syncsanctuary.rhema.sdPlugin`.
- Actions exposed: `slide:next`, `slide:prev`, `slide:clear`, `macro:fire`, `cam:preset`, `dmx:scene:fire`,
  `stream:start`, `ai:mode`, `look:set` (blueprint spec) — `docs/GETTING_STARTED.md` also lists Slide
  Advance / **PANIC** / Lighting Scene / Lower Third as installable actions.
- Transport: plugin talks **WebSocket → calls the Rhema REST API** at `localhost:7321` (blueprint spec),
  "subject to the same Host/Origin/token rules as any other client" (PART 5.1) — i.e. it is NOT literal
  keyboard-HID key injection; it's an authenticated network client hitting REST/WS endpoints.
- Pairing: scan a QR code (RHEMA Settings → Security → Remote Control) which **mints a one-time token,
  not a long-lived JWT**.
- **Port drift gotcha:** the blueprint's canonical ports are **WS 7320 / REST 7321**, and Stream Deck
  targets 7321 specifically. `PROBLEMS.md` #104 records that the actual shipped v2 code **diverged to
  8420/3001/8765/3002** and that the bespoke `stream-deck-plugin/` in the repo targets the wrong
  (non-blueprint) WS port. **When Verger implements a control-surface API, pick the port once, document
  it in one place, and don't let code and docs drift independently — that's exactly the failure mode
  recorded here.**
- Related MIDI note (PART 13.2 hardware-in-loop test list): "MIDI: Elgato Stream Deck, Ableton Live (MTC
  source). Test: macro fire on Note On, slide advance on CC" — i.e. v2 also explored a MIDI-message path
  (Note On / CC) as an alternative trigger source, separate from the WebSocket/REST path above.
- Spatial-memory design rule for a physical macro panel (Blueprint HICK-4, worth carrying to any future
  Verger control-surface / Stream-Deck-style panel): "The 8-macro quick-trigger panel... uses only icons
  + color, **no text labels**. After 3 services, the operator has mapped positions to actions spatially
  (System 1, automatic)."

Also relevant to any hardware trigger surface: the double-tap pattern mentioned in `PLAN.md` Phase 17 —
"director/PANIC publish the dedicated `DirectorModeToggled`/`PanicActivated` events" and the
`stream-deck-plugin` scaffold shipped "10 actions + **double-tap PANIC**" — i.e. the Stream-Deck-side
PANIC trigger used a double-tap gesture (distinct from the 3-second SPACE-hold used on the physical
keyboard), presumably because a physical Stream Deck button doesn't have the same accidental-activation
risk profile as a keyboard held under an operator's resting hand. **Open question for Verger, not
resolved in the source:** whether double-tap is an adequately safe gesture for a destructive-adjacent
action per KAHNEMAN-2's "cannot complete in <1.5s" rule — a double-tap can be faster than 1.5s. Flag this
as a design decision to make explicitly rather than copy uncritically.

---

## 9. Accessibility requirements (WCAG 2.1 AA, operator UI only)

Scope: **only the operator interface** targets WCAG 2.1 AA. The **congregation output is explicitly
exempt** — "it's designed content" (Blueprint PART 13.3): "Congregation output is not bound by
operator-UI a11y... but the captioning feature (PART 7.3) is the accessibility deliverable for the
audience and carries its own non-ADA-guarantee marker (ADR-015)." Addresses `PROBLEMS.md` **#99** and
Blueprint **PART 13.3 / PART 17.19**.

### 9.1 Automated testing

- `jest-axe` (dev dependency) runs inside the **vitest** harness.
- `src/test/a11y.test.tsx` renders the highest-traffic interactive surfaces and asserts **zero axe
  violations**, plus targeted checks:
  - **Sidebar** — no violations; every icon-only rail button exposes an accessible name (`aria-label`).
  - **TopBar** — no violations.
  - **StatusBar** — no violations.
  - **CommandPalette (open)** — labelled `role="dialog"` + `aria-modal="true"` + a labelled search
    `textbox`.
- Run command: `npx vitest run` (or `npm run test:run`).

### 9.2 ARIA / keyboard / focus patterns actually implemented

- **Icon-only buttons have accessible names.** Sidebar rail buttons, the "More" flyout button
  (`aria-haspopup="menu"`, `aria-expanded`), the brand button, and the PANIC inline-confirm close (X)
  button all carry `aria-label`.
- **Redundant `alt` removed** (axe rule `image-redundant-alt`): logo images that sit beside/inside an
  already-named control (wordmark text or button `aria-label`) use `alt=""` (decorative) so the screen
  reader doesn't double-announce ("RHEMA RHEMA").
- **Form inputs have labels.** Wizard's screen-role/audio-device `<select>`s and the Settings
  interface-language `<select>` have `aria-label`s; other wizard fields use wrapping `<label>` elements.
  The PANIC confirm text input has an `aria-label`.
- **Command palette keyboard pattern:** Arrow Up/Down cycle results, Enter selects, Escape closes, Tab is
  **trapped** to the input (focus trap). Dialog role `role="dialog" aria-modal="true"` with an accessible
  name; **focus moves to the search field on open**. Escape is handled at the **dialog root** so it works
  regardless of which child currently holds focus — a reusable pattern for any modal.
- **Modals trap focus + are escapable.** Command palette and the Sidebar "More" flyout both close on
  Escape.
- **`prefers-reduced-motion`** is honored globally in `index.css` (already wired, not per-component).

### 9.3 Contrast audit (exact numbers)

Rule set: **ERGO-2** = 7:1 minimum for primary text (WCAG AAA, not just AA); status indicators only need
3:1 (WCAG AA). **ERGO-4** = no pure white anywhere. **ERGO-1** = dark mode is the *only* mode (no light
mode — "ergonomic requirement for the production environment," not a preference; a minimal
setup/configuration-only light theme was floated as a possible V2 feature but never for live operation).

Measured with the WCAG 2.1 relative-luminance formula against the dark-only token palette in
`src/index.css` (`:root`):

| Foreground | Background | Ratio | Verdict |
|-----------|-----------|-------|---------|
| text `#e5e7eb` | bg `#0a0a0f` | **15.95:1** | AAA (≥7:1) |
| text `#e5e7eb` | surface `#12121a` | **15.05:1** | AAA |
| text `#e5e7eb` | surface-2 `#1a1a26` | **13.91:1** | AAA |
| muted `#9ca3af` | bg `#0a0a0f` | **7.78:1** | AAA |
| muted `#9ca3af` | surface `#12121a` | **7.34:1** | AAA |
| muted `#9ca3af` | surface-2 `#1a1a26` | 6.78:1 | AA (just under 7:1) |
| accent `#6366f1` | bg `#0a0a0f` | 4.42:1 | AA-large (3:1) |
| accent `#6366f1` | surface `#12121a` | 4.17:1 | AA-large (3:1) |
| live `#22c55e` | surface `#12121a` | **8.18:1** | AAA |

Findings/rules to carry forward:
- Primary text (off-white `#e5e7eb`, never pure white) clears 7:1 everywhere, comfortably — no pure white
  anywhere satisfies ERGO-4.
- Muted/secondary text is ≥7:1 on `bg`/`surface`, 6.78:1 on the darkest card surface (`surface-2`) — above
  the 4.5:1 AA floor and the 3:1 status floor, just under AAA on that one surface; judged acceptable
  since it's secondary text only. (Nudging `--color-text-muted` one step lighter would close this fully.)
- **Accent-as-text** (`#6366f1`, ~4.2:1) is below both 7:1 and the 4.5:1 normal-text AA floor. Accent is
  reserved for **emphasis / active-state / interactive affordances**, which per PART 17.4/17.21 must pair
  with shape/position/underline — **color is never the sole signal**. Status indicators only need 3:1, so
  accent is fine there. Rule: **never use accent color alone for body paragraph text**; where an
  accent-colored label must read as normal body text, use the lighter `--color-accent-2` (`#818cf8`) or
  pair it with an icon.

### 9.4 Target size / hit-area rules (Fitts'-Law-derived, from the Blueprint, enforced as a11y baseline too)

- **FITTS-1:** primary action buttons minimum **48×48px at 96dpi** (~12mm, Material Design minimum). Go
  Live and Clear buttons specifically **must be ≥64×64px** (more finger surface = lower error rate under
  stress). v2 shipped a violation of this caught in `PROBLEMS.md` #87: PTZ hold-buttons were **28×28px**
  (`h-7 w-7` in `PtzControls.tsx`) against the 48×48 minimum — a concrete "don't do this" example.
  GESTALT-2 pairs with this: all clickable thumbnails (slide/camera-preset/DMX-scene) use uniform
  **64×64px** container + **6px** corner radius + consistent hover/active states so shape alone signals
  "tappable."
- **FITTS-2:** the advance-slide → go-live → advance-slide loop's controls must be screen-adjacent (not
  split top/bottom) since this sequence repeats every 2–5 minutes for the whole service.
- **FITTS-4:** after a manual AI-override correction, the next "accept AI suggestion" target should
  temporarily enlarge for ~10 seconds (elevated-attention window).

### 9.5 Focus management, dialogs, and color-only-signal rule

- Focus-visible ring: **not yet fully standardized** across custom buttons as of this doc — "most use
  `focus:ring`/`focus:outline`; standardize any stragglers found during the page-by-page pass" (open
  item, not resolved in v2).
- Full keyboard sweep of every page (Cameras/Lighting/Audio/etc.) is **not exhaustive** in v2 — only the
  core operator loop (Sidebar/TopBar/StatusBar/CommandPalette) was hardened and covered by
  `a11y.test.tsx`. Treat this as a checklist gap to close completely in Verger rather than partially, as
  v2 did.
- **Color-only signals:** StatusBar uses tone dots **+ text values**, not color alone — compliant pattern
  to replicate everywhere status is shown.
- No `aria-live` / screen-reader-announcement regions or patterns are documented anywhere in the mined
  a11y doc or grepped blueprint sections — **this is a gap in v2's own documentation, not something to
  port forward as "done."** Verger will need to design live-region announcements (e.g. for AI
  recommendation banners, PANIC state changes, checkpoint recovery) from scratch; nothing to mine here
  beyond "it wasn't specified."

---

## Verger application notes

The Tauri/Rust engine is not being ported; everything below assumes a fresh Electron/TypeScript UI layer.

1. **Port the safety-UX state machine, not the code.** The load-bearing artifact here is the *rule*, not
   any Rust/React implementation: (a) hand-back-control is always non-destructive and always a bare
   keyboard hold (no screen target, per FITTS-3); (b) anything destructive requires a **held**, physically
   or temporally separated control that cannot complete in under ~1.5–2s; (c) PANIC/emergency-stop must
   never touch the video/stream/recording pipeline — build this as an explicit architectural boundary
   (e.g. the "safe frame swap" and "stop AI" code paths must not share a dependency with the "stop
   encoder/stop stream" code path) so it's structurally impossible to regress into the exact bug recorded
   in `PROBLEMS.md` #86/#105.
2. **Wire the PANIC→safe-frame swap up front.** v2 left this as a deferred gap (flags/events fired
   correctly, but the actual render-thread swap to logo/last-slide was never wired). In an Electron
   rebuild this likely means: on PANIC, the renderer/output window swaps its active layer source to a
   cached last-good frame or a static logo image — implement and test this in the same PR that implements
   the PANIC flag, not later.
3. **Decide the Stream Deck / pedal transport before building it, and pick one port.** v2's canonical
   design (WS 7320 / REST 7321, network client with QR-paired one-time token) is sound and reusable in
   Electron. v2's actual failure was letting the shipped code (8420/3001/8765/3002) and the docs diverge
   from each other and from the blueprint. For any Electron control-surface (Stream Deck plugin, and a
   pedal if built), pick the port/contract once, and add a CI check that docs and code agree — don't rely
   on memory.
4. **Resolve the double-tap-PANIC-vs-KAHNEMAN-2 tension explicitly.** v2's Stream Deck plugin scaffold
   used double-tap for PANIC while the keyboard used a 3-second hold; a double-tap can complete in well
   under the 1.5s System-2 threshold the blueprint itself sets for irreversible actions. Verger should
   pick a single deliberate answer (e.g. hold-to-fire on Stream Deck too) rather than inherit this
   inconsistency unexamined.
5. **No foot-pedal design exists to mine.** If Verger needs pedal support, model it as a HID device that
   emits the same key codes as the physical keyboard shortcuts above (SPACE/ESC/etc.) so the existing
   tap/hold state machine handles it for free — do not build a parallel gesture system for pedals.
6. **Accessibility: keep the operator-UI-only scope, and close v2's specific known gaps immediately
   instead of leaving them as backlog.** Concretely: (a) do a full per-page a11y sweep (Cameras/Lighting/
   Audio/etc.) instead of just the core loop; (b) standardize one focus-visible ring pattern from the
   start; (c) explicitly design `aria-live` announcement regions for AI-recommendation banners, PANIC
   state transitions, and CTRL+D checkpoint recovery — v2 never specified these; (d) keep primary text at
   ≥7:1 and never use pure white (carry the exact token ratios above as a starting palette, or re-derive
   equivalents for Verger's new palette and re-run the same relative-luminance audit); (e) never use
   accent color alone for body text; (f) keep the 48×48 / 64×64 Fitts'-Law hit-area minimums and treat any
   sub-48px interactive control (like v2's 28×28 PTZ buttons) as a bug, not a style choice.
7. **CTRL+D checkpoint recovery is an AI-state rewind (~10s), not a full undo system.** Scope Verger's
   equivalent the same way — cheap, small, in-session AI-state snapshot/restore — rather than building a
   general undo/redo framework unless separately justified.
8. **Y/N and the five production keys (SPACE/B/L/F/ESC) being non-remappable/always-bound is a
   deliberate safety property, not an oversight.** Preserve "cannot be unbound, only rebound to a
   different key" for the production five, and "not remappable at all" for Y/N, in Verger's settings UI.
