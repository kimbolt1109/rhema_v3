/**
 * ============================================================================================
 *  THIS FILE MIRRORS `src/shared/overlay.ts`. THE TWO MUST CHANGE TOGETHER.
 * ============================================================================================
 *
 * `src/shared/overlay.ts` is the single source of truth for the overlay protocol. It cannot be
 * imported here: the overlay page is plain static files served to an OBS Browser Source, with
 * no bundler and no TypeScript, so the handful of names the page actually needs are duplicated
 * by hand — below, and nowhere else in `src/overlay/`.
 *
 * Keep this file MINIMAL. Everything duplicated is something that can silently drift. The
 * reducer, the command schemas, and the command names all live server-side and are deliberately
 * NOT mirrored: the page never issues commands, it only renders snapshots.
 *
 * The shape being mirrored, so a future reader can diff the two by eye:
 *
 *   OverlayState {
 *     lowerThird { visible: boolean, line1: string, line2: string, template: 'bar'|'boxed'|'minimal' }
 *     scripture  { visible: boolean, reference: string, text: string, translation: string,
 *                  attribution: string | null }
 *     slide      { visible: boolean, src: string }
 *     revision   : number
 *   }
 *
 *   OverlayServerMessage (server -> page)
 *     | { channel: 'state', payload: OverlayState }
 *     | { channel: 'ping',  payload: { ts: number } }
 *     | { channel: 'error', payload: { code: string, message: string } }
 *
 *   OverlayClientMessage (page -> server)
 *     | { channel: 'hello',   payload: { page: string, userAgent: string } }
 *     | { channel: 'applied', payload: { revision: number } }
 *     | { channel: 'pong',    payload: { ts: number } }
 *
 * WHEN YOU CHANGE `src/shared/overlay.ts`: update the block above, the two frozen arrays, and
 * `normaliseState` below. `src/main/overlay/*.test.ts` guards the server side; nothing can guard
 * this file automatically, which is exactly why it stays this small.
 */

/** Mirror of `OVERLAY_LAYERS`. */
export const OVERLAY_LAYERS = Object.freeze(['lowerThird', 'scripture', 'slide'])

/** Mirror of `LOWER_THIRD_TEMPLATES`. The CSS for each lives in `overlay.css`. */
export const LOWER_THIRD_TEMPLATES = Object.freeze(['bar', 'boxed', 'minimal'])

/** Mirror of `emptyOverlayState()` — every layer hidden. Used as the normaliser's floor. */
export function emptyOverlayState() {
  return {
    lowerThird: { visible: false, line1: '', line2: '', template: 'bar' },
    scripture: { visible: false, reference: '', text: '', translation: '', attribution: null },
    slide: { visible: false, src: '' },
    revision: 0,
  }
}

// ---------------------------------------------------------------------------------------------
// Defensive validation
// ---------------------------------------------------------------------------------------------

/*
 * The server validates everything it emits, so in practice these guards never fire. They exist
 * because this page is the LAST thing between a bad message and the congregation screen, and the
 * failure mode of a `TypeError` thrown mid-render is a half-drawn overlay stuck on air.
 *
 * Two different responses, and the line between them is drawn on one question — could accepting
 * this message make the output WORSE than ignoring it?
 *
 *   - A malformed FIELD is coerced. A snapshot whose `line2` is missing or is a number renders
 *     with an empty second line. Rejecting the whole snapshot over one bad field would strand the
 *     overlay on older content, which is worse than a slightly wrong caption.
 *   - A structurally incomplete SNAPSHOT is rejected outright. A payload missing a whole layer, or
 *     missing its revision, is not a state this page can render without inventing "hidden" for
 *     layers the server never spoke about — and inventing "hidden" means blanking something that
 *     is currently on air. So it is dropped, the screen keeps what it has, and the caller logs it.
 */

const asString = (value) => (typeof value === 'string' ? value : '')
const asBoolean = (value) => value === true

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Coerce a structurally complete snapshot. Returns null if it is not complete — see the note
 * above on why a missing layer is fatal to the message but a missing field is not.
 */
function normaliseState(raw) {
  const base = emptyOverlayState()
  const { lowerThird, scripture, slide } = raw
  if (!isObject(lowerThird) || !isObject(scripture) || !isObject(slide)) return null
  if (typeof raw.revision !== 'number' || !Number.isFinite(raw.revision) || raw.revision < 0) {
    return null
  }

  const template = LOWER_THIRD_TEMPLATES.includes(lowerThird.template)
    ? lowerThird.template
    : base.lowerThird.template

  return {
    lowerThird: {
      visible: asBoolean(lowerThird.visible),
      line1: asString(lowerThird.line1),
      line2: asString(lowerThird.line2),
      template,
    },
    scripture: {
      visible: asBoolean(scripture.visible),
      reference: asString(scripture.reference),
      text: asString(scripture.text),
      translation: asString(scripture.translation),
      attribution: typeof scripture.attribution === 'string' ? scripture.attribution : null,
    },
    slide: {
      visible: asBoolean(slide.visible),
      src: asString(slide.src),
    },
    revision: Math.floor(raw.revision),
  }
}

/**
 * Validate one inbound server message.
 *
 * Returns `{ ok: true, message }` with a fully normalised message, or `{ ok: false, code, detail }`.
 * It NEVER throws — a rejected message is logged by the caller and otherwise ignored, leaving
 * whatever is currently on screen exactly where it is (Standing Rule 6 applied to the output).
 *
 * `code` follows the coded-error convention from `docs/v2-notes/PROTOCOL.md` §2.4: a stable
 * machine-matchable string, not just a human sentence.
 *
 * @param {unknown} raw - the already-JSON-parsed frame body.
 * @returns {{ok: true, message: object} | {ok: false, code: string, detail: string}}
 */
export function validateServerMessage(raw) {
  if (!isObject(raw)) return { ok: false, code: 'NOT_AN_OBJECT', detail: typeof raw }
  if (!isObject(raw.payload)) return { ok: false, code: 'MISSING_PAYLOAD', detail: String(raw.channel) }

  switch (raw.channel) {
    case 'state': {
      const state = normaliseState(raw.payload)
      if (state === null) return { ok: false, code: 'INCOMPLETE_STATE', detail: 'missing layer or revision' }
      return { ok: true, message: { channel: 'state', payload: state } }
    }

    case 'ping': {
      const ts = typeof raw.payload.ts === 'number' && Number.isFinite(raw.payload.ts) ? raw.payload.ts : 0
      return { ok: true, message: { channel: 'ping', payload: { ts } } }
    }

    case 'error':
      return {
        ok: true,
        message: {
          channel: 'error',
          payload: { code: asString(raw.payload.code) || 'UNKNOWN', message: asString(raw.payload.message) },
        },
      }

    default:
      return { ok: false, code: 'UNKNOWN_CHANNEL', detail: String(raw.channel) }
  }
}
