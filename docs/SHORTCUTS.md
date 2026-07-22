# Keyboard Shortcuts — Verger

**Print this page and tape it to the booth keyboard.** `docs/v2-notes/SHORTCUTS_AND_A11Y.md` records
the blueprint rule BAINBRIDGE-4: *"the physical keyboard shortcut to disable all AI automation and
take full manual control MUST be documented on a card attached to the keyboard."* This is that card.

> **Source of truth.** Every key, gesture and millisecond below is read from
> [`src/shared/actions.ts`](../src/shared/actions.ts) — `DEFAULT_KEY_BINDINGS` and the exported
> threshold constants. If this page and that file ever disagree, the file is right and this page is
> a bug. They change in one commit, not two.
>
> **Status:** the bindings and thresholds are the shipped Phase-3 defaults. Remapping is Phase 10 —
> today the table below is fixed.

---

## The one thing to remember

**Hold ESC for 2 seconds to take over.** Nothing on screen changes. The AI stops, you drive.

That is the whole emergency procedure. It is safe to do at any moment, in front of anyone, for any
reason. It cannot blank the congregation's screen, cannot stop the stream, and cannot lose the
recording. If you are unsure what is happening — hold ESC.

---

## 1. The map

Gesture column reads: **tap** = press and release inside 300 ms. **hold** = keep the key down; the
action fires *while you are still holding*, at the stated duration, so you get the feedback at the
moment of commitment rather than on release.

### Core production

| Key | Gesture | Action | Destructive? |
|---|---|---|---|
| **SPACE** | tap (< 300 ms) | Advance to the next cue/slide | No |
| **SPACE** | **hold 3000 ms** | **PANIC** — halt all automation | No — see §3 |
| **ESC** | **hold 2000 ms** | **Disable AI automation** — hand control back to you | **No — see §2** |
| **SHIFT + ESC** | tap | Dismiss the lower-third **only** | No |
| **BACKSPACE** | tap | Step back one cue — the undo for a mis-fire | No |
| **B** | **hold 1500 ms** | Cut program output to **black** | **YES** |
| **L** | tap | Show the logo / holding slate | No |
| **F** | tap | Freeze the current frame | No |

### Cameras

| Key | Gesture | Action | Destructive? |
|---|---|---|---|
| **1** | tap | Switch program to **CAM 1** | No |
| **2** | tap | Switch program to **CAM 2** | No |
| **3** | tap | Switch program to **WIDE** | No |
| **4** | tap | Switch program to **PULPIT** | No |

A camera key does nothing at all if that button has no OBS scene mapped to it yet. The on-screen
button is disabled and says why; the key does not fire a request for a scene that does not exist.
Map the four buttons to scenes in **Settings → Cameras**.

**Switching cameras never touches the lower-third.** A lower-third that is up stays up, unchanged,
across any number of camera switches. This is structural, not a promise — see
[`ARCHITECTURE.md` §8](./ARCHITECTURE.md).

### AI suggestions (only while a suggestion is pending)

| Key | Gesture | Action | Destructive? |
|---|---|---|---|
| **Y** | tap | Confirm the pending suggestion | No |
| **N** | tap | Dismiss the pending suggestion | No |

### On-screen only — no keyboard shortcut exists

| Control | Gesture | Action | Destructive? |
|---|---|---|---|
| **CLEAR ALL** button | **hold** (≥ 1500 ms) | Clear every overlay layer | **YES** |

`CLEAR ALL` is deliberately **not** on the keyboard and deliberately **not** on the same control as
"take over from the AI". See §4.

---

## 2. ESC is non-destructive, and that is the point

**Holding ESC for 2 seconds stops AI automation and nothing else.**

- Whatever is live **stays live**. The camera does not change.
- The lower-third that is on screen **stays on screen**.
- The congregation screen is **never blanked**.
- The stream and the recording are untouched.
- **A quick ESC tap does nothing at all.** Not a partial action, not a warning — nothing. That is
  on purpose: a reflexive stab at ESC under stress must have no effect whatsoever.

### Why it works this way

The previous version of this system (rhema_v2) shipped plain ESC as an **instant clear-everything**.
Its own audit (`PROBLEMS.md` #86, mirrored in
[`v2-notes/SHORTCUTS_AND_A11Y.md`](./v2-notes/SHORTCUTS_AND_A11Y.md) §6) recorded that as a
high-severity defect against three separate design rules, and the behaviour had to be reversed.

The failure was not a coding mistake. It was **overloading one key to mean both "I want to take
over" and "clear the screen."** Those are the two things an operator reaches for at exactly the same
moment — when something has gone wrong and people are watching. Any gesture that means both is an
incident waiting for a Sunday.

So Verger separates them permanently, and enforces the separation in code rather than in review
comments: `ai.disable` is not in `DESTRUCTIVE_ACTIONS`, `overlay.clearAll` is, and
`isSafeBinding()` in [`src/shared/actions.ts`](../src/shared/actions.ts) refuses to let a
destructive action be bound to a tap or to a short hold at all.

---

## 3. PANIC — what it does and what it will never do

