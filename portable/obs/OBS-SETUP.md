# OBS + Verger setup — the church PC checklist

Do this once on a machine before its first service. After that, you should not need to touch OBS
settings again. For the Sunday checklist once setup is done, see **RUNBOOK.md** next to START.bat.

You need: OBS Studio already installed on this PC, and the Verger folder copied whole onto this
machine or a USB stick (Verger.exe, START.bat, config.json, `resources\`, `plans\` all together —
not just one file out of it).

---

## 1. Turn on OBS's WebSocket server and note the port + password

Verger talks to OBS over a local connection called **obs-websocket**. It ships inside OBS — nothing
to download — but it starts switched off.

1. Open OBS Studio.
2. Menu bar → **Tools** → **WebSocket Server Settings**.
3. Tick **Enable WebSocket server**.
4. Note the **Server Port** box. Leave it on the default, **4455**, unless you have a specific
   reason to change it.
5. Click **Show Connect Info** and note the **Server Password** shown there. (If you'd rather run
   with no password, untick "Enable Authentication" instead — Verger accepts that too, see step 2.)
6. Click **OK** / **Apply**.

Leave this dialog closed for the rest of the setup — you do not need to reopen it unless the
password or port changes.

---

## 2. Put the port and password into `config.json`, then restart Verger

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

## 3. Launch Verger and connect, on the Connection screen

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

**To import a fresh PowerPoint deck:** click **Import deck…** and pick a `.pptx` file. Because this
church PC has PowerPoint installed, Verger renders **every slide** through it (not just the first
one) and automatically anchors each slide as a cue from its slide text — you don't have to build
the cue list by hand.

Either way, check the cue list in the Plan tab reads the way the service actually runs before you
go live.

---

## 6. Scene collection — this PC's OBS won't have your usual scenes

A church PC's OBS install starts with whatever scenes happen to be there — maybe not your usual
scene names, maybe none at all. **That's fine: Verger never requires specific scene names.** It
reads whatever scenes OBS currently reports and lets you map to them.

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

Once all six steps are done, service day should never require reopening OBS's settings — everything
routine happens from Verger.
