/**
 * Verger overlay page — the client half of the overlay bus.
 *
 * Plain ES2022 module, loaded directly by Chromium inside an OBS Browser Source. No bundler, no
 * npm, no framework (see overlay.html for why).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL DESIGN RULE: this page renders STATE, never EVENTS.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The server owns the overlay state. Every message on the `state` channel is a COMPLETE
 * `OverlayState` snapshot, and one is sent immediately on connect. `render()` below is therefore
 * a pure function of that snapshot: it sets each layer's content and visibility from the state it
 * was handed, and it never diffs, never accumulates, and never reacts to "show" or "hide" as an
 * action.
 *
 * That is what makes an OBS browser source survivable. A source can be reloaded by the operator,
 * hidden and re-shown by a scene change, or crash outright — during a service, with nobody
 * watching. An event-stream client would come back BLANK, having missed everything that happened
 * while it was gone. This one reconnects, receives the current snapshot, and re-renders exactly
 * what should be on screen. Resync is not a recovery path; it is the only path, exercised on
 * every single connect.
 *
 * The corollary, and it matters: NO STATE IS CACHED ACROSS A DISCONNECT. There is no local copy
 * of the snapshot to replay, because a replayed snapshot could be minutes stale and would be
 * indistinguishable from a fresh one. What is on screen stays on screen (see below); what gets
 * rendered next always comes from the server.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND: A SOCKET ERROR NEVER BLANKS THE OUTPUT.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * If the connection drops, this page keeps displaying whatever it last rendered and reconnects
 * forever in the background. It does not clear the layers, does not show a "disconnected" banner,
 * and does not draw anything the congregation would notice. A lower-third frozen on screen is a
 * cosmetic problem the operator can fix; a screen that blanks itself mid-sermon because a
 * WebSocket hiccuped is a broadcast failure. Standing Rule 6, applied to the output surface — the
 * operator is told about connection trouble in the CONTROL app, never on the projection.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND: THIS PAGE MAKES SOUND.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The slide layer plays VIDEO, with audio, when a cue's asset is a clip (`renderSlide` below).
 * Two things follow. First, the Browser Source needs *Control audio via OBS* enabled or the clip's
 * audio never reaches the stream mix — see README.md. Second, and this is the rule that governs
 * the code: HIDING THE LAYER MUST STOP THE CLIP, not merely make it invisible. A hidden video that
 * keeps playing keeps sending audio to the congregation after the operator has taken it off screen,
 * which is a fault they can hear and cannot see. `releaseSlideVideo()` is where that is enforced.
 */

import { validateServerMessage } from './protocol.js'

// ---------------------------------------------------------------------------------------------
// Connection parameters
// ---------------------------------------------------------------------------------------------

/**
 * Mirrors `OVERLAY_SOCKET_PATH` in `src/shared/net.ts`. The PORT is deliberately not mirrored:
 * it is derived from `location` instead, so the page keeps working if the server had to fall back
 * to another port, or if the operator opted into a LAN bind and OBS is loading this over the
 * machine's LAN address rather than 127.0.0.1.
 */
const SOCKET_PATH = '/ws'

/** Reconnect backoff: ~250ms on the first retry, doubling-ish to a 10s ceiling, forever. */
const BACKOFF_MIN_MS = 250
const BACKOFF_MAX_MS = 10_000
const BACKOFF_FACTOR = 1.8

/**
 * ±25% jitter. Verger normally has exactly one overlay, but a multi-output venue can have
 * several (main screen, lobby, stage display) all pointed at the same server. Without jitter they
 * would reconnect in lockstep after a Verger restart and hammer the socket in synchronised waves.
 */
const BACKOFF_JITTER = 0.25

/**
 * If nothing at all arrives for this long — not a snapshot, not a ping — the connection is
 * treated as dead and torn down so the backoff loop can rebuild it. A TCP socket to a machine
 * that went to sleep or a process that was SIGKILLed can sit "open" indefinitely without ever
 * firing `close`; this is the only thing that notices.
 */
