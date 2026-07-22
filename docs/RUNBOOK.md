# Service-day runbook

The Sunday sheet. Written to be read fast, by one person, while something is happening.

Print it. Keep it in the booth with the shortcut card from [`SHORTCUTS.md`](./SHORTCUTS.md).

**The one thing to hold on to:** *OBS is streaming and recording. Verger only tells it what to do.*
Almost nothing that goes wrong with Verger takes the service off the air, and the two questions
below are the whole triage:

> **Is the stream still up? Is the recording still running?**
> If both are yes, nothing on this page is an emergency. Finish the service, then investigate.

The **Status** tab answers exactly that question at the top of the screen, in words.

---

## T-30 — before anyone arrives

Six checks, roughly two minutes.

**1. Start OBS first, then Verger.** Verger attaches to OBS, not the other way round.

**2. Check the light strip along the top of Verger.** Seven lights: OBS, Overlay, Speech, YouTube,
Recording, Stream, Automation. What you want to see:

| Light | Good | Meaning of the other states |
|---|---|---|
| **OBS** | OK | Amber/red here means Verger cannot drive OBS. The service can still go out; you would be switching cameras in OBS by hand. |
| **Overlay** | OK | "No overlay attached" means the browser source is not connected — anything you show will go nowhere. Fix this before the service. |
| **Speech** | OK, or **Not set up** | *Not set up* is a resting state, not a fault. It is grey, not amber, on purpose. |
| **YouTube** | OK, or **Not set up** | Signed-out reads as *not set up*, not amber. Sign in now if you are publishing today. |
| **Recording** | Not recording (yet) | It goes green at GO LIVE. |
| **Stream** | Not live (yet) | As above. |
| **Automation** | Assist | *Assist* is the mode to run. See "During", below. |

**Amber means something.** It is reserved for *working, but not the way you configured it* — speech
fell back to the local engine, RTMP is reconnecting, dropped frames are climbing. A subsystem you
simply have not set up is never amber.

**3. Confirm the overlay is attached.** Open the **Overlay** tab. You want **Attached overlays: 1**
(or one per distinct browser source). `0 clients` during a service is the single most useful
warning in the app: it means every graphic you fire has nowhere to go.

**4. Load the service plan.** Plan tab → **Open…**. Check the cue list reads the way the service
runs, and that the first cue is where you expect. If you imported a deck, spot-check that slide 10
is after slide 2 — and that the images are the ones you meant.

**5. Fire a test lower-third.** Overlay tab → type a name and role → **Show**. Look at OBS's
preview, not at Verger. Then **Hide**. If it appeared over the camera and disappeared cleanly, the
whole overlay chain is proven end to end. Do this every week; it takes ten seconds and it is the
one check that catches a browser source someone quietly deleted.

**6. Check the recording target.** OBS → Settings → Output → Recording Path. Confirm the drive has
room. Verger will show you the file path once recording starts, but the folder is OBS's setting and
Verger cannot fix a full disk for you.

If you are publishing to YouTube today, also: **Go Live settings** → confirm the channel name is
the church's and not somebody's personal account, and press **Create the broadcast**. That
schedules it and binds the stream. **It publishes nothing** — nothing goes out until GO LIVE.

---

## Going live

**Press GO LIVE.** It runs five steps, in order, and shows you which one is running:

1. Prepare the YouTube broadcast
2. Start streaming from OBS
3. **Start the local recording**
4. Wait for the ingest to be healthy
5. Make the broadcast public

Then confirm **three** things before you relax:

- The **LIVE** indicator, not just the button state.
- The **RECORDING** indicator, which is deliberately separate. The recording is not a detail of the
  stream; it is your backup and it has its own light.
- The **recording file path** shown under the indicators. It normally appears a second or two
  after recording starts. If it says "OBS has not reported a path yet" for more than a few seconds,
  look at OBS's own window.

Things you may legitimately see:

- **"Skipped" on steps 1 and 5.** That is what YouTube-not-configured looks like. You are streaming
  and recording; nothing is being published. Expected on a machine with no Google credentials.
- **"STREAMING — NOT PUBLIC" (the `partial` state).** OBS is pushing to YouTube's ingest and the
  local file is being written, but the broadcast was never switched to live, so viewers see a
  waiting screen. **Nothing has been lost.** Press **Retry the YouTube transition** — retrying only
  finishes the missing steps and can never start a second stream or a second recording file. If
  retrying keeps failing, switch the broadcast to live from YouTube Studio in a browser; Verger
  will not interfere.
- **"The stream is running but nothing is being recorded".** Verger deliberately did **not** stop
  the stream over this. Press Start Recording in OBS's main window and check the output folder.

