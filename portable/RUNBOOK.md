# Verger — Operator Runbook (one page)

**Panic key: hold SPACE for 3 seconds. It never stops the stream or recording. OBS keeps running no matter what Verger does.**

---

## 1. Start it

1. Open the Verger folder on the USB drive (or church PC).
2. Double-click **START.bat**. (It works from any drive letter and pauses on a crash so you can read the error — don't close that window if something goes wrong, read it first.)
3. Verger opens. It does **not** need Node, admin rights, or the internet to launch.
4. If OBS isn't already running, start it first — Verger connects *to* OBS, it doesn't launch it.

Config lives in **config.json**, next to START.bat (OBS host/port/password, overlay port, ASR engine, which plan to load). Edit it, then **restart Verger** — it's only read at launch.

First launch on a new PC opens the **Preflight** tab automatically — a checklist of everything below. Fix anything red, run the two test buttons, then go.

## 2. What "good" looks like

Check these before the service starts:

| Check | Where | Good sign |
|---|---|---|
| OBS connected | Connection screen | Big status light says **Connected**; OBS version/scene shown |
| Plan loaded | Plan screen | Your service plan's cues are listed, not "No cues in this service plan yet" |
| Overlay showing | Overlay screen, and in OBS | Overlay panel says a browser source is attached (not "No overlay attached"); in OBS the "Overlays" browser source is visible on top of the camera in every scene |
| Trust mode | Trust dial | Set to **Assist** (the default) unless you deliberately want Auto |

If all are green, you're ready.

## 3. The 5 most likely failures

**OBS not connected / wrong password**
Go to the Connection screen. If it says "Password rejected," Verger has deliberately stopped retrying (repeating a wrong password never works). Open OBS → Tools → WebSocket Server Settings, re-copy the password into config.json's `obs.password`, restart Verger.

**Overlay browser source is blank in OBS**
The overlay panel will say "No overlay is attached." In OBS, right-click the "Overlays" browser source → **Refresh**. Make sure "Shutdown source when not visible" is turned OFF for it (a hidden/shutdown source is the usual cause). Confirm the URL in the Overlay panel matches what's pasted into OBS.

**Slides / plan not showing**
On the Plan screen, click **Open…** and pick the right `plan.json` (e.g. `plans\11am\plan.json` or `plans\afternoon\plan.json`). If cues still don't appear, the plan file may be empty or the wrong one — the file name/title shows at the top of the Plan screen.

**App won't launch**
Run START.bat again and read the paused error window — don't dismiss it blindly. If it keeps failing, drop straight to manual OBS operation (section 4) and keep the service going; fix Verger at the break.

**Mic / confidence percentage not working**
That percentage needs local Whisper speech recognition, a one-time ~290 MB setup that doesn't ship in the box (run **SETUP-ASR.bat** once — see ASR-SETUP.md). If Speech settings shows "not set up" or "failed," that's expected until it's been set up once — it is **not** blocking anything. Every cue, camera, and overlay button still works by hand exactly the same.

## 4. If Verger misbehaves mid-service — go fully manual in OBS

**OBS is the engine, not Verger — the stream and the local recording keep running no matter what happens to this app, including a crash.** You will never lose the broadcast because of Verger.

To take over by hand:

1. Ignore or close Verger if needed — do not worry about "stopping" anything in it.
2. Switch cameras directly in **OBS**: click the scene you want in OBS's own Scene list.
3. Verger's overlay layers (lower third, scripture, slide) can't be driven from OBS alone. If Verger is down, the simplest fallback is to hide the "Overlays" browser source in OBS to clear everything on screen, or leave the last state up if it's not distracting.
4. To advance slides without Verger: if you have the source PowerPoint deck open, run it directly and switch OBS to a "Slides" scene/source instead of relying on Verger's overlay slide layer.
5. When Verger comes back (relaunch via START.bat), it **re-attaches to whatever OBS is already doing** — it will never start a second stream or open a second recording file. You may see "Re-attached to a stream already in progress." Do not press GO LIVE again if you're already live; use Retry only if prompted.

## 5. Keyboard shortcuts (defaults — remappable in Shortcuts settings)

| Key | Gesture | Action |
|---|---|---|
| **Space** | tap | Advance to next cue/slide |
| **Space** | hold 3s | **PANIC** — stops all automation only; never touches stream, recording, or the screen |
| **Esc** | hold 2s | Disable AI / hand control back to operator (non-destructive) |
| **Shift + Esc** | tap | Dismiss lower third only |
| **B** | hold 1.5s | Cut program to black (destructive — hold required on purpose) |
| **L** | tap | Show logo / holding slate |
| **F** | tap | Freeze current frame |
| **Y** | tap | Confirm the pending AI suggestion |
| **N** | tap | Dismiss the pending AI suggestion |
| **Backspace** | tap | Step back one cue |
| **1 / 2 / 3 / 4** | tap | Camera: CAM 1 / CAM 2 / WIDE / PULPIT |

All destructive actions (black, clear-all-overlays) are hold-only by design — a slip of the hand can never blank the congregation's screen. A quick Esc tap deliberately does nothing.

---

*Remember: Assist mode suggests, you confirm. Manual advance (Space or click) always works regardless of mode. When in doubt, do it by hand in OBS — the broadcast is safe either way.*
