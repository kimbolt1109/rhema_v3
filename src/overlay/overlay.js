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

  debug: document.getElementById('debug'),
  debugSocket: document.getElementById('debug-socket'),
  debugStatus: document.getElementById('debug-status'),
  debugRevision: document.getElementById('debug-revision'),
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
 * The image currently committed to the active frame. Held only so a repeated identical snapshot
 * (every ping-adjacent rebroadcast, every reconnect) does not re-request the file and re-run the
 * cross-fade. Reset on disconnect so a reconnect always re-verifies what is on screen.
 *
 * @type {string|null}
 */
let committedSlideSrc = null

/** @param {{visible: boolean, src: string}} slide */
function renderSlide(slide) {
  const hasImage = slide.visible && slide.src.length > 0
  if (hasImage && slide.src !== committedSlideSrc) crossFadeSlide(slide.src)
  setLayerVisible(el.slide, hasImage)
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
