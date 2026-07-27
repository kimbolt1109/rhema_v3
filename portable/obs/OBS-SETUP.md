# OBS + Verger setup — the church PC checklist

Do this once on a machine before its first service. After that, you should not need to touch OBS
settings again. For the Sunday checklist once setup is done, see **RUNBOOK.md** next to START.bat.

You need: the Verger folder copied whole onto this machine or a USB stick (Verger.exe, START.bat,
config.json, `resources\`, `plans\` all together — not just one file out of it), and OBS — either
bundled in that folder or already installed on this PC.

---

## First: does this folder have an `obs` sub-folder?

Look inside the Verger folder, next to `Verger.exe`.

> ### If there IS an `obs` folder — you are already done. Skip to step 5.
>
> That is a **portable OBS, pre-wired for this church**. `START.bat` starts it for you, then starts
> Verger, and Verger finds it by itself. Everything the rest of this document asks you to click has
> already been set in files:
>
> | Already done | Which step it replaces |
> |---|---|
> | WebSocket server switched on, with its own unique password | 1, 2, 3 |
> | An `Overlays` browser source, correct URL, CSS cleared, both refresh boxes off | 4 |
> | A scene called `Cam 1` for you to drop the room's camera into | 6 |
> | "Control audio via OBS" ticked, so video cues are audible | 7 |
> | Recording set to `.mkv`, which survives a crash — an `.mp4` would not | — |
>
> **Do not also open an OBS installed on this PC.** Two OBS instances fight over the camera and the
> encoder. `START.bat` checks, and will not start the bundled one if another OBS is already running.
>
> One thing is still yours to do: **add the room's camera** to the `Cam 1` scene (step 6.1), because
> only you know what this room's camera is.

> ### If there is NO `obs` folder — use the OBS installed on this PC, and do step 1
>
> Verger reads OBS's own WebSocket settings — the port and the password — straight out of OBS's
> config file, and connects by itself at launch. So **step 1 is all you normally have to do.** Steps
> 2 and 3 are only for the unusual cases: OBS running on a different PC, a port you deliberately
> changed, or a connection that did not come up on its own.
>
> Verger never *writes* to OBS's settings. It will not switch the WebSocket server on for you — that
> stays your decision, which is why step 1 is still done by hand.

## 1. Turn on OBS's WebSocket server

Verger talks to OBS over a local connection called **obs-websocket**. It ships inside OBS — nothing
to download — but it starts switched off.

1. Open OBS Studio.
2. Menu bar → **Tools** → **WebSocket Server Settings**.
3. Tick **Enable WebSocket server**.
4. Note the **Server Port** box. Leave it on the default, **4455**, unless you have a specific
   reason to change it.
5. Click **OK** / **Apply**.

That is it. You do **not** need to open "Show Connect Info", and you do not need to write the
password down — Verger reads it from OBS itself. If you would rather run with no password at all,
untick **Enable Authentication**; Verger handles that too, and will not send a stale password when
authentication is off.

Now start Verger (`START.bat`). Open **Ctrl+, → Connection**: it should already say **Connected**,
with OBS's version and scene list. If it does, **skip to step 4** — steps 2 and 3 are not needed.

If it does not connect, the two likely reasons are both stated on that screen: OBS was not running
when Verger started (press **Connect**), or the WebSocket server is still switched off in step 1.

---

## 2. Only if it did not connect by itself — put the port and password into `config.json`

Skip this if the Connection screen already says **Connected**. Anything you set here **overrides**
what Verger read from OBS, which is the point: this is the escape hatch for OBS on another machine, a
non-standard port, or a setup Verger guessed wrong.

`config.json` sits in the same folder as `START.bat` and `Verger.exe`. Open it in Notepad.

```json
{
  "obs": {
    "host": "127.0.0.1",
    "port": 4455,
    "password": "paste-the-server-password-here"
  },
  "overlay": {
    "port": 7320
  },
  "asr": {
    "engine": "whisper"
  },
  "assets": {
    "plan": ""
  }
}
```

- Leave `obs.host` as `127.0.0.1` — OBS runs on this same machine.
- Set `obs.port` to whatever you saw in step 1 (`4455` unless you changed it).
- Set `obs.password` to the **Server Password** from step 1, exactly as shown, in quotes. If you
  turned authentication off in OBS, leave it as `""` (empty string).
- `overlay.port` (`7320`) and `asr.engine` (`"whisper"`, or `"none"` to skip local speech
  recognition entirely) are unrelated to OBS — leave them unless you have a reason to change them.

Save the file, close Notepad, and **restart Verger** (close it if it's running, then double-click
`START.bat` again). `config.json` is only read at launch — editing it while Verger is open does
nothing until you restart.

---

## 3. Only if it still did not connect — connect by hand

Double-click `START.bat`. Open the **Connection** tab.

**Important:** the two fields on this screen do **not** read `config.json` automatically. They
always start at their defaults (`ws://127.0.0.1:4455`, blank password), so type or paste in the
*same* port and password you just put in `config.json`:

1. **OBS WebSocket address** — the field already reads `ws://127.0.0.1:4455`. If you used a
   different port in step 1/2, change the number here to match. (This field is forgiving: pasting
   a bare IP, an `IP:port`, or just a port number from OBS's "Show Connect Info" box is completed
   into a full `ws://…` address for you automatically.)
2. **Password** — paste the same **Server Password** from step 1. Leave it blank only if you
   turned OBS authentication off.
3. Click **Connect**.

**What you should see:**

- While connecting: a spinning indicator, "**Connecting**".
- **Success:** the big status light turns **green**, label **"Connected"** — under it, "Reading
  OBS's live state. OBS remains in charge of the stream." A details panel appears with the OBS
  Studio version, the obs-websocket version, the current program scene, and a read-only list of
  every scene OBS currently has.
- **Wrong password:** the light turns **red** with the label **"Password rejected"**. Verger
  deliberately does **not** keep retrying a rejected password — it would never succeed. Fix the
  password and press **Connect** again.

Once it says **Connected**, this screen is read-only. Scene switching and everything else happens
from the other tabs.

---

## 4. Add the overlay Browser Source in OBS

**Skip this entirely if the folder has an `obs` sub-folder** — the `Overlays` source is already in
the `Cam 1` scene, with all five settings below already correct.

The overlay (lower-thirds, scripture, slides) is a separate browser layer that sits on top of every
camera scene.

1. In Verger, open the **Overlay** tab. Under "Overlay server" you'll see the exact URL to paste,
   with a **Copy URL** button next to it — use that instead of retyping it by hand. It will read
   `http://127.0.0.1:7320/overlay` unless you changed `overlay.port` in `config.json`.
2. In OBS, in your first camera scene: **Sources → + → Browser**. Name it exactly **`Overlays`**.
3. Set:
   - **URL** — paste what you copied from Verger's Overlay panel.
   - **Width** `1920`, **Height** `1080` (match your canvas).
   - **Custom CSS** — leave empty (clear anything OBS pre-filled).
   - **Shutdown source when not visible** — **OFF**.
   - **Refresh browser when scene becomes active** — **OFF**.

   (Both of those checkboxes destroy and recreate the page on every scene change, which is exactly
   when you don't want a graphic to flicker or vanish. Leave them off.)
4. To add the same source to your other camera scenes: right-click it in the Sources list →
   **Copy**, switch scene, right-click in that scene's Sources list → **Paste (Reference)** — not
   *Paste (Duplicate)*. This keeps it one shared source with one connection, so it never needs
   fixing more than once.
5. Verify it: in Verger open the **Preflight** tab and press **Test lower third (5s)** (or use the
   Overlay tab's Show button). It should appear over the camera in OBS's preview within a frame or
   two, then disappear. If the Overlay/Preflight panel says **0 attached**, OBS isn't connected to
   the page at all — recheck the URL and the two checkboxes above.

---

## 5. Open a service plan — or import a fresh one

Open Verger's **Plan** tab.

**To use a plan that's already prepared:** click **Open…** and browse to one of the two pre-built
plans that ship in this folder:

- `plans\11am\plan.json` — 102 slides
- `plans\afternoon\plan.json` — 48 slides

**To import a fresh PowerPoint deck:** click **Import deck…** and pick a `.pptx` file — from
anywhere on this PC, it doesn't have to be in the Verger folder. Because this church PC has
PowerPoint installed, Verger renders **every slide** through it (not just the first one) and
automatically anchors each slide as a cue from its slide text — you don't have to build the cue
list by hand. An import **adds to** the plan that's open rather than replacing it, so two or three
decks can make up one service; import them in the order the service runs.

**To bring in a single image or a video:** click **Add image / video…** and pick the file. Verger
**copies** it into the open plan's own `assets` folder — images into `assets\slides\`, video into
`assets\media\` — and creates a cue for it. The copy is the whole point: the plan keeps working
after someone moves or renames the original, and after this folder is carried to another PC. Images:
`.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` `.avif`. Video: `.mp4` `.webm` `.m4v` `.mov` `.mkv`.
Like the deck import, this needs no internet — nothing is uploaded anywhere.

**Two limits, worth knowing now rather than when you're in a hurry:**

- A legacy **`.ppt`** — the pre-2007 PowerPoint format — cannot be imported. Open it in PowerPoint,
  do **Save As → `.pptx`**, and import that file instead.
- A plan must be **saved to disk** before anything can be imported into it, because the images are
  written beside its `plan.json`. The two plans above already are, so this only comes up if you
  started a brand-new plan from scratch — save it first. Verger says so plainly rather than failing
  quietly.

Whichever route you use, check the cue list in the Plan tab reads the way the service actually runs
before you go live. **If you brought in a video, do step 7 too** — otherwise it plays silently.

---

## 6. Scene collection — this PC's OBS won't have your usual scenes

A church PC's OBS install starts with whatever scenes happen to be there — maybe not your usual
scene names, maybe none at all. **That's fine: Verger never requires specific scene names.** It
reads whatever scenes OBS currently reports and lets you map to them.

**If the folder has an `obs` sub-folder**, the scene already exists and is called `Cam 1` with the
`Overlays` source already on it — so 6.1 is only "add this room's camera to it", and 6.2 is done.
Go straight to 6.3 to map the button.

1. In OBS, create **at least one scene** with a camera source in it (Sources → + → Video Capture
   Device, or whatever this room's camera needs).
2. Add the shared **Overlays** browser source from step 4 to that scene too (top of the source
   list, above the camera). If you have several camera scenes, repeat step 4.4 (Paste as Reference)
   so every scene that can go on screen carries the same Overlays source — a scene without it will
   silently drop the lower-third the moment you cut to it.
3. In Verger, open the **Camera setup** tab. Each of the four camera buttons (Cam 1, Cam 2, Wide,
   Pulpit) has a dropdown populated **live from OBS's actual scene list** — not free text, so a
   typo can't leave you with a button that looks fine and fails on air. Map at least one button to
   the scene you just built; leave the rest unmapped (they'll simply stay disabled) until more
   scenes exist.
4. Save. Back on the **Cameras** tab, the button(s) you mapped are now live — pressing one changes
   OBS's program scene, and only the camera, never the overlay layer.

You can come back to Camera setup any time OBS's scene collection changes; the dropdowns always
reflect whatever OBS has right now.

---

## 7. Video sound — let the overlay's audio into the OBS mixer

**Skip this entirely if the folder has an `obs` sub-folder** — "Control audio via OBS" is already
ticked. Do still do 7.4: test with the real clip before the service.

Skip this if you never play video. If you do, do it now: a silent video in front of a congregation
cannot be fixed while it is playing.

Verger plays video on the overlay, on the same full-frame layer that shows slides — not through an
OBS media source. So the sound comes out of the **`Overlays`** browser source you added in step 4,
and that audio does not appear in OBS's **Audio Mixer** — the mix the congregation and the stream
actually hear — until you tell OBS to control it.

1. In OBS, right-click the **`Overlays`** browser source → **Properties**.
2. Tick **Control audio via OBS**, then **OK**.
3. Look at OBS's **Audio Mixer** panel. **`Overlays`** should now be listed there. Check it is not
   muted (speaker icon not struck through) and its volume slider is up, not sitting at the bottom.
4. **Test it once with the actual video file, before the service.** Bring the clip in (step 5), fire
   its cue, and listen where it matters — the stream, or a recording played back — not only this
   PC's speakers.

If you added `Overlays` to your other scenes with **Paste (Reference)** as step 4.4 says, it is one
shared source, so ticking this once covers every scene.

One thing to know for service day: **hiding the slide layer stops the video and its sound.** That is
deliberate — it is the way out if a clip misbehaves on air. Hiding the `Overlays` browser source in
OBS does the same for everything at once (RUNBOOK.md section 4).

---

Once steps 1–6 are done — plus step 7 if you play video — service day should never require reopening
OBS's settings; everything routine happens from Verger.