const STALE_AFTER_MS = 45_000

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------

const el = {
  lowerThird: document.getElementById('lower-third'),
  ltLine1: document.getElementById('lower-third-line1'),
  ltLine2: document.getElementById('lower-third-line2'),

  scripture: document.getElementById('scripture'),
  scriptureText: document.getElementById('scripture-text'),
  scriptureReference: document.getElementById('scripture-reference'),
  scriptureTranslation: document.getElementById('scripture-translation'),
  scriptureAttribution: document.getElementById('scripture-attribution'),

  slide: document.getElementById('slide'),
  slideFrames: Array.from(document.querySelectorAll('.slide__frame')),
  slideVideo: document.querySelector('.slide__video'),

  debug: document.getElementById('debug'),
  debugSocket: document.getElementById('debug-socket'),
  debugStatus: document.getElementById('debug-status'),
  debugRevision: document.getElementById('debug-revision'),
  debugVideo: document.getElementById('debug-video'),
  debugNote: document.getElementById('debug-note'),
}

// ---------------------------------------------------------------------------------------------
// Debug HUD — `?debug=1`, off by default
// ---------------------------------------------------------------------------------------------

const debugEnabled = new URLSearchParams(window.location.search).get('debug') === '1'

if (debugEnabled && el.debug) el.debug.hidden = false

/** @param {'connecting'|'open'|'closed'} status @param {string} [note] */
function setDebugStatus(status, note) {
  if (!debugEnabled) return
  if (el.debugStatus) {
    el.debugStatus.textContent = status
    el.debugStatus.dataset.status = status
  }
  if (note !== undefined && el.debugNote) el.debugNote.textContent = note
}

/** @param {number|null} revision */
function setDebugRevision(revision) {
  if (!debugEnabled || !el.debugRevision) return
  el.debugRevision.textContent = revision === null ? '—' : String(revision)
}

/**
 * Report what the slide video is actually doing.
 *
 * This is the only place a "playing but silent" clip is distinguishable from a "loaded but frozen"
 * one — on the projector both look like a picture, and one of them is a service that lost its
 * audio. The state drives a colour (overlay.css) so it is readable at a glance in a dark booth.
 *
 * @param {string} note
 * @param {'idle'|'audio'|'muted'|'blocked'} state
 */
