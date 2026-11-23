/**
 * MCP tool that checks one route without a browser.
 *
 * It compiles the route, requests it from the running dev server, and returns
 * the outcome of the Cache Components validation for that request: the same
 * blocking-route and instant errors that `next dev` prints to the terminal and
 * shows in the dev overlay.
 *
 * `get_errors` reads the error overlay of a connected browser, so it has
 * nothing to report when no browser is open or when the browser's request
 * bypassed server caches (a hard refresh, "Disable cache" in DevTools, or an
 * automated browser with request interception enabled, all of which send
 * `Cache-Control: no-cache`). This tool makes its own plain request, so the
 * validation always runs.
 */
import type { McpServer } from 'next/dist/compiled/@modelcontextprotocol/sdk/server/mcp'
import { mcpTelemetryTracker } from '../mcp-telemetry-tracker'
import type { FormattedIssue } from './utils/format-compilation-issues'
import {
  onDevValidationResult,
  type DevValidationError,
  type DevValidationResult,
} from '../../app-render/dev-validation-results'
import z from 'next/dist/compiled/zod'

const VALIDATION_TIMEOUT_MS = 30_000

type Validation =
  | { status: 'validated'; errors: DevValidationError[] }
  | { status: 'not-run'; reason: string }

export function registerCheckRouteTool(
  server: McpServer,
  options: {
    getDevServerUrl: () => string | undefined
    cacheComponents: boolean
    compileRoute?: (opts: {
      path?: string
    }) => Promise<{ routeSpecifier: string; issues: FormattedIssue[] }>
  }
) {
  server.registerTool(
    'check_route',
    {
      description:
        'Check one route of the running dev server without a browser. ' +
        'Compiles the route, requests it, and waits for the Cache Components validation of that request. ' +
        'Returns { path, routeSpecifier, httpStatus, compilationIssues, validation, ok }. ' +
        '`validation.errors` holds the blocking-route and instant errors that `next dev` would print for the route, ' +
        'each as { message, location, stack } where `location` is the `file:line:column` in the app source, ' +
        'such as uncached or request-time data read outside <Suspense>. ' +
        'Use this after editing a route instead of running `next build` to find out whether it can be prerendered. ' +
        'Unlike get_errors it does not need an open browser, and it is not affected by a browser that sends `Cache-Control: no-cache`.',
      inputSchema: {
        path: z
          .string()
          .describe(
            'A URL path on this site (e.g. "/", "/blog/hello-world?page=2"). Do not include scheme/host/port.'
          ),
      },
    },
    async ({ path }) => {
      mcpTelemetryTracker.recordToolCall('mcp/check_route')

      const devServerUrl = options.getDevServerUrl()
      if (!devServerUrl) {
        return failure({ path, error: 'The dev server URL is not known yet.' })
      }
      if (!path.startsWith('/') || path.startsWith('//')) {
        return failure({
          path,
          error: 'Provide a path that starts with a single "/".',
        })
      }

      const target = new URL(path, devServerUrl)
      // URL parsing treats a backslash as a slash, so a path such as `/\\host`
      // resolves to another origin. Only ever request this dev server.
      if (target.origin !== new URL(devServerUrl).origin) {
        return failure({
          path,
          error: 'Provide a path that starts with a single "/".',
        })
      }
      const url = target.pathname + target.search

      let routeSpecifier: string | undefined
      let compilationIssues: FormattedIssue[] = []
      if (options.compileRoute) {
        try {
          const compiled = await options.compileRoute({ path: url })
          routeSpecifier = compiled.routeSpecifier
          compilationIssues = compiled.issues
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return failure({ path, notFound: true })
          }
          return failure({
            path,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      // Listen before requesting: validation can settle as soon as the
      // response is sent.
      const settled = waitForValidation(url)

      let response: Response
      try {
        response = await fetch(target, {
          headers: { accept: 'text/html' },
          redirect: 'manual',
        })
        // Read the whole body so the render, and with it the validation
        // inputs, completes.
        await response.arrayBuffer()
      } catch (error) {
        settled.cancel()
        return failure({
          path,
          error: error instanceof Error ? error.message : String(error),
        })
      }

      let validation: Validation
      const contentType = response.headers.get('content-type') ?? ''
      if (!options.cacheComponents) {
        settled.cancel()
        validation = {
          status: 'not-run',
          reason:
            'Validation needs `cacheComponents: true` in next.config. Without it routes are not prerendered into a static shell.',
        }
      } else if (response.status >= 300 && response.status < 400) {
        settled.cancel()
        validation = {
          status: 'not-run',
          reason: `The route redirected to ${response.headers.get('location') ?? 'another URL'}. Check that path instead.`,
        }
      } else if (!contentType.includes('text/html')) {
        settled.cancel()
        validation = {
          status: 'not-run',
          reason: 'The route did not render a page.',
        }
      } else {
        validation = describe(await settled.result)
      }

      const ok =
        compilationIssues.every((issue) => issue.severity !== 'error') &&
        response.status < 400 &&
        (validation.status !== 'validated' || validation.errors.length === 0)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              path: url,
              routeSpecifier,
              httpStatus: response.status,
              compilationIssues,
              validation,
              ok,
            }),
          },
        ],
      }
    }
  )
}

function describe(result: DevValidationResult | undefined): Validation {
  if (!result) {
    return {
      status: 'not-run',
      reason: `No validation result arrived within ${VALIDATION_TIMEOUT_MS / 1000} seconds.`,
    }
  }
  switch (result.status) {
    case 'validated':
      return { status: 'validated', errors: result.errors }
    case 'skipped':
      return {
        status: 'not-run',
        reason:
          'Server caches were bypassed for this request, so validation was skipped. Draft Mode does this. Disable it and check again.',
      }
    case 'aborted':
      return {
        status: 'not-run',
        reason:
          'A newer render of this route superseded the validation. Check again.',
      }
    default:
      return result.status satisfies never
  }
}

/**
 * Resolves with the first validation that completed or was skipped for `url`.
 * A superseded validation is remembered but does not end the wait, because the
 * render that superseded it reports next.
 */
function waitForValidation(url: string): {
  result: Promise<DevValidationResult | undefined>
  cancel: () => void
} {
  let finish: (result: DevValidationResult | undefined) => void = () => {}
  let last: DevValidationResult | undefined

  const result = new Promise<DevValidationResult | undefined>((resolve) => {
    const timeout = setTimeout(() => finish(last), VALIDATION_TIMEOUT_MS)
    const unsubscribe = onDevValidationResult((candidate) => {
      if (candidate.url !== url) {
        return
      }
      last = candidate
      if (candidate.status !== 'aborted') {
        finish(candidate)
      }
    })
    finish = (value) => {
      clearTimeout(timeout)
      unsubscribe()
      resolve(value)
    }
  })

  return { result, cancel: () => finish(undefined) }
}

function failure(payload: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  }
}
