/**
 * The overlay protocol — the architectural core of Verger.
 *
 * BLUEPRINT.md §6: the lower-third is its own LAYER, not a slide. An OBS scene is
 * `camera source(s) + a persistent "Overlays" browser source on top`. Because the overlay is a
 * separate layer, **switching cameras never touches it, and showing a lower-third never
 * touches the camera.** That is the end of the transparent-PowerPoint problem (#3).
 *
 * ## Why this is state-based, not event-based
 *
 * An OBS browser source can be reloaded, hidden, or crash at any moment, and the operator will
 * not notice until the congregation does. If the wire protocol were a stream of show/hide
 * EVENTS, a reconnecting overlay would have missed everything that happened while it was gone
 * and would come back blank — during a service.
 *
 * So the SERVER owns the state, and the overlay is a pure function of it. Commands mutate
 * server state; the server broadcasts a full {@link OverlayState} snapshot after every change
 * and, critically, **immediately on connect**. A crashed overlay reloads, receives the current
 * snapshot, and re-renders exactly what should be on screen. Resync is not a special case —
 * it is the only case.
 *
 * ## Envelope
 *
 * One discriminated union, discriminated on `channel`, with `payload` ALWAYS present.
 * `docs/v2-notes/PROTOCOL.md` §4 records that rhema_v2 ended up with three incompatible
 * envelope shapes for one conceptual bus, including one whose secondary key name changed with
 * the message type and whose errors skipped the payload wrapper entirely. One shape, here.
 *
 * BLUEPRINT.md illustrates the intent as `{ type:"lowerthird", action:"show", line1, line2 }`.
 * That maps onto `{ channel:'command', name:'lowerThird.show', payload:{ line1, line2 } }` —
 * same intent, consistent envelope.
 *
 * Node-global free: imported by main, renderer, AND the overlay page.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * The independent overlay layers.
 *
 * Each is rendered and animated separately and mutated separately. Nothing in this protocol
 * lets one layer's command alter another layer's state — that independence is the product
 * requirement, so it is enforced by the shape of the data, not by discipline.
 */
export const OVERLAY_LAYERS = ['lowerThird', 'scripture', 'slide'] as const

/** Union of the layer names. */
export type OverlayLayerId = (typeof OVERLAY_LAYERS)[number]

/** Named lower-third templates. Their CSS lives in the overlay stylesheet. */
export const LOWER_THIRD_TEMPLATES = ['bar', 'boxed', 'minimal'] as const

/** Union of the template names. */
export type LowerThirdTemplate = (typeof LOWER_THIRD_TEMPLATES)[number]

/** A name/role caption, e.g. `홍길동 / 찬양 인도`. */
export interface LowerThirdState {
  readonly visible: boolean
  readonly line1: string
  readonly line2: string
  readonly template: LowerThirdTemplate
}

/**
 * A scripture reference and its resolved text.
 *
 * `text` is supplied by the caller and is NEVER authored in this repo — Standing Rule 4. It
 * arrives either from a licensed API or from a verified public-domain translation loaded at
 * runtime. `attribution` is required by those licences and is rendered whenever present.
 */
export interface ScriptureState {
  readonly visible: boolean
  readonly reference: string
  readonly text: string
  readonly translation: string
  readonly attribution: string | null
}

/** A slide image, referenced by a URL the overlay server can serve. */
export interface SlideState {
  readonly visible: boolean
  readonly src: string
}

/**
 * The complete overlay state — everything needed to render the overlay from scratch.
 *
 * `revision` increments on every mutation. The overlay echoes the revision it has applied,
 * which lets the control UI show "overlay is 2 revisions behind" rather than silently
 * diverging.
 */
export interface OverlayState {
  readonly lowerThird: LowerThirdState
  readonly scripture: ScriptureState
  readonly slide: SlideState
  readonly revision: number
}

/** The blank overlay: every layer hidden. The state a fresh server starts in. */
export function emptyOverlayState(): OverlayState {
  return {
    lowerThird: { visible: false, line1: '', line2: '', template: 'bar' },
    scripture: { visible: false, reference: '', text: '', translation: '', attribution: null },
    slide: { visible: false, src: '' },
    revision: 0,
  }
}

// ---------------------------------------------------------------------------
// Commands (control -> server -> overlay)
// ---------------------------------------------------------------------------

/**
 * Every command name.
 *
 * `clearAll` is deliberately separate from the per-layer hides: it is the destructive
 * "blank everything" action, and `docs/v2-notes/SHORTCUTS_AND_A11Y.md` records that v2 shipped
 * it as an instant keypress and had to walk that back. It is a HELD action in the UI, never a
 * tap, and it is never wired to the same control as "hand back from AI".
 */
export const OVERLAY_COMMANDS = [
  'lowerThird.show',
  'lowerThird.hide',
  'scripture.show',
  'scripture.hide',
  'slide.show',
  'slide.hide',
  'clearAll',
] as const

/** Union of the command names. */
export type OverlayCommandName = (typeof OVERLAY_COMMANDS)[number]

const lowerThirdShowPayload = z.object({
  line1: z.string().max(120),
  line2: z.string().max(120).default(''),
  template: z.enum(LOWER_THIRD_TEMPLATES).default('bar'),
})