function setDebugVideo(note, state) {
  if (!debugEnabled || !el.debugVideo) return
  el.debugVideo.textContent = note
  el.debugVideo.dataset.video = state
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/*
 * Everything below writes with `textContent`. NEVER `innerHTML`, and there is no exception worth
 * making: `scripture.text` comes off a Bible API, `lowerThird.line1` is typed by an operator or
 * pulled from a service plan, and `slide.src` is a path from the control app. Markup smuggled
 * into any of those must land on screen as literal characters, not as an element. This page is
 * live on a public broadcast; it is not the place to find out that a name field was reflected.
 */

/** @param {HTMLElement|null} node @param {string} value */
function setText(node, value) {
  if (node) node.textContent = value
}

/**
 * Text that disappears entirely when empty, rather than leaving a gap in the layout — an absent
 * second line or a public-domain text with no attribution should collapse, not reserve space.
 *
 * @param {HTMLElement|null} node @param {string} value
 */
function setOptionalText(node, value) {
  if (!node) return
  node.textContent = value
  node.hidden = value.length === 0
}

/** @param {HTMLElement|null} layer @param {boolean} visible */
function setLayerVisible(layer, visible) {
  if (!layer) return
  layer.classList.toggle('is-visible', visible)
  layer.setAttribute('aria-hidden', visible ? 'false' : 'true')
}

/*
 * Content is written only while a layer is (or is becoming) visible.
 *
 * Not an optimisation — a correctness detail. `clearAll` resets the text fields AND clears
 * `visible` in the same snapshot, so writing content unconditionally would blank the words a
 * frame before the exit animation started, and the layer would appear to fade out empty. A
 * hidden layer's DOM contents are invisible by definition, so leaving them stale costs nothing,
 * and the next `show` snapshot always rewrites them before the layer comes back.
 */

/** @param {{visible: boolean, line1: string, line2: string, template: string}} lowerThird */
function renderLowerThird(lowerThird) {
  if (lowerThird.visible) {
    // `template` is already clamped to a known value by protocol.js, so this can only ever set a
    // selector that overlay.css actually implements.
    el.lowerThird?.setAttribute('data-template', lowerThird.template)
    setText(el.ltLine1, lowerThird.line1)
    setOptionalText(el.ltLine2, lowerThird.line2)
  }
  setLayerVisible(el.lowerThird, lowerThird.visible)
}

/** @param {{visible: boolean, reference: string, text: string, translation: string, attribution: string|null}} scripture */
function renderScripture(scripture) {
  if (scripture.visible) {
    setText(el.scriptureText, scripture.text)
    setText(el.scriptureReference, scripture.reference)
    setOptionalText(el.scriptureTranslation, scripture.translation)
    setOptionalText(el.scriptureAttribution, scripture.attribution ?? '')
  }
  setLayerVisible(el.scripture, scripture.visible)
}

/**
 * Extensions the slide layer treats as VIDEO rather than as a still.
 *
 * Mirrors `VIDEO_EXTENSIONS` in `src/main/plan/assetImport.ts` — the list the importer accepts —
 * and must change with it, for exactly the reason `protocol.js` mirrors `src/shared/overlay.ts`:
 * this page cannot import from `src/`.
 *
 * The PROTOCOL deliberately does not carry a kind. `SlideState` is still `{visible, src}`, because
 * a slide is a slide whether it is a still or a clip; deciding from the extension here leaves the
 * wire format, the reducer and every existing test untouched, and means a plan authored before
 * video existed needs no migration.
 *
 * Membership is not a promise that Chromium can DECODE the file. `.mkv`, and `.mov` carrying
 * anything other than H.264/AAC, are routinely rejected by CEF even though the importer accepted
 * them. That failure is not silent: the element fires `error`, and the handler below leaves whatever
 * was on air exactly where it is and says so on the debug HUD.
 */
const VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.webm', '.m4v', '.mov', '.mkv'])

/**
 * `?query` and `#hash` are stripped before the extension is read. A cache-busting suffix on an
 * asset URL must not demote a clip to a still and land a 200 MB video file in an `<img>`.
 *
 * @param {string} src
 * @returns {boolean}
 */
function isVideoSource(src) {
  const withoutQuery = src.split(/[?#]/)[0] ?? ''
  const lower = withoutQuery.toLowerCase()
  return VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * The image currently committed to the active frame, or null when the frames hold NOTHING — which
 * is the case once a clip has taken the layer over. Held only so a repeated identical snapshot
 * (every ping-adjacent rebroadcast, every reconnect) does not re-request the file and re-run the
 * cross-fade. Reset on disconnect so a reconnect always re-verifies what is on screen.
 *
 * @type {string|null}
 */
let committedSlideSrc = null

/**
 * The clip currently attached to the `<video>` element, or null when the element has been released
 * and holds no resource at all. This is the "is a decoder open" flag: it is what makes
 * `releaseSlideVideo()` idempotent, and what tells the media event handlers whether the event they
 * are seeing belongs to a clip that still matters.
 *
 * @type {string|null}
 */
let attachedVideoSrc = null

/**
 * The slide layer renders EITHER a still or a clip, chosen from the src's extension.
 *
 * The two paths are mutually exclusive in the same call on purpose: whichever kind is not being
 * shown is torn down before the other is put up. So a still can never linger in a clip's
 * transparent letterbox bars, and — the one that actually matters — a clip can never keep playing,
 * or keep SOUNDING, behind a still or behind a hidden layer.
 *
 * @param {{visible: boolean, src: string}} slide
 */
function renderSlide(slide) {
  const hasContent = slide.visible && slide.src.length > 0

  if (hasContent && isVideoSource(slide.src)) {
    startSlideVideo(slide.src)
  } else {
    releaseSlideVideo()
    if (hasContent && slide.src !== committedSlideSrc) crossFadeSlide(slide.src)
  }

  setLayerVisible(el.slide, hasContent)
}

/**
 * Load `src` into the video element and play it from the top.
 *
 * WHAT COUNTS AS A NEW START, and why it is not "every snapshot naming a clip": re-firing a cue
 * means "play it again" to an operator, but this protocol cannot say that. `slide.show` with an
 * unchanged `src` yields a snapshot whose `slide` is byte-identical to the previous one — and so
 * does every UNRELATED mutation, because showing a lower-third bumps `revision` and rebroadcasts
 * the whole state. A page that restarted whenever it saw the same clip again would therefore jump
 * a clip back to zero, audio and all, because the operator captioned the speaker. It would also do
 * it once per snapshot for the rest of the service.
 *
 * So the rule is: a start happens when the element is not already holding this exact clip. In
 * practice that is every case an operator can observe as a re-fire, because hiding the layer
 * RELEASES the clip (see `releaseSlideVideo`) — hide/show is both the replay and the retry. The one
 * case not covered is re-firing a clip that is still mid-play, which is a no-op; distinguishing it
 * would need a field on `SlideState` that does not exist, and guessing is worse than not acting.
 *
 * @param {string} src
 */
function startSlideVideo(src) {
  const video = el.slideVideo
  if (!video) {
    // Degrade, never throw: an overlay.html predating the video element still renders stills, and
    // the operator gets told why on the HUD instead of watching a cue do nothing.
    console.error('[verger-overlay] no slide video element; cannot play', src)
    setDebugVideo('no element', 'blocked')
    setDebugStatus(socketStatus, 'no video element')
    return
  }

  if (attachedVideoSrc === src) return

  attachedVideoSrc = src
  video.classList.remove('is-active')
  // Same-origin only in practice: `media-src 'self'` in the page CSP blocks a clip on a remote
  // host before a request leaves the machine.
  video.src = src
  playSlideVideo(video, src)
}

/**
 * Play from the start, WITH AUDIO, falling back to muted rather than to a frozen frame.
 *
 * A service clip is useless silent, so audio is always asked for first. But Chromium refuses
 * autoplay-with-audio until the page has had a user gesture, and an OBS Browser Source can never
 * have one — nobody clicks the congregation screen. OBS launches its embedded Chromium with
 * `--autoplay-policy=no-user-gesture-required`, so in the place that matters the first attempt
 * succeeds; a plain browser tab (an operator checking the URL during setup) may refuse it.
 *
 * `play()` reports that refusal by REJECTING its promise, and swallowing the rejection produces the
 * worst possible outcome: a clip that is loaded, visible and frozen on frame one, with nothing
 * anywhere saying why. So a rejection retries ONCE muted — a clip that plays silently is a fault
 * the operator can hear and recover from, a clip that never starts is not — and both outcomes go to
 * the debug HUD so `?debug=1` tells "no audio" apart from "not playing at all".
 *
 * Audio is requested again on every start rather than remembering the fallback: the gesture
 * requirement is a property of the page's lifetime, not of the file, so a tab that has since been
 * clicked can play the next clip with sound.
 *
 * @param {HTMLVideoElement} video @param {string} src
 */
function playSlideVideo(video, src) {
  // A cue plays, it never resumes. Assigning `src` has already rewound the element; stating it
  // keeps the rule true if this is ever reached with the same file still attached.
  video.currentTime = 0
  attemptPlayback(video, src, false)
}

/**
 * One `play()` attempt. Recurses exactly once, muted, and never again.
 *
 * @param {HTMLVideoElement} video @param {string} src @param {boolean} muted
 */
function attemptPlayback(video, src, muted) {
  video.muted = muted
  const started = video.play()

  // Pre-promise implementations return undefined. Unreachable in CEF and in any current browser,
  // but reporting optimistically beats reporting a state we did not observe.
  if (!started || typeof started.then !== 'function') {
    setDebugVideo(muted ? 'playing (muted)' : 'playing + audio', muted ? 'muted' : 'audio')
    return
  }

  started.then(
    () => {
      // A newer cue owns the element now; its own attempt reports for itself.
      if (attachedVideoSrc !== src) return
      setDebugVideo(muted ? 'playing (muted)' : 'playing + audio', muted ? 'muted' : 'audio')
    },
    (error) => {
      if (attachedVideoSrc !== src) return
      if (!muted) {
        console.warn('[verger-overlay] autoplay with audio refused, retrying muted:', error)
        setDebugVideo('retrying muted', 'muted')
        attemptPlayback(video, src, true)
        return
      }
      console.error('[verger-overlay] slide video will not play:', src, error)
      setDebugVideo('will not play', 'blocked')
      setDebugStatus(socketStatus, 'video blocked')
    }
  )
}

/**
 * Stop the clip and LET GO of the file: pause, detach, load nothing.
 *
 * "Make the layer invisible" is not an acceptable substitute for this, and it is the single worst
 * bug this file can have. A `<video>` that is merely hidden keeps playing, and its audio keeps
 * going out to the congregation and the stream after the operator has hidden it — a video they can
 * hear but cannot see, with no obvious way to make it stop. Standing Rule 1: the human's hide has
 * to actually stop it.
 *
 * `pause()` silences it within this same task. Removing the `src` ATTRIBUTE and then calling
 * `load()` is what releases the resource: the element re-runs its load algorithm, finds no source,
 * aborts any download still in flight and drops the decoder. `src = ''` would instead resolve
 * against the page URL and set the element loading the HTML document.
 *
 * The cost is that the last frame vanishes at once instead of dissolving out with the layer.
 * Silence within a frame is worth more than 300 ms of dissolve, and deferring the release to the
 * end of the fade would mean a timer — which, the one time it is dropped, leaves a clip playing.
 *
 * Idempotent: called on every snapshot in which the slide layer is not a visible clip.
 */
function releaseSlideVideo() {
  const video = el.slideVideo
  if (!video || attachedVideoSrc === null) return

  attachedVideoSrc = null
  video.classList.remove('is-active')
  video.pause()
  video.removeAttribute('src')
  video.load()
  setDebugVideo('—', 'idle')
}

/**
 * Detach both cross-fade frames, so nothing of the outgoing still survives behind a clip.
 *
 * Frames and video all use `object-fit: contain`, so a clip that is not the canvas aspect leaves
 * TRANSPARENT letterbox bars — and a still left loaded underneath would show through them: half a
 * slide framing a video, on air. `committedSlideSrc` is cleared with them because it is the record
 * of what the frames hold, and it must never claim an image that is no longer there.
 *
 * Removing the `src` attribute (never `src = ''`, which requests the page itself) is what empties
 * an `<img>`; the pending handlers go too, so a load that was already in flight cannot fade its
 * frame back in afterwards.
 */
function clearSlideFrames() {
  committedSlideSrc = null
  for (const frame of el.slideFrames) {
    frame.onload = null
    frame.onerror = null
    frame.classList.remove('is-active')
    frame.removeAttribute('src')
  }
}

/**
 * Load `src` into whichever frame is idle and only swap once it has decoded, so the transition is
 * a genuine dissolve. If the image fails to load the swap never happens and the previous slide
 * stays up — a 404 must not punch a transparent hole in the broadcast.
 *
 * @param {string} src
 */
function crossFadeSlide(src) {
  const [a, b] = el.slideFrames
  if (!a || !b) return

  const outgoing = a.classList.contains('is-active') ? a : b
  const incoming = outgoing === a ? b : a

  committedSlideSrc = src

  incoming.onload = () => {
    // A newer slide may have been requested while this one was loading; that request owns the
    // frames now, so this stale load must not steal them back.
    if (committedSlideSrc !== src) return
    incoming.classList.add('is-active')
    outgoing.classList.remove('is-active')
  }

  incoming.onerror = () => {
    if (committedSlideSrc !== src) return
    committedSlideSrc = null // let a retry of the same src be attempted again
    console.warn('[verger-overlay] slide image failed to load:', src)
    setDebugStatus(socketStatus, 'slide load failed')
  }

  // Same-origin only in practice: the CSP `img-src 'self' data: blob:` means a `src` pointing at
  // a remote host is blocked by the browser before a request leaves the machine.
  incoming.src = src
}

/*
 * The video's own events, bound once.
 *
 * The visual hand-off is on `loadeddata`, NOT on `playing`. The moment a first frame exists the clip
 * is the slide, and whatever still was on the layer has become the wrong content — so it goes, even
 * if playback itself was refused. Gating the hand-off on `playing` instead would leave the previous
 * slide on air whenever autoplay was blocked, which is broadcasting the wrong thing in order to
 * avoid broadcasting a silent one. What is on screen tracks the CUE; whether it is playing, and
 * whether it has sound, is reported on the HUD.
 *
 * Every handler checks `attachedVideoSrc` first: a released element fires its own tail of events
 * (Chromium's `load()` on an empty source among them), and none of those may touch the layer.
 */
if (el.slideVideo) {
  el.slideVideo.addEventListener('loadeddata', () => {
    if (attachedVideoSrc === null || !el.slideVideo) return
    el.slideVideo.classList.add('is-active')
    clearSlideFrames()
  })

  el.slideVideo.addEventListener('error', () => {
    if (attachedVideoSrc === null || !el.slideVideo) return
    // Deliberately NOT cleared the way a failed image is. `crossFadeSlide` nulls its committed src
    // so a retry can happen on the next snapshot, which for a few-hundred-KiB still is free; doing
    // that here would re-request a file that can be hundreds of megabytes, once per snapshot, for
    // the rest of the service. The clip stays attached and inert, and the operator's hide/show is
    // the retry. Whatever was already on the layer is left exactly where it is — an undecodable
    // file must not punch a transparent hole in the broadcast.
    el.slideVideo.classList.remove('is-active')
    // `code` 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) is the one an operator will actually hit: the file
    // arrived intact and Chromium cannot decode that container or codec. Both fields are logged
    // because the message is the part that names which.
    const reason = el.slideVideo.error
    console.warn(
      '[verger-overlay] slide video failed to load:',
      attachedVideoSrc,
      reason?.code,
      reason?.message
    )
    setDebugVideo('load failed', 'blocked')
    setDebugStatus(socketStatus, 'slide video failed')
  })

  el.slideVideo.addEventListener('ended', () => {
    if (attachedVideoSrc === null) return
    // The last frame stays on screen and the layer stays up. The SERVER owns visibility, and this
    // page never mutates state — an overlay that hid itself at the end of a clip would be inventing
    // a `slide.hide` the operator did not issue, and the next snapshot would put it straight back.
    setDebugVideo('ended', 'idle')
  })
}

/** @param {ReturnType<typeof import('./protocol.js').emptyOverlayState>} state */
function render(state) {
  renderLowerThird(state.lowerThird)
  renderScripture(state.scripture)
  renderSlide(state.slide)
}

// ---------------------------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------------------------

/** @type {WebSocket|null} */
let socket = null
/** @type {number|null} */
let reconnectTimer = null
/** @type {number|null} */
let staleTimer = null
let attempt = 0
/** @type {'connecting'|'open'|'closed'} */
let socketStatus = 'closed'

/**
 * Derived from `location`, never hardcoded — see the note on SOCKET_PATH. Whatever origin served
 * this page is the origin that owns its state.
 *
 * @returns {string|null} null if the page was not served over http(s) (e.g. opened from disk).
 */
function socketUrl() {
  const { protocol, host } = window.location
  if (!host) return null
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${SOCKET_PATH}`
}

/** @param {object} message */
function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
  }
}

function clearStaleTimer() {
  if (staleTimer !== null) {
    window.clearTimeout(staleTimer)
    staleTimer = null
  }
}

/** Restarted by every inbound frame; firing it means the peer has gone quiet. */
function armStaleTimer() {
  clearStaleTimer()
  staleTimer = window.setTimeout(() => {
    console.warn('[verger-overlay] no traffic for', STALE_AFTER_MS, 'ms — recycling socket')
    setDebugStatus(socketStatus, 'stale, recycling')
    socket?.close()
  }, STALE_AFTER_MS)
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * BACKOFF_FACTOR ** attempt)
  const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER
  const delay = Math.max(BACKOFF_MIN_MS, Math.round(ceiling * jitter))
  attempt += 1

  setDebugStatus('closed', `retry in ${delay}ms`)
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function connect() {
  const url = socketUrl()
  if (url === null) {
    // Nothing to retry against — this only happens if the page was opened from the filesystem.
    setDebugStatus('closed', 'no origin: serve over http')
    console.error('[verger-overlay] page must be served over http(s); it has no socket origin')
    return
  }

  if (debugEnabled && el.debugSocket) el.debugSocket.textContent = url

  socketStatus = 'connecting'
  setDebugStatus('connecting', url)

  let ws
  try {
    ws = new WebSocket(url)
  } catch (error) {
    // Constructing a WebSocket can throw synchronously (blocked by CSP, malformed URL). Treat it
    // exactly like a failed connection: back off and try again. Nothing on screen changes.
    console.error('[verger-overlay] could not open socket:', error)
    scheduleReconnect()
    return
  }
  socket = ws

  ws.addEventListener('open', () => {
    socketStatus = 'open'
    attempt = 0 // a successful connect resets the backoff ladder
    setDebugStatus('open', 'awaiting snapshot')
    armStaleTimer()

    send({
      channel: 'hello',
      payload: { page: 'overlay', userAgent: navigator.userAgent.slice(0, 500) },
    })
    // No state is requested and none is replayed: the server sends a full snapshot on connect.
  })

  ws.addEventListener('message', (event) => {
    armStaleTimer()
    handleFrame(event.data)
  })

  ws.addEventListener('error', () => {
    // Deliberately empty of any visual effect. `close` follows and drives the reconnect; the
    // layers are not touched, so whatever is on air stays on air.
    console.warn('[verger-overlay] socket error')
  })

  ws.addEventListener('close', () => {
    socketStatus = 'closed'
    socket = null
    clearStaleTimer()
    committedSlideSrc = null
    // A PLAYING CLIP is deliberately left alone here — not released, not paused, not rewound. The
    // output surface does not react to connection trouble (see the header): a socket hiccup must not
    // cut the audio out of a clip that is on air, and it must not restart one either. Only a
    // snapshot moves the slide layer, and the reconnect brings one.
    setDebugRevision(null)
    scheduleReconnect()
  })
}

/** @param {unknown} data */
function handleFrame(data) {
  if (typeof data !== 'string') {
    console.warn('[verger-overlay] ignoring non-text frame')
    return
  }

  let parsed
  try {
    parsed = JSON.parse(data)
  } catch {
    console.warn('[verger-overlay] ignoring unparseable frame')
    setDebugStatus(socketStatus, 'bad JSON')
    return
  }

  const result = validateServerMessage(parsed)
  if (!result.ok) {
    console.warn('[verger-overlay] rejected message:', result.code, result.detail)
    setDebugStatus(socketStatus, `rejected ${result.code}`)
    return
  }

  const message = result.message
  switch (message.channel) {
    case 'state': {
      render(message.payload)
      setDebugRevision(message.payload.revision)
      setDebugStatus('open', 'rendered')
      // Echo the revision back so the control app can show "overlay is N revisions behind"
      // instead of quietly diverging from what the congregation sees.
      send({ channel: 'applied', payload: { revision: message.payload.revision } })
      break
    }

    case 'ping':
      send({ channel: 'pong', payload: { ts: message.payload.ts } })
      break

    case 'error':
      // Server-side problem. It belongs in the operator's console, not on the projector.
      console.warn('[verger-overlay] server error:', message.payload.code, message.payload.message)
      setDebugStatus(socketStatus, `server: ${message.payload.code}`)
      break

    default:
      break
  }
}

connect()
