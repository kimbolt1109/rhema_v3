/**
 * `Result` — the return shape for every operation that crosses a process boundary.
 *
 * Electron IPC cannot transport an `Error`: a thrown exception in a main-process handler
 * arrives in the renderer as an opaque, stringified rejection with the stack mangled and the
 * type lost. So nothing in Verger throws across a boundary. Handlers catch, convert to an
 * `Err` with a stable machine-readable `code`, and the renderer switches on that code.
 *
 * This module is imported by main, preload and renderer alike, so it must stay free of Node
 * globals (see `tsconfig.web.json`, which compiles `src/shared` without `@types/node`).
 */

/**
 * Stable, machine-readable failure codes.
 *
 * These are part of the IPC contract: the renderer branches on them to decide what to render,
 * so renaming one is a breaking change. The human-readable `message` is for logs and for
 * developers — user-facing copy is chosen by the renderer from the `code`, via i18n.
 */
export const ErrorCode = {
  /** A required secret or setting is absent from `.env`. Expected, never a crash — the
   *  subsystem reports itself unavailable and the app keeps running (Standing Rule 5). */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** The subsystem is configured but not currently connected (e.g. OBS is closed). */
  NOT_CONNECTED: 'NOT_CONNECTED',
  /** OBS accepted the request and refused it, or replied with an error. */
  OBS_ERROR: 'OBS_ERROR',
  /** A call exceeded its deadline. Always bounded — a live service must never hang on us. */
  TIMEOUT: 'TIMEOUT',
  /** An argument failed validation at a trust boundary. */
  INVALID_ARG: 'INVALID_ARG',
  /** A lookup found nothing. Distinct from a failure — the absence is the answer. */
  NOT_FOUND: 'NOT_FOUND',
  /** A filesystem read or write failed. */
  IO_ERROR: 'IO_ERROR',
  /** Encryption or decryption failed — e.g. an OS keychain rejected a stored blob. */
  CRYPTO_ERROR: 'CRYPTO_ERROR',
  /** A rate limit rejected the call. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** An unexpected exception was caught and converted. Indicates a bug in Verger. */
  INTERNAL: 'INTERNAL',
} as const

/** Union of every {@link ErrorCode} value. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/**
 * A failure, safe to send over IPC.
 *
 * `detail` carries developer context (an OBS error string, a zod issue path). It is logged but
 * must never contain a secret value — redact before constructing.
 */
export interface AppError {
  readonly code: ErrorCode
  readonly message: string
  readonly detail?: string
}

/** A successful result carrying a value. */
export interface Ok<T> {
  readonly ok: true
  readonly value: T
}

/** A failed result carrying an {@link AppError}. */
export interface Err {
  readonly ok: false
  readonly error: AppError
}

/**
 * The result of a fallible operation.
 *
 * Discriminated on `ok`, so `if (result.ok)` narrows to {@link Ok} in both branches without a
 * type assertion.
 */
export type Result<T> = Ok<T> | Err

/** Wrap a value as a successful {@link Result}. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

/**
 * Build a failed {@link Result}.
 *
 * `detail` is omitted entirely when not supplied rather than set to `undefined`, because
 * `exactOptionalPropertyTypes` is on and `{ detail: undefined }` is not assignable to
 * `{ detail?: string }`.
 */
export function err(code: ErrorCode, message: string, detail?: string): Err {
  return detail === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, detail } }
}

/** Type guard narrowing a {@link Result} to its success branch. */
export function isOk<T>(result: Result<T>): result is Ok<T> {
  return result.ok
}

/** Type guard narrowing a {@link Result} to its failure branch. */
export function isErr<T>(result: Result<T>): result is Err {
  return !result.ok
}

/**
 * Convert an unknown thrown value into an {@link AppError}.
 *
 * Used by the IPC `safeHandle` wrapper and anywhere a `catch` must not leak an exception across
 * a boundary. Accepts `unknown` because that is what `catch` binds under
 * `useUnknownInCatchVariables`.
 */
export function toAppError(cause: unknown, code: ErrorCode = ErrorCode.INTERNAL): AppError {
  if (cause instanceof Error) {
    return { code, message: cause.message, detail: cause.name }
  }
  return { code, message: String(cause) }
}
