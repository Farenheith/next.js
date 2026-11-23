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

export type DevValidationResult = {
  /** Pathname and search of the validated request. */
  url: string
  status: DevValidationStatus
  errors: string[]
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
  errors: readonly unknown[] = []
): void {
  const listeners = getListeners()
  if (listeners.size === 0) {
    return
  }
  const result: DevValidationResult = {
    url,
    status,
    errors: errors.map(describeValidationError),
  }
  for (const listener of listeners) {
    listener(result)
  }
}

export function describeValidationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function onDevValidationResult(listener: Listener): () => void {
  const listeners = getListeners()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
