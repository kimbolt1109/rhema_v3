# OBS setup — the Overlays browser source

The Sunday-morning guide. Follow it once when you set the machine up; after that you should never
have to touch OBS during a service.

Everything here is about **one** thing: making the overlay a **layer that lives above the cameras**,
present in every scene, so that switching cameras cannot disturb a lower-third and showing a
lower-third cannot disturb the camera. That is Feature 3 in [`../BLUEPRINT.md`](../BLUEPRINT.md) §6
and the reason this phase exists.

> **Status of this document.** The URLs, port, and settings below are read from
> [`../src/shared/net.ts`](../src/shared/net.ts) and [`../src/shared/ipc.ts`](../src/shared/ipc.ts),
> which are on disk and typechecked. **No step in this document has been executed against a real
> OBS instance** — OBS Studio is not installed on the development machine (see
> [`../HUMAN_TASKS.md`](../HUMAN_TASKS.md) and [`DEVELOPMENT.md`](./DEVELOPMENT.md) §1). Treat the
> verification section as the checklist to run the first time OBS is available, not as a report of a
> test that has already passed.
>
> Likewise, the page-side behaviours described here — the transparent blank page and the `?debug=1`
> readout — are the Phase-2 requirements on `src/overlay/`, which was being built in parallel with
> this guide. If the page you get behaves differently, the page is what should change, or this
> paragraph is; do not leave the two disagreeing.

---

## 0. Before you start

| Requirement | Why |
|---|---|
| **OBS Studio 30 or newer** | Verger drives OBS over obs-websocket **v5**, which ships in the box from OBS 28 and is stable and current from 30. Older builds need a third-party plugin and are not supported. |
| **obs-websocket enabled** | `Tools → WebSocket Server Settings` → tick *Enable WebSocket server*, note the port (default `4455`), click *Show Connect Info* for the password, and put both in `.env` as `OBS_WEBSOCKET_URL` / `OBS_WEBSOCKET_PASSWORD`. Tracked as an open item in [`../HUMAN_TASKS.md`](../HUMAN_TASKS.md). |
| **Verger running** | The overlay server lives inside Verger's main process. If Verger is closed, the overlay page has nothing to load and nothing to listen to. |

The overlay server is **loopback-only** by default: it binds `127.0.0.1` and is reachable only from
this machine. That is fine, because OBS runs on this machine. Nothing needs to be opened on the
firewall, and nothing here should ever be bound to `0.0.0.0`.

---

## 1. The scene contract

**Every camera scene = camera source(s) + the same persistent "Overlays" browser source on top.**

```
  Scene: "CAM 1"                        Scene: "WIDE"
  ┌────────────────────────────┐        ┌────────────────────────────┐
  │  Overlays  (browser)  ▲top │        │  Overlays  (browser)  ▲top │   ← the SAME source object
  │  ├ lowerThird layer        │        │  ├ lowerThird layer        │     in both scenes
  │  ├ scripture  layer        │        │  ├ scripture  layer        │
  │  └ slide      layer        │        │  └ slide      layer        │
  ├────────────────────────────┤        ├────────────────────────────┤
  │  Camera 1 (capture)        │        │  Wide cam (capture)        │
  └────────────────────────────┘        └────────────────────────────┘
            ▲                                       ▲
            └──────── operator switches ────────────┘
                 the Overlays source is untouched
```

Two rules, and they are the whole product:

1. **The Overlays source must be in every scene the congregation can see.** If it is missing from
   one scene, switching to that scene silently drops the lower-third mid-sentence. There is no
   warning; the graphic just vanishes.
2. **It should be the *same source*, shared between scenes — not a copy per scene.** In OBS, a
   source added to two scenes by reference is one object with one browser instance and one
   WebSocket connection. Copies are separate pages: each keeps its own connection, and while the
   state protocol means they will all show the same thing, you are paying for N browser instances
   and N reconnects instead of one, and any per-source setting you fix (size, shutdown behaviour)
   has to be fixed N times.

To share it: build the source once in your first camera scene, then right-click it →
**Copy**, switch to the next scene, right-click in the Sources list → **Paste (Reference)**.
*Paste (Duplicate)* is the wrong one — that makes an independent copy.

