# `src/overlay/` — the OBS browser-source page

This directory is **what the congregation sees**. The overlay server (`src/main/overlay/`) serves
these files verbatim at `http://127.0.0.1:7320/overlay`, OBS loads that URL as a **Browser
Source** layered on top of the camera in every scene, and OBS composites the page over the live
video using its alpha channel.

| File | Role |
| --- | --- |
| `overlay.html` | The page. Three sibling layer containers + the CSP. |
| `overlay.css` | Broadcast styling, layer animations, the three lower-third templates. |
| `overlay.js` | WebSocket client, declarative renderer, reconnect loop. |
| `protocol.js` | Hand-kept JS mirror of `src/shared/overlay.ts`. |

---

## Why there is no framework, no bundler, and no TypeScript here

Everything else in Verger is TypeScript compiled by electron-vite. This directory deliberately is
not. These are plain static files that Chromium runs as-is.

- **This is the output surface.** It is on air during the one hour a week that cannot be retried.
  A build step is another thing that can break between Saturday night and Sunday morning, and it
  would break in a way the operator cannot diagnose or work around.
- **The page has one job**: set text and toggle classes from a snapshot. React would be more code
  than the thing it renders, and its reconciliation buys nothing over ~15 lines of
  `textContent` + `classList.toggle`.
- **It must run with no network.** No CDN, no webfont, no npm — an OBS booth is frequently offline
  and often has no route to anything but the machine it is running on.
- **It is trivially debuggable.** Right-click the Browser Source → *Interact* → the source you see
  in DevTools is the source in this folder, unminified, with its comments.

The cost of that choice is that the page cannot `import` from `src/shared/`. Hence `protocol.js`.

## `protocol.js` mirrors `src/shared/overlay.ts` — change them together

`src/shared/overlay.ts` is the single source of truth for the overlay protocol. `protocol.js`
duplicates, by hand, only the parts the page needs: the layer names, the template names, the empty
state, and a defensive `validateServerMessage()`.

**If you change the protocol in `src/shared/overlay.ts`, you must update `protocol.js` in the same
commit.** Its header comment restates the full `OverlayState` shape specifically so the two files
can be diffed by eye. Nothing enforces this automatically — which is exactly why the mirror is
kept as small as it is. Do not grow it: the command names, the payload schemas, and the reducer
all stay server-side and are not mirrored, because the page never issues commands.

## State, not events

The server owns the state. Every `state` message is a **complete `OverlayState` snapshot**, and
one is sent immediately on connect. `overlay.js` renders each layer purely from that snapshot and
never from a "show"/"hide" action.

That is what makes the page survivable. A Browser Source can be reloaded, hidden by a scene
change, or crash, mid-service, with nobody watching. An event-driven client would come back blank
having missed everything. This one reconnects, gets the current snapshot, and re-renders exactly
what should be on screen. **Resync is not a recovery path — it is the only path**, exercised on
every connect.

Two consequences worth knowing before you edit `overlay.js`:

- **No state is cached across a disconnect.** There is nothing local to replay, and a replayed
  snapshot could be minutes stale.
- **A socket error never blanks the output.** On disconnect the page keeps showing what it last
  rendered and reconnects forever (~250 ms → 10 s, exponential with ±25 % jitter). It shows no
  banner and draws nothing the congregation would notice. Connection trouble is reported to the
  operator in the **control app**, never on the projection — Standing Rule 6.

---

## OBS Browser Source settings

Add this **once per scene that has a camera in it**, or add it once and copy-reference it into the
other scenes so all of them share a single source.

| Setting | Value | Why |
| --- | --- | --- |
| **URL** | `http://127.0.0.1:7320/overlay` | The exact URL is also shown in Verger's Overlay panel — paste it from there rather than typing it, so it can never disagree with the port the server actually bound. |
| **Width** | `1920` | Match the canvas resolution. |
| **Height** | `1080` | Match the canvas resolution. |
| **Use custom frame rate** | off (inherit) | 30 fps is plenty for CSS transitions; there is nothing to gain from 60. |
| **Custom CSS** | leave OBS's default | OBS pre-fills a rule that forces a transparent body. Harmless — `overlay.css` sets that itself and does not depend on it. Do **not** paste a `background-color` in here. |
| **Shutdown source when not visible** | **OFF** | With it on, OBS tears the page down on every scene change and rebuilds it on the way back — the overlay would flicker on each camera cut. |
| **Refresh browser when scene becomes active** | **OFF** | Same reason. The page would reload on every cut. It *would* resync correctly (that is the whole design), but it would visibly re-animate every layer while doing so. |
| **Control audio via OBS** | off | The page has no audio. |
| **Page permissions** | default / "No access to OBS" | The page needs nothing from OBS. |