**Never press GO LIVE twice.** If OBS is already streaming, the button is disabled and says so.
That guard exists because "press it again" during a live, un-repeatable event is how you get two
streams and two recordings.

---

## During the service

### The controls you will actually use

| You want | Do this |
|---|---|
| Change camera | The four buttons on the **Cameras** tab. One tap. Never touches the lower-third. |
| Name on screen | **Overlay** tab: two lines, template, **Show** / **Hide**. Never touches the camera. |
| Next slide / next cue | **Advance** on the plan. |
| Undo a mis-fire | **BACK**. It steps the plan back one cue and never blanks the congregation screen. |
| Accept what Verger suggests | **Confirm** on the suggestion card, or press **Y**. |
| Refuse it | **Dismiss**, or press **N**. |
| Stop the automation entirely | **PANIC**. See below. |
| Blank every overlay layer | **CLEAR ALL** — a held button, placed away from everything else. |

**About the keyboard.** [`SHORTCUTS.md`](./SHORTCUTS.md) is the declared binding set, and every
binding runs through one action dispatcher — but a key only fires when the screen that owns that
action has registered a handler for it. **Confirm (Y) and dismiss (N) are bound by the shell and
work from any tab.** For anything else on the card, test it once during your T-30 checks rather
than discovering it mid-service: press it and watch what happens. **Every action on the card also
has an on-screen control — if a key does nothing, use that.**

A foot pedal or a Stream Deck is a keyboard device: whatever key it sends, Verger treats exactly as
the keyboard. Make sure yours holds the key down rather than pulsing it, or hold gestures will never
fire.

### Assist mode is the mode to run

**Assist** (the default): Verger highlights what it thinks is next and waits for you. Nothing
reaches the congregation screen until you say so.

**Auto**: high-confidence cues fire on their own. You can still veto — but only after it is already
up. Use it only for a service you have run this way before.

**Manual**: nothing is ever offered. Detections still show, so the transcript stays useful.

Two guarantees worth trusting:

- **Nothing can force an auto-fire.** A per-cue *"Always ask me first"* and a below-threshold
  confidence each block one; nothing overrides them, even at confidence 1.0. A cue can always be
  made safer than the service-wide setting, never more dangerous.
- **Taking over wins immediately.** The moment you move the plan by hand, the pending suggestion is
  dropped — you are not left racing an intent that was formed a second ago.

If the preacher goes off script, the plan-follower quietly stops suggesting after three misses and
the strip says **Off script**. Scripture and hot-phrase detection carry on; they need no plan at
all. This is normal and needs no action.

---

## When something goes wrong

One section per failure. Find yours, do the action, carry on.

### The overlay is blank — a graphic should be showing and is not

**The service is unaffected.** The camera feed is fine; only the graphic layer is missing.

1. Look at the **Overlay** tab client count. If it says **no overlay attached**, OBS is not
   connected to Verger at all.
2. **Status** tab → **Reload the overlays**. This forces every attached browser source to reload
   and re-sync. It cannot touch the camera feed or the broadcast.
3. If that does nothing: in OBS, right-click the **Overlays** source → **Refresh**. A refresh is
   always safe — the server holds the state and sends the current snapshot the moment the page
   reconnects, so a refresh cannot lose what is supposed to be on screen.
4. Still blank? The source is probably missing from *this* scene, or hidden, or *Shutdown source
   when not visible* got switched back on. Switch to a scene you know is right and carry on with
   the service; fix the scene afterwards with [`OBS_SETUP.md`](./OBS_SETUP.md) §4.

**A black or coloured rectangle over the camera** is not a blank overlay — it is a background
colour. Something got typed into the browser source's Custom CSS box, or a filter was left on the
source. Hide the source and fix it after the service.

### The stream light is amber — "reconnecting"

**Do nothing.** OBS's RTMP connection dropped and OBS is retrying by itself. **The local recording
is unaffected and keeps running throughout** — that is exactly the case the always-on recording
exists for.

Do not stop and restart the stream to "fix" it. That guarantees a gap; waiting usually does not.

If dropped frames are climbing steadily, the upload cannot keep up. Lower the video bitrate in OBS
rather than letting frames pile up. If it will not come back at all, the service in the room
continues and you have the local file — publish it afterwards.

### The Speech light is red or amber

**Nothing is blocked.** No cue, camera or overlay depends on speech recognition; the console works
exactly as it does with no microphone at all.

- **Amber / "Fallback"** — the cloud engine stopped answering and recognition fell back to the
  local one. A transcript is still arriving, a bit slower and a bit less accurate. Verger will not
  switch back mid-service on its own, on purpose: flipping engines every few seconds visibly
  rewrites the transcript, which is worse than staying on the fallback.
