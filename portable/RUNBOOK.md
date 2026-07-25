# Verger — Operator Runbook (one page)

**Panic key: hold SPACE for 3 seconds. It never stops the stream or recording. OBS keeps running no matter what Verger does.**

---

## 1. Start it

1. Open the Verger folder on the USB drive (or church PC).
2. Double-click **START.bat**. (It works from any drive letter and pauses on a crash so you can read the error — don't close that window if something goes wrong, read it first.)
3. Verger opens. It does **not** need Node, admin rights, or the internet to launch.
4. If OBS isn't already running, start it first — Verger connects *to* OBS, it doesn't launch it.

Config lives in **config.json**, next to START.bat (OBS host/port/password, overlay port, ASR engine, and which plan to load). Edit it, then **restart Verger** — it's only read at launch.

It ships set to open **`plans/11am/plan.json`**, so the 11 o'clock deck is on screen the moment Verger starts. For the afternoon service change `assets.plan` to `plans/afternoon/plan.json` and restart. Set it to `""` to start with no plan open. If the path is wrong Verger still starts — the grid just says no plan is open, and the reason is in the log.

First launch on a new PC opens **Setup** automatically on the **Preflight** page — a checklist of everything below. Fix anything red, run the two test buttons, then press **Esc** to get to the console.

### What you're looking at

There are only two things on screen during a service:

- **The slide grid** — your whole deck, laid out like PowerPoint's slide sorter. The slide that's live has a **thick bright ring and a glow**; the one coming next has a thinner, dimmer ring; everything else is dimmed. **Tap any slide to jump straight to it.** The grid follows along on its own, and stops following for a second and a half whenever you scroll by hand, so you can look ahead without it yanking you back.
- **The bar along the bottom** — the bar itself is the progress meter. See section 2.

Everything else — settings, the plan editor, OBS connection, speech setup, the status lights — is behind the gear button at the bottom right, or **Ctrl+,**. **Esc** closes it. While it's open the service keys are switched off on purpose, so you can type in it without advancing the service.

## 2. What "good" looks like

**Read the bottom bar first.** Left to right it tells you: a **dot** (red = you are ON AIR, amber = starting/reconnecting, grey = off air), the **elapsed time**, **REC** while OBS is recording, and the **OBS connection state**. In the middle is the big **match percentage** — how confident Verger is that the next cue is the right one — and under it, what's on now and what's next. The **coloured fill sweeping across the whole bar is that percentage.**

A dash (**—**) instead of a percentage is normal and correct: it means nothing is pending, usually because speech recognition isn't set up (see ASR-SETUP.md). It is **not** an error, and every button still works by hand.

**If you ever see a red `NO REC` on the bar, stop and fix it** — that means OBS is streaming but *not* recording, so the service is going out unrecorded. Start recording in OBS.

Then check these before the service starts. All of them are behind **Ctrl+,** (Setup):

| Check | Where | Good sign |
|---|---|---|
| OBS connected | Setup → Connection | Big status light says **Connected**; OBS version/scene shown |
| Plan loaded | The slide grid itself | Your slides fill the screen as tiles — not "No service plan is open." |
| Overlay showing | Setup → Overlay, and in OBS | Overlay panel says a browser source is attached (not "No overlay attached"); in OBS the "Overlays" browser source is visible on top of the camera in every scene |
| Cameras mapped | Bottom bar, right side | Buttons **1**–**4** are enabled, not greyed out. Grey means no OBS scene is mapped — fix in Setup → Camera setup |
| Trust mode | Setup → Automation | Set to **Assist** (the default) unless you deliberately want Auto |

If all are green, press **Esc** and you're ready.

## 3. The 5 most likely failures

**OBS not connected / wrong password**
**Ctrl+,** → Connection. If it says "Password rejected," Verger has deliberately stopped retrying (repeating a wrong password never works). Open OBS → Tools → WebSocket Server Settings, re-copy the password into config.json's `obs.password`, restart Verger.

**Overlay browser source is blank in OBS**
**Ctrl+,** → Overlay will say "No overlay is attached." In OBS, right-click the "Overlays" browser source → **Refresh**. Make sure "Shutdown source when not visible" is turned OFF for it (a hidden/shutdown source is the usual cause). Confirm the URL in the Overlay panel matches what's pasted into OBS.

**Slides / plan not showing** — the grid says "No service plan is open."
**Ctrl+,** → Plan, click **Open…**, and pick the right `plan.json` (e.g. `plans\11am\plan.json` or `plans\afternoon\plan.json`). Press **Esc** and the slides should fill the screen. If the grid instead shows grey tiles with a picture icon, the `plan.json` was found but its slide images were not — check that the plan's `assets\slides\` folder came across with it.

**App won't launch**
Run START.bat again and read the paused error window — don't dismiss it blindly. If it keeps failing, drop straight to manual OBS operation (section 4) and keep the service going; fix Verger at the break.

**Mic / confidence percentage not working**
That percentage needs local Whisper speech recognition, a one-time ~290 MB setup that doesn't ship in the box (run **SETUP-ASR.bat** once — see ASR-SETUP.md). If **Ctrl+,** → Speech settings shows "not set up" or "failed," that's expected until it's been set up once — it is **not** blocking anything, and the bar showing **—** instead of a percentage is the correct display for it. Every cue, camera, and overlay button still works by hand exactly the same.

## 4. If Verger misbehaves mid-service — go fully manual in OBS

**OBS is the engine, not Verger — the stream and the local recording keep running no matter what happens to this app, including a crash.** You will never lose the broadcast because of Verger.

To take over by hand:

1. Ignore or close Verger if needed — do not worry about "stopping" anything in it.
2. Switch cameras directly in **OBS**: click the scene you want in OBS's own Scene list.
3. Verger's overlay layers (lower third, scripture, slide) can't be driven from OBS alone. If Verger is down, the simplest fallback is to hide the "Overlays" browser source in OBS to clear everything on screen, or leave the last state up if it's not distracting. A video is part of that overlay, not a separate OBS source, so hiding the "Overlays" browser source stops the clip and its sound instantly — that is the manual kill switch for a video misbehaving on air. Hiding the slide layer in Verger does the same thing, if Verger is still answering.
4. To advance slides without Verger: if you have the source PowerPoint deck open, run it directly and switch OBS to a "Slides" scene/source instead of relying on Verger's overlay slide layer.
5. When Verger comes back (relaunch via START.bat), it **re-attaches to whatever OBS is already doing** — it will never start a second stream or open a second recording file. You may see "Re-attached to a stream already in progress." Do not press GO LIVE again if you're already live; use Retry only if prompted.

## 5. Keyboard shortcuts (defaults — remappable in Setup → Shortcuts)

| Key | Gesture | Action |
|---|---|---|
| **Space** or **→** | tap | Advance to next cue/slide |
| **Backspace** or **←** | tap | Step back one cue (moves the pointer; does **not** re-show anything) |
| **1 / 2 / 3 / 4** | tap | Camera: CAM 1 / CAM 2 / WIDE / PULPIT |
| **Y** | tap | Confirm the pending AI suggestion |
| **N** | tap | Dismiss the pending AI suggestion |
| **Shift + Esc** | tap | Dismiss lower third only — touches no other layer |
| **Esc** | hold 2s | Hand control back from the AI: switches to Manual. Non-destructive — whatever is on screen stays on screen |
| **Space** | hold 3s | **PANIC** — stops all automation only; never touches the stream, the recording, or the screen |
| **Ctrl + ,** | tap | Open / close Setup |
| **Esc** | tap | Close Setup (only while it's open — see below) |

**→** and **←** are always-on extras and are the only keys not listed in Setup → Shortcuts. They're there so a foot pedal works with nothing configured (see below). Everything else in the table above can be rebound there.

A quick **Esc** tap with Setup closed deliberately does nothing at all. That is on purpose: the control you grab when you want to take over from the AI must never be able to blank the congregation's screen, so it is a *hold*, and there is no tap binding for it to be confused with.

While Setup is open, **all of the service keys above are switched off** — so you can type a speaker's name into the lower-third box without `b` and the spacebar driving the service.

### Listed in Setup → Shortcuts but **not implemented yet**

Don't rely on these; they do nothing when pressed:

| Key | Gesture | Intended action |
|---|---|---|
| **B** | hold 1.5s | Cut program to black |
| **L** | tap | Show logo / holding slate |
| **F** | tap | Freeze current frame |

There is no blackout, slate or freeze in this build — OBS has no generic "black the program" command, and doing it properly needs you to nominate a scene for it, which isn't built. **To black out, switch scenes in OBS itself** (section 4). The keys keep their hold gestures reserved so that when blackout does arrive it can't show up as a tap.

### Foot pedal

A USB foot pedal is just a keyboard — it sends a keystroke. Map its pedals to:

- **Next slide → `→` (Right Arrow)**, or `Space`
- **Back → `←` (Left Arrow)**, or `Backspace`

Use the arrows if your pedal software offers them: `Space` doubles as PANIC when held for 3 seconds, and a pedal you rest your foot on could reach that. The arrows have no hold gesture at all, so they are the safer pair. A three-pedal unit is well served by `←` / `→` / `Y` (confirm the AI's suggestion).

If your pedal sends something else entirely, remap Verger instead of the pedal: **Ctrl+,** → Shortcuts, and rebind Advance and Back to whatever it emits. If you bind Advance to `→` yourself there, that's fine — your binding simply takes over from the built-in one.

## 6. Getting slides, images and video into the plan

Both routes are behind **Ctrl+,** → **Plan**, and neither needs the internet.

- **Import deck…** — pick any `.pptx` from anywhere on this PC. Every slide is rendered through PowerPoint. It **adds to** the plan that's already open rather than replacing it, so several decks can make up one service; import them in the order the service runs, then read the cue list back before you go live.
- **Add image / video…** — pick one image or one video. Verger **copies** it into the open plan's own `assets` folder (images to `assets\slides\`, video to `assets\media\`) and makes a cue for it. The copy is the point: the plan keeps working after someone moves or renames the original, and after this folder is carried to another PC. Images: `.png .jpg .jpeg .gif .webp .bmp .avif`. Video: `.mp4 .webm .m4v .mov .mkv`.

Two things that will stop you, both a minute's work to fix:

- **A legacy `.ppt` won't import** — that's the pre-2007 format. Open it in PowerPoint, **Save As → .pptx**, import that instead.
- **The plan has to be saved to disk first**, because the images are written beside its `plan.json`. The plans on this stick are already saved, so this only bites on a brand-new plan you just started — save it, then import. Verger tells you when this is the reason.

**Video plays on the overlay, not through OBS**, so its sound comes out of the `Overlays` browser source and OBS has to be set up once to carry that audio. See **OBS-SETUP.md section 7** — and test it with the real clip before the service, not during it.

---

*Remember: Assist mode suggests, you confirm. Manual advance (Space or click) always works regardless of mode. When in doubt, do it by hand in OBS — the broadcast is safe either way.*