Keep the Overlays source at the **top** of the source list in each scene (OBS draws the list
top-first, so the top entry is the front-most layer).

### Where each layer comes from

The overlay page renders three independent layers, driven by the state the server holds:

| Layer | Shown by | Typical use |
|---|---|---|
| `lowerThird` | `lowerThird.show` / `.hide` | Name + role captions. Templates: `bar`, `boxed`, `minimal`. |
| `scripture` | `scripture.show` / `.hide` | Reference, verse text, translation, attribution. |
| `slide` | `slide.show` / `.hide` | A slide image served by the overlay server. |

They never interfere with each other, and none of them is a camera operation. `clearAll` blanks all
three at once — in the UI that is a **held** action, never a tap.

---

## 2. Add the browser source

In your first camera scene: **Sources → + → Browser**, name it exactly **`Overlays`**, then set:

| Field | Value | Why |
|---|---|---|
| **URL** | `http://127.0.0.1:7320/overlay` | Verger's Overlay panel shows this same URL; both it and this document read the value from [`../src/shared/net.ts`](../src/shared/net.ts), so they cannot disagree with what the server is actually listening on. Copy it from the panel if in doubt. |
| **Width** | `1920` | Must match your canvas. A 1280-wide browser source scaled up to 1080p makes text visibly soft. |
| **Height** | `1080` | as above |
| **Use custom frame rate** | unticked | The overlay animates in CSS; OBS's canvas FPS is correct. |
| **Custom CSS** | *empty* | OBS pre-fills a transparency snippet here. Clearing it is safe — the overlay page ships its own reset and its own transparent background. **Never put a `background-color` in this box**; that is how you get a black rectangle over the camera. |
| **Shutdown source when not visible** | **OFF** | See below. |
| **Refresh browser when scene becomes active** | **OFF** | See below. |
| **Control audio via OBS** | off | The overlay produces no audio. |
| **Page permissions** | *No access to OBS* (default) | The overlay never needs to command OBS; Verger does that over obs-websocket. |

### Why those two checkboxes must be OFF

Both of them **destroy and recreate the web page on a scene change** — which is precisely the moment
you least want it destroyed.

- **"Shutdown source when not visible"** frees the browser instance whenever the source is not on
  screen. Switch away from a scene and the page dies; switch back and it cold-starts: blank frame,
  new WebSocket connection, then a re-render. Your lower-third flickers or disappears at every camera
  cut.
- **"Refresh browser when scene becomes active"** reloads the page every time you cut to the scene.
  Same result, on the other edge of the transition.

With both OFF, the page loads once when OBS starts and simply keeps running. A camera switch is then
a pure OBS compositing change that the overlay never even observes — which is the entire point of
making the overlay its own layer.

(The state protocol means that even after a forced reload the overlay recovers on its own: it
reconnects, is sent the full current state immediately, and re-renders whatever should be on screen.
That is the safety net for a crash — it is not a reason to leave these checkboxes on and take a
reload at every cut.)

---

## 3. Verify it — in this order

Do this the first time you set the machine up, and again any time you change the OBS scene
collection.

1. **Start Verger.** Open its **Overlay** panel. It shows the server state: running / not running,
   the host and port, the page URL, and **how many overlay clients are attached**. Expect `running`
   and `0 clients` at this point.

2. **Open the URL in a normal browser first**, before involving OBS:
   `http://127.0.0.1:7320/overlay`. You should get a page that looks blank — it is transparent, with
   nothing shown yet — and Verger's Overlay panel should now say **1 client**. If the client count
   stays at 0, the page did not reach the WebSocket and OBS will not do any better; fix that first.

3. **Use debug mode:** `http://127.0.0.1:7320/overlay?debug=1`. This paints a visible frame and
   connection/revision readout on the otherwise-invisible page, so you can confirm the page is alive
   and receiving state. **Never leave `?debug=1` on the OBS source** — it is a development aid, and
   the URL you paste into OBS has no query string.

4. **Fire a test lower-third** from Verger's Overlay panel (type a name and a role, press SHOW).
   It should animate in on the browser tab within a frame or two. Press HIDE; it should animate out.