**SPACE held for 3 seconds.** Emergency stop for the automation.

PANIC **does**:

- halt every AI/automation subsystem at once,
- leave you in full manual control.

PANIC **never**:

- ❌ stops the stream,
- ❌ stops the recording,
- ❌ cuts, blacks, or otherwise takes down the video.

A panicking operator must never be able to take the broadcast down. That invariant is stated in the
`ai.panic` doc comment in `src/shared/actions.ts`, and it is why the "stop AI" code path shares no
dependency with any "stop encoder / stop stream" code path.

**PANIC vs. ESC** — different tools, on purpose:

| | ESC (hold 2 s) | PANIC (SPACE hold 3 s) |
|---|---|---|
| Scope | Light hand-back-control | Full emergency stop of automation |
| Stops AI | Yes | Yes |
| Touches live output | No | No |
| Touches stream/recording | No | No |
| When | "I'll drive for a bit" | "Everything stop, now" |

Recovery is not automatic. Re-enabling automation after PANIC is a deliberate operator action — the
system does not decide on its own that it is trusted again.

SPACE carries both advance (tap) and PANIC (hold 3 s) because a tap is defined as *released within
300 ms*; anything longer is the start of a hold. The two cannot be confused by a normal press.

---

## 4. The safety rules behind the table

These are not style preferences. Each one exists because its absence caused a real problem.

1. **Handing control back from the AI is always non-destructive.** ESC-hold stops automation and
   changes nothing that is on screen. (§2)
2. **Nothing destructive fires in under 1500 ms.** `MIN_DESTRUCTIVE_HOLD_MS = 1500`. Below roughly a
   second and a half, a "hold" stops being a decision and becomes a slightly slow press — which is
   the exact failure this exists to prevent. The two destructive actions are `overlay.clearAll` and
   `output.black`, and both are held.
3. **Destructive controls are physically separate from primary ones.** `CLEAR ALL` is an on-screen
   held button placed far from GO LIVE, so a slip of the hand cannot reach it. It has no key
   binding, and it is emphatically not on the same key as "take over".
4. **Holds, not taps, not double-clicks.** A hold cannot be produced by muscle memory. Releasing
   early fires nothing at all — there is no partial credit and no confirmation dialog to dismiss by
   reflex.
5. **The remap UI will refuse to break these** (Phase 10). Every candidate binding is checked with
   `isSafeBinding()`: a destructive action bound to a tap, or to a hold shorter than 1500 ms, is
   rejected by the settings screen rather than accepted and regretted. The v2 regression cannot be
   reintroduced through a remap.

---

## 5. Shortcuts are off while you are typing

Whenever focus is in a text field — the lower-third name boxes, a settings input, a search box —
**every shortcut in this document is inactive.** Typing "b" in a speaker's name must not black the
output, and a long press while composing must not fire PANIC.

Click away from the field, or press Tab, to get the shortcuts back.

---

## 6. Foot pedals and Stream Decks

**They already work.** A foot pedal and a Stream Deck are keyboard-HID devices: they emit ordinary
key codes. Verger routes *every* operator intent through one named action dispatcher, and keys are
merely one way to trigger an action — so a device that sends a key in the table above drives Verger
exactly as the keyboard does, with the same tap/hold state machine and the same safety thresholds.

To set one up today, program the device to send the key from the table:

| You want | Program the device to send |
|---|---|
| Advance | `SPACE` (a short press) |
| Cameras | `1` / `2` / `3` / `4` |
| Dismiss lower-third | `SHIFT` + `ESC` |
| Logo / freeze | `L` / `F` |
| Confirm / dismiss a suggestion | `Y` / `N` |

Two cautions for a pedal or a deck button:

- **Hold gestures need the device to actually hold the key down**, not send a keystroke pulse. If
  your device only pulses, PANIC (SPACE hold 3 s), ESC-hold, and B (hold 1500 ms) will not fire from
  it. Check the device's "key down / key up" or "hold" mode.
- **Do not configure a double-tap for anything destructive.** A double-tap can complete in well
  under 1500 ms, which defeats rule 2 in §4. v2's Stream Deck plugin used double-tap PANIC and left
  that tension unresolved; Verger's answer is hold-to-fire everywhere.

A proper remap UI — rebind any action to any key or device, validated by `isSafeBinding()` — lands
in **Phase 10**. Until then the table is the wiring.

---

## 7. Reference — the exact constants

Copied from [`src/shared/actions.ts`](../src/shared/actions.ts); do not retype these from memory
anywhere else.

| Constant | Value | Meaning |
|---|---|---|
| `MAX_TAP_MS` | `300` | A tap must be released within this long |
| `DISABLE_AI_HOLD_MS` | `2000` | ESC hold → disable AI automation |
| `PANIC_HOLD_MS` | `3000` | SPACE hold → PANIC |
| `MIN_DESTRUCTIVE_HOLD_MS` | `1500` | The floor for **any** destructive action |

`DESTRUCTIVE_ACTIONS` contains exactly two entries: `overlay.clearAll` and `output.black`.
`ai.disable` and `ai.panic` are deliberately **not** in it.
