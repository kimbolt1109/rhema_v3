/**
 * Live captions — the operator-facing state, shared by all three runtimes.
 *
 * ## Why this lives in `shared/` and not beside the service
 *
 * The renderer must never import main-process code — `tsconfig.web.json` deliberately leaves
 * `@main/*` unmapped, and the only channel between them is the typed preload bridge. The caption
 * toggle is driven from the renderer and implemented in main, so the shape they agree on has to
 * sit here, exactly like `OverlayState` in `./overlay.ts` does.
 *
 * ## Why the enable flag is not part of `OverlayState`
 *
 * The overlay protocol is deliberately dumb: it carries what is on screen, not why. "Captions are
 * switched on" is an operator intent that outlives any particular line of text — it must survive
 * the overlay reconnecting, and it must be answerable while nothing is being said. Folding it into
 * the wire state would also mean an overlay page could observe a policy decision it has no use
 * for. So the layer stays a pure render target and the intent lives here.
 *
 * Node-global free: imported by main, renderer, and the preload bridge.
 */

/**
 * The longest caption the overlay protocol will carry, in characters.
 *
 * Must stay equal to the `max()` on `caption.show`'s `text` in `./overlay.ts`, which REJECTS
 * anything longer rather than truncating it. A driver that does not window its text down to this
 * will simply stop producing captions mid-service, so the cap is exported rather than duplicated
 * as a literal at the call site.
 */
export const CAPTION_MAX_CHARS = 400

/**
 * How long a caption may sit on screen with nothing new being said, in milliseconds.
 *
 * Without this, the last sentence of a sermon stays over the congregation's view until someone
 * notices. Six seconds is long enough to read a full line aloud and pause for breath, short enough
 * that a finished thought clears before it becomes furniture.
 */
export const CAPTION_IDLE_HIDE_MS = 6_000

/**
 * How far into the window a word boundary may sit before the hard cut is used instead.
 *
 * Cutting at the first space avoids opening a caption mid-word, but only where a space is close by.
 * **Korean is written with far fewer spaces than English**, so a boundary can land 200 characters
 * in, and honouring it there would throw away half the caption to gain a tidy first word. This is
 * the language actually being preached, so a conservative fixed slack is the right trade rather
 * than a proportion of the window.
 */
export const CAPTION_WORD_BOUNDARY_SLACK = 40

/** What the operator has asked for, and what the driver last did about it. */
export interface CaptionRuntimeState {
  /**
   * The operator's switch. **False by default and after every launch** — a caption is unreviewed
   * machine output on the congregation's screen, and Standing Rule 1 says design for veto, not
   * trust. This is never persisted to a state where it comes back on by itself.
   */
  readonly enabled: boolean
  /**
   * Whether in-flight partial text is shown as well as confirmed finals.
   *
   * Off by default: a draft visibly rewrites itself as the recogniser changes its mind, which
   * reads as a malfunction to anyone watching and is far more distracting than a short delay.
   */
  readonly showDrafts: boolean
  /** The last text pushed to the layer, for the operator's own monitoring. Never persisted. */
  readonly lastText: string
}

/** The resting state: off, finals-only, nothing said yet. What a fresh service starts in. */
export function idleCaptionState(): CaptionRuntimeState {
  return { enabled: false, showDrafts: false, lastText: '' }
}

/**
 * Window `text` down to something `caption.show` will actually accept.
 *
 * Keeps the END of the utterance rather than the start: a caption is a running readout of what is
 * being said now, so when a sentence outgrows the frame the useful half is the most recent one.
 * Cuts at a word boundary when there is one reasonably close, because a caption sliced mid-word
 * reads as corruption rather than as continuation.
 *
 * Returns an empty string for input that is empty or whitespace-only, so a caller can treat "there
 * is nothing worth showing" as one case.
 */
export function windowCaptionText(text: string, max: number = CAPTION_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed

  const tail = collapsed.slice(collapsed.length - max)
  const boundary = tail.indexOf(' ')

  // Only honour a NEARBY boundary — see CAPTION_WORD_BOUNDARY_SLACK. Beyond it we would discard
  // most of what we kept in order to tidy the edge, which is the wrong trade for a readout, and in
  // Korean the nearest space may be nowhere near the edge at all.
  //
  // `>= 0`, not `> 0`: a cut landing exactly on a space is the ordinary case, not an edge case, and
  // excluding it returns a caption with a leading space that then renders as an indent.
  if (boundary >= 0 && boundary < Math.min(CAPTION_WORD_BOUNDARY_SLACK, max)) {
    const trimmed = tail.slice(boundary + 1).trim()
    // A boundary on the final character slices to nothing; prefer the hard cut over an empty
    // caption for input that plainly had text in it.
    if (trimmed.length > 0) return trimmed
  }

  // Trimmed unconditionally: whatever the cut, a caption must not begin or end with whitespace.
  return tail.trim()
}
