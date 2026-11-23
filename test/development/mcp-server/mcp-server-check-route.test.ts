import path from 'path'
import { nextTestSetup } from 'e2e-utils'

async function callMcpTool(
  url: string,
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<any> {
  const response = await fetch(`${url}/_next/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: toolName + '-' + Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  })
  const text = await response.text()
  const match = text.match(/data: ({.*})/s)
  expect(match).toBeTruthy()
  const envelope = JSON.parse(match![1])
  return JSON.parse(envelope.result?.content?.[0]?.text)
}

describe('mcp-server check_route tool', () => {
  const { next } = nextTestSetup({
    files: path.join(__dirname, 'fixtures', 'cache-components-app'),
  })

  it('reports a blocking route without a browser', async () => {
    const result = await callMcpTool(next.url, 'check_route', {
      path: '/blocking',
    })

    expect(result).toMatchObject({
      path: '/blocking',
      httpStatus: 200,
      ok: false,
      validation: { status: 'validated' },
    })
    expect(result.validation.errors).toHaveLength(1)
    expect(result.validation.errors[0]).toContain(
      'Next.js encountered uncached data during prerendering'
    )
  })

  it('passes a route that streams its request-time data', async () => {
    const result = await callMcpTool(next.url, 'check_route', {
      path: '/streaming',
    })

    expect(result).toMatchObject({
      path: '/streaming',
      httpStatus: 200,
      ok: true,
      validation: { status: 'validated', errors: [] },
    })
  })

  it('passes a static route', async () => {
    const result = await callMcpTool(next.url, 'check_route', { path: '/' })

    expect(result).toMatchObject({
      ok: true,
      validation: { status: 'validated', errors: [] },
    })
  })

  it('still reports the blocking route after a request that bypassed server caches', async () => {
    // A hard refresh, "Disable cache" in DevTools, and an automated browser
    // with request interception enabled all send this header. Validation is
    // skipped for that request, so nothing is reported for it.
    await next.fetch('/blocking', {
      headers: { 'cache-control': 'no-cache' },
    })

    const result = await callMcpTool(next.url, 'check_route', {
      path: '/blocking',
    })

    expect(result.ok).toBe(false)
    expect(result.validation.status).toBe('validated')
    expect(result.validation.errors[0]).toContain(
      'Next.js encountered uncached data during prerendering'
    )
  })

  it('rejects a path that is not site-relative', async () => {
    const result = await callMcpTool(next.url, 'check_route', {
      path: 'https://example.com/',
    })

    expect(result.error).toBe('Provide a path that starts with a single "/".')
  })
})