5. **Now add the browser source to OBS** (§2), share it into every camera scene (§1), and repeat
   step 4 with OBS's preview visible. The client count in Verger goes up by one per *distinct*
   browser instance — if you shared one source correctly, adding it to five scenes still shows one
   additional client, not five.

6. **The switch test — this is the one that matters.** With a lower-third **showing**, switch
   cameras in OBS: CAM 1 → WIDE → CAM 1. The lower-third must stay exactly where it is, un-flickered,
   through every cut. Then hide the lower-third and confirm the camera did not change. Cameras and
   overlays are two independent controls; if either one moves the other, stop and re-check that
   both checkboxes in §2 are OFF and that every scene references the same Overlays source.

7. **The crash test.** With something showing, right-click the Overlays source → **Refresh** (or
   restart OBS entirely). The page reloads, reconnects, and comes back showing the *same* content —
   because the server holds the state and sends a full snapshot on connect. If it comes back blank,
   something is wrong; report it rather than working around it.

---

## 4. Troubleshooting

**The overlay is blank when it should be showing something.**
Work down this list, in order:
- Is **Verger running**? The server dies with the app.
- Does Verger's Overlay panel say **`0 clients`**? Then OBS is not attached at all — either the
  source is missing from this scene, or *Shutdown source when not visible* is ON and shut the page
  down, or the URL is wrong. `0 clients` during a service is the single most useful signal on the
  panel; it means the graphic has nowhere to go.
- Is the source **in this scene**, and is it **above** the camera in the Sources list?
- Is the source's **visibility eye** on, and is its opacity/filters untouched?
- Open `http://127.0.0.1:7320/overlay?debug=1` in a browser to confirm the server is serving and the
  socket connects.

**The overlay shows a black (or coloured) rectangle over the camera.**
A background colour crept in. The page itself is transparent by design, so the culprit is almost
always one of:
- something typed into the browser source's **Custom CSS** box (a `background`, or `background-color`
  on `body`/`html`) — clear it;
- a **colour-correction / LUT / chroma-key filter** left on the source;
- the source was created as a **Colour Source** or an **Image Source** by accident rather than a
  Browser source.

**The overlay does not update — it is stuck on old content.**
The page is a stale instance. Right-click the Overlays source → **Refresh**. It will reconnect and
be sent the current state immediately, so a refresh is always safe: it cannot lose what is currently
supposed to be on screen. If a refresh fixes it every time, check that you are not running several
duplicated copies of the source, one of which lost its connection.

**Port 7320 is already in use.**
Verger's Overlay panel reports the server as not running with the bind error. Something else on this
machine holds the port — most often a previous Verger instance that did not exit cleanly, or a
leftover rhema_v2 process (v2 used 7320 for its remote-control WebSocket; the number was inherited
deliberately rather than inventing a new one). Find it:

```powershell
netstat -ano | findstr :7320      # last column is the PID
tasklist /fi "pid eq <PID>"       # what that PID actually is
```

Close that process and restart Verger. Do **not** work around it by editing the port in one place —
the port is declared once in [`../src/shared/net.ts`](../src/shared/net.ts) and read by the server,
the Overlay panel, and this document; changing it anywhere else guarantees they drift apart.

**The overlay is fine in a browser but not in OBS.**
Almost always the two checkboxes. Re-open the source properties and confirm *Shutdown source when
not visible* and *Refresh browser when scene becomes active* are both unticked.

---

## 5. The rule this setup exists to protect

**Nothing here requires touching OBS during a service.**

Once the Overlays source is in every scene with the right settings, the entire live workflow —
cameras, lower-thirds, scripture, slides — is driven from Verger. You should not be opening source
properties, refreshing browsers, or re-adding sources while the stream is running. If you find
yourself doing that on a Sunday, the setup is wrong, and that is a bug to be fixed here, not a
routine to be learned.

And the standing safety rule behind it (see [`../CLAUDE.md`](../CLAUDE.md), rule 2): **OBS is the
resilient engine, Verger is the convenience layer.** If Verger crashes mid-service, OBS keeps
streaming and recording, and you can still switch cameras by hand in OBS. You lose the overlay
controls until Verger is relaunched — you do not lose the service.