- **Red / "Failed"** — no transcript is arriving. Drive the plan by hand. That path was built first
  precisely so it could be this fallback.
- Check the obvious thing once: is the pulpit microphone actually live, and is the right input
  selected in Speech settings? Then stop looking at it and run the service.

### The wrong cue fired

1. **BACK.** It steps the plan back one cue and never blanks the screen.
2. Show the right thing by hand from the Overlay or Plan tab.
3. If it was an automation decision rather than your own mis-tap, switch the trust dial to
   **Assist** (or **Manual**) so it cannot happen twice, or press **PANIC**.
4. If automation has drifted several cues away from reality, **Status** tab → **Rewind automation**
   to a checkpoint. Pick the last point where it was doing the right thing. This rewinds *the plan
   pointer and what Verger will do next* — it does **not** touch the stream, does **not** touch the
   recording, and changes nothing the congregation is watching.

### Verger crashed, or you closed it by accident

**The service did not stop.** OBS keeps streaming and recording; Verger is a convenience layer, not
a link in the chain. You lose the overlay and camera *controls* until it is back — you can switch
scenes in OBS by hand in the meantime.

**Relaunch it.** On startup Verger reads what OBS is already doing and **adopts** it: the GO LIVE
panel shows *"Re-attached to a stream already in progress"*, and the elapsed time comes from OBS
rather than from when you pressed the button. Nothing is restarted and no second recording file is
opened.

Then reconnect the pieces that are yours: reopen the plan, and check the Overlay tab still says
attached.

**Do not press GO LIVE after a relaunch.** If Verger somehow shows idle while OBS is plainly
streaming, stop and look at OBS's own window before pressing anything — pressing GO LIVE against an
already-live OBS is the one action in this app that could genuinely damage a service.

### PANIC

**What it is:** the emergency stop for the *automation*.

**What it does:** halts every automatic action at once. No cue fires, no scripture appears, no
suggestion is applied.

**What it does NOT do — and this is the point:**

- It does **not** stop the stream. You stay live.
- It does **not** stop the local recording. Your backup keeps being written.
- It does **not** clear the congregation screen. Whatever is showing stays showing.
- It does **not** change the camera.

That is why it is safe to press, at any moment, in front of anyone. It costs you nothing except the
automation you did not want. If you are unsure what is happening — press it.

**Recovery is never automatic.** Nothing turns automation back on by itself: not a new suggestion,
not a mode change, not restarting speech recognition. Only the **Resume automation** button. The
trust dial is locked until you do.

**CLEAR ALL is a different button and does something different.** It blanks all three overlay
layers. It is a deliberate hold, it sits away from everything else, and it has no keyboard binding —
because "I want to take over" and "clear the screen" are the two things an operator reaches for at
the same moment, and any control that means both is an incident waiting for a Sunday.

---

## After the service

**1. END.** It is a **held** button, not a tap — ending a service by a mis-click cannot be undone,
and everyone watching at home saw it end. Hold it.

END marks the YouTube broadcast finished, stops the stream, and **stops the local recording last**,
so a YouTube or network failure on the way out cannot cost you the file.

**2. Find the recording.** The path is the one shown in the GO LIVE panel; the folder is OBS's, under
Settings → Output → Recording Path. **Play the first ten seconds and the last ten seconds** before
you close anything. A file that exists and a file that plays are not the same claim.

**3. Check three things while it is fresh:**

- Did the YouTube broadcast actually end (status *Finished*), or is it still showing as live?
- Did anything on the status strip go amber during the service? The strip shows how long each state
  has been in force; the log file has the detail.
- Was anything missing that should have been in the plan? Fix it in the plan now, not on Saturday
  night.

**4. Copy the recording off the machine** if it is your archive copy. That is not something Verger
does for you.

**5. If something went wrong**, the log is at `%APPDATA%\Verger\logs`. It is a rolling file, it
never contains a secret, and it is the first thing to attach to a bug report along with the version
string from the title bar.

---

## What this runbook cannot promise

Every failure path above is implemented and covered by a failure-injection test that simulates the
failure through an injected seam — one test per row of the failure table in
[`../BLUEPRINT.md`](../BLUEPRINT.md) §9. **None of them has been observed against the real thing.**
OBS Studio is not installed on the machine this was built on, no real internet drop has been
survived, no real browser source has crashed, and no real broadcast has been started or ended. The
fallbacks are proven against a model of each failure, not against the failure itself.

The first real service run with this app should be a rehearsal, not a Sunday.
