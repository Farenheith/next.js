/**
 * Publishes the outcome of each development Cache Components validation so the
 * dev server can answer "did this route validate?" without a browser.
 *
 * Validation normally reports through the terminal and the dev overlay. The
 * MCP `check_route` tool needs the same outcome as data. The state lives on
 * `globalThis` because the app-page runtime bundle and the dev server load
 * this module separately.
 */

export type DevValidationStatus =
  /** Validation ran to completion. `errors` holds what it found. */
  | 'validated'
  /** Server caches were bypassed for the request, so validation did not run. */
  | 'skipped'
  /** A newer render superseded the validation before it finished. */
  | 'aborted'

export type DevValidationError = {
  message: string
  /**
   * Where the error points in the app's source, as `file:line:column`, or null
   * when no frame could be mapped back to a source file.
   */
  location: string | null
  /**
   * The source-mapped stack and code frame, as `next dev` prints them to the
   * terminal. Null for a non-Error message.
   */
  stack: string | null
}

export type DevValidationResult = {
  /** Pathname and search of the validated request. */
  url: string
  status: DevValidationStatus
  errors: DevValidationError[]
}

type Listener = (result: DevValidationResult) => void

const LISTENERS = Symbol.for('next.dev.validationResultListeners')

function getListeners(): Set<Listener> {
  const holder = globalThis as { [LISTENERS]?: Set<Listener> }
  return (holder[LISTENERS] ??= new Set())
}

/**
 * Nothing is retained when no one is listening, so reporting is free outside
 * of an in-flight check.
 */
export function reportDevValidationResult(
  url: string,
  status: DevValidationStatus,
  errors: DevValidationError[] = []
): void {
  const listeners = getListeners()
  if (listeners.size === 0) {
    return
  }
  const result: DevValidationResult = { url, status, errors }
  for (const listener of listeners) {
    listener(result)
  }
}

/**
 * Turns a validation error into data. Must run where the error was created:
 * the source-mapped stack comes from the `inspect` hook that `next dev`
 * installs on `Error`, which is also what renders it in the terminal.
 */
export function describeValidationError(error: unknown): DevValidationError {
  if (!(error instanceof Error)) {
    return { message: String(error), location: null, stack: null }
  }

  const { inspect, stripVTControlCharacters } =
    require('node:util') as typeof import('node:util')
  const rendered = stripVTControlCharacters(inspect(error, { colors: false }))

  // The rendering is `<name>: <message>` followed by the frames and the code
  // frame. Keep only what follows the message.
  const messageEnd = rendered.indexOf(error.message)
  const stack = (
    messageEnd === -1
      ? rendered
      : rendered.slice(messageEnd + error.message.length)
  ).trim()

  // The first frame that names a file with a line and column, with or without
  // a function name in front of it.
  const frame = /^\s*at (?:.*? \()?([^()\s]+:\d+:\d+)\)?$/m.exec(stack)

  return {
    message: error.message,
    location: frame ? frame[1] : null,
    stack: stack === '' ? null : stack,
  }
}

export function onDevValidationResult(listener: Listener): () => void {
  const listeners = getListeners()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