Then, in **every** camera scene:

```
Sources (top of the list wins)
  ┌ Overlays   ← this Browser Source, ALWAYS on top
  └ Camera 1 / Camera 2 / Wide / Pulpit …
```

The Overlays source must sit **above** the camera sources in the list. That layering is the whole
point (BLUEPRINT.md §6): because the overlay is its own layer, **switching cameras never touches
it, and showing a lower-third never touches the camera.**

### If the overlay blacks out the video

Something has given the page an opaque background. Check, in order: OBS's *Custom CSS* field for a
`background-color`, and the first rule in `overlay.css` (`html, body { background: transparent }`),
which must never be overridden. A `#000` background is just as fatal as a white one — OBS
composites on alpha, and black is fully opaque.

---

## Testing the page in a normal browser

With Verger running:

```
http://127.0.0.1:7320/overlay?debug=1
```

`?debug=1` shows a small HUD in the top-left corner with the socket URL, connection state, the
last-applied revision, and the last notable event. It is **off by default** so an operator who
pastes the plain URL into OBS can never accidentally broadcast diagnostics. Never leave `?debug=1`
on the URL that OBS uses.

Things to know while testing in a browser tab:

- **The page will look white.** That is correct. A transparent page composites over whatever is
  behind it, and in a browser tab that is the browser's own white canvas. Only OBS puts the camera
  there. Judging contrast in a browser tab is misleading — check legibility in OBS, over a real
  camera image with the stage lights on.
- **Drive it from Verger's Overlay panel**, which fires real commands (`lowerThird.show`,
  `scripture.show`, `slide.show`, `clearAll`) at the server. The page has no controls of its own
  and cannot send commands; it only ever renders what the server tells it.
- **Verify the resync behaviour**, because it is the property that matters most: show a
  lower-third, then hard-reload the page (Ctrl+F5, or *Refresh* on the Browser Source). It must
  come back with the lower-third still up, animating in from the snapshot. Then quit Verger with
  the page open — the layers must stay exactly as they were, and the page must reconnect on its
  own when Verger starts again.
- **Reduced motion** is honoured: with the OS "reduce motion" setting on, layers cross-fade in
  place instead of sliding.

## The three lower-third templates

Selected by `lowerThird.template` on the state snapshot, applied as `data-template` on
`#lower-third`, and implemented entirely in `overlay.css`:

- **`bar`** — full-bleed band with a hard accent edge. The default, and the most legible over an
  unknown or busy camera image.
- **`boxed`** — a contained card with an accent underline. Leaves more of the frame visible; suits
  a static wide shot.
- **`minimal`** — no panel at all, just the name over a short accent rule, carried by its text
  shadow. The lightest touch, for a clean background.

Adding a fourth means adding it to `LOWER_THIRD_TEMPLATES` in **both** `src/shared/overlay.ts` and
`protocol.js`, plus a `[data-template="…"]` block here.

## House rules for editing these files

1. `html, body { background: transparent }` is non-negotiable. See above.
2. Render with `textContent`, **never** `innerHTML`. Scripture text and speaker names come from an
   API and an operator's keyboard; markup in either must land on screen as literal characters.
3. Animate `transform` and `opacity` only, never `display` — `display` cannot be transitioned, so a
   layer toggled that way pops instead of animating.
4. No external asset of any kind: no webfont, no CDN, no remote image. The CSP in `overlay.html`
   enforces this, and it should stay that way.
5. Never author Bible verse text or song lyrics into these files, including as placeholder content
   (Standing Rule 4). Every string on screen arrives at runtime.
