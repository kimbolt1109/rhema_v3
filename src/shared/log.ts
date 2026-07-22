/**
 * The logging contract, shared by main, preload and renderer.
 *
 * The concrete rolling-file implementation lives in `src/main/logging/logger.ts` — it needs
 * `node:fs` and Electron's `userData` path, neither of which may appear in `src/shared`
 * (`tsconfig.web.json` compiles this folder without `@types/node`). This module defines only
 * the vocabulary, so the renderer can construct a {@link LogRecord} and forward it to the main
 * process over IPC, landing renderer errors in the same rolling file as main-process ones.
 */

/**
 * Severity levels, ordered.
 *
 * There is deliberately no `trace`: this is a live-production tool whose logs are read after a
 * failed service, and a level nobody enables in production is a level nobody reads. `debug` is
 * the floor.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Ascending severity, for threshold comparisons (`LOG_LEVEL_ORDER[level] >= minimum`). */
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/**
 * Arbitrary structured context attached to a log line.
 *
 * Values are redacted by KEY at write time (any key matching `/password|secret|token|key|dsn/i`),
 * so a caller may pass a config object without first scrubbing it. Never rely on that as the
 * only defence — prefer not to put a secret in here at all.
 */
export interface LogFields {
  readonly [key: string]: unknown
}

/** The logging surface used everywhere in the app. */
export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /**
   * Returns a logger that stamps every record with a scope. Scopes nest with `:` —
   * `log.child('obs').child('reconnect')` emits `"scope": "obs:reconnect"`.
   */
  child(scope: string): Logger
}

/**
 * One serialised log line, and the payload the renderer sends over the `logWrite` IPC channel.
 *
 * This is the on-disk JSON-lines shape too, so a change here changes the log format.
 */
export interface LogRecord {
  /** Epoch milliseconds. */
  readonly ts: number
  readonly level: LogLevel
  /** Colon-nested origin, e.g. `renderer:connection` or `obs:reconnect`. */
  readonly scope: string
  readonly msg: string
  readonly data?: LogFields
}