const scriptureShowPayload = z.object({
  reference: z.string().min(1).max(120),
  text: z.string().max(4000),
  translation: z.string().max(60).default(''),
  attribution: z.string().max(200).nullable().default(null),
})

const slideShowPayload = z.object({
  src: z.string().min(1).max(2048),
})

const emptyPayload = z.object({})

/**
 * Payload schema per command. These schemas ARE the types — there is no parallel interface to
 * drift from them (`docs/v2-notes/PROTOCOL.md` §4 recommendation 4).
 */
export const overlayCommandPayloadSchemas = {
  'lowerThird.show': lowerThirdShowPayload,
  'lowerThird.hide': emptyPayload,
  'scripture.show': scriptureShowPayload,
  'scripture.hide': emptyPayload,
  'slide.show': slideShowPayload,
  'slide.hide': emptyPayload,
  clearAll: emptyPayload,
} as const

/** The payload type for a given command name. */
export type OverlayCommandPayload<N extends OverlayCommandName> = z.infer<
  (typeof overlayCommandPayloadSchemas)[N]
>

/** A command as sent by the control UI. */
export type OverlayCommand = {
  [N in OverlayCommandName]: {
    readonly channel: 'command'
    readonly name: N
    readonly payload: OverlayCommandPayload<N>
  }
}[OverlayCommandName]

/** Runtime schema for any command. */
export const overlayCommandSchema = z.discriminatedUnion('name', [
  z.object({
    channel: z.literal('command'),
    name: z.literal('lowerThird.show'),
    payload: lowerThirdShowPayload,
  }),
  z.object({
    channel: z.literal('command'),
    name: z.literal('lowerThird.hide'),
    payload: emptyPayload,
  }),
  z.object({
    channel: z.literal('command'),
    name: z.literal('scripture.show'),
    payload: scriptureShowPayload,
  }),
  z.object({
    channel: z.literal('command'),
    name: z.literal('scripture.hide'),
    payload: emptyPayload,
  }),
  z.object({
    channel: z.literal('command'),
    name: z.literal('slide.show'),
    payload: slideShowPayload,
  }),
  z.object({
    channel: z.literal('command'),
    name: z.literal('slide.hide'),
    payload: emptyPayload,
  }),
  z.object({
    channel: z.literal('command'),
    name: z.literal('clearAll'),
    payload: emptyPayload,
  }),
])

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

/** Server -> overlay. */
export type OverlayServerMessage =
  /** The full snapshot. Sent immediately on connect, and after every mutation. */
  | { readonly channel: 'state'; readonly payload: OverlayState }
  /** A liveness probe. The overlay replies with `pong`. */
  | { readonly channel: 'ping'; readonly payload: { readonly ts: number } }
  | {
      readonly channel: 'error'
      readonly payload: { readonly code: string; readonly message: string }
    }

/** Overlay -> server. */
export type OverlayClientMessage =
  /** Sent once on connect, so the server can log which overlay attached. */
  | {
      readonly channel: 'hello'
      readonly payload: { readonly page: string; readonly userAgent: string }
    }
  /** Confirms the overlay has rendered a given revision. */
  | { readonly channel: 'applied'; readonly payload: { readonly revision: number } }
  | { readonly channel: 'pong'; readonly payload: { readonly ts: number } }

/** Runtime schema for overlay -> server messages. Everything inbound is validated. */
export const overlayClientMessageSchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('hello'),
    payload: z.object({ page: z.string().max(200), userAgent: z.string().max(500) }),
  }),
  z.object({
    channel: z.literal('applied'),
    payload: z.object({ revision: z.number().int().nonnegative() }),
  }),
  z.object({
    channel: z.literal('pong'),
    payload: z.object({ ts: z.number() }),
  }),
])

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Apply a command to the overlay state.
 *
 * PURE — this is the single place overlay state changes, so the independence guarantee is
 * testable directly: applying any `lowerThird.*` command must leave `scripture` and `slide`
 * byte-identical, and vice versa. `src/main/overlay/reducer.test.ts` asserts exactly that for
 * every command.
 */
export function applyOverlayCommand(state: OverlayState, command: OverlayCommand): OverlayState {
  const bump = (patch: Partial<Omit<OverlayState, 'revision'>>): OverlayState => ({
    ...state,
    ...patch,
    revision: state.revision + 1,
  })

  switch (command.name) {
    case 'lowerThird.show':
      return bump({
        lowerThird: {
          visible: true,
          line1: command.payload.line1,
          line2: command.payload.line2,
          template: command.payload.template,
        },
      })
    case 'lowerThird.hide':
      return bump({ lowerThird: { ...state.lowerThird, visible: false } })
    case 'scripture.show':
      return bump({
        scripture: {
          visible: true,
          reference: command.payload.reference,
          text: command.payload.text,
          translation: command.payload.translation,
          attribution: command.payload.attribution,
        },
      })
    case 'scripture.hide':
      return bump({ scripture: { ...state.scripture, visible: false } })
    case 'slide.show':
      return bump({ slide: { visible: true, src: command.payload.src } })
    case 'slide.hide':
      return bump({ slide: { ...state.slide, visible: false } })
    case 'clearAll':
      return { ...emptyOverlayState(), revision: state.revision + 1 }
    default: {
      // Exhaustiveness: adding a command without handling it fails to compile.
      const unreachable: never = command
      return unreachable
    }
  }
}
