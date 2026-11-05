import { describe, expect, test } from 'bun:test'
import {
  crossOriginRejection,
  isOriginAllowed,
  needsOriginCheck,
  normalizeOrigin,
  originPolicy,
  parseAllowedOrigins,
} from '../requestOrigin'

/** A plain-HTTP server with no allowlist, and the same server serving TLS itself. */
const plain = originPolicy([], '', '')
const tls = originPolicy([], '/certs/cert.pem', '/certs/key.pem')

describe('isOriginAllowed', () => {
  test('allows requests without an Origin header', () => {
    expect(isOriginAllowed(null, 'localhost:4040', plain)).toBe(true)
    expect(isOriginAllowed(null, null, plain)).toBe(true)
  })

  test('allows an Origin whose host:port equals Host', () => {
    expect(isOriginAllowed('http://localhost:4040', 'localhost:4040', plain)).toBe(true)
    expect(isOriginAllowed('https://100.64.0.1:4040', '100.64.0.1:4040', plain)).toBe(true)
    expect(isOriginAllowed('http://[::1]:4040', '[::1]:4040', plain)).toBe(true)
  })

  test('compares host case-insensitively', () => {
    expect(isOriginAllowed('http://Board.Example:4040', 'board.example:4040', plain)).toBe(true)
    expect(isOriginAllowed('http://board.example:4040', 'BOARD.EXAMPLE:4040', plain)).toBe(true)
  })

  test('treats an omitted port as the scheme default', () => {
    expect(isOriginAllowed('http://board.example', 'board.example:80', plain)).toBe(true)
    expect(isOriginAllowed('http://board.example:80', 'board.example', plain)).toBe(true)
    expect(isOriginAllowed('https://board.example', 'board.example:443', plain)).toBe(true)
    expect(isOriginAllowed('https://board.example', 'board.example', plain)).toBe(true)
    // The default port belongs to the Origin's scheme, not any scheme.
    expect(isOriginAllowed('https://board.example', 'board.example:80', plain)).toBe(false)
    expect(isOriginAllowed('http://board.example', 'board.example:443', plain)).toBe(false)
  })

  test('rejects a different port on the same host', () => {
    expect(isOriginAllowed('http://localhost:5173', 'localhost:4040', plain)).toBe(false)
    expect(isOriginAllowed('http://127.0.0.1:8080', '127.0.0.1:4040', plain)).toBe(false)
  })

  test('rejects a different host', () => {
    expect(isOriginAllowed('http://evil.example:4040', 'localhost:4040', plain)).toBe(false)
    expect(isOriginAllowed('http://localhost:4040', '127.0.0.1:4040', plain)).toBe(false)
  })

  test('rejects Origin: null', () => {
    expect(isOriginAllowed('null', 'localhost:4040', plain)).toBe(false)
  })

  test('rejects malformed origins and hosts', () => {
    for (const origin of ['', 'not a url', 'localhost:4040', 'http://', 'ftp://localhost:4040',
      'http://user@localhost:4040', 'http://localhost:4040/path', 'file:///etc/passwd'])
      expect(isOriginAllowed(origin, 'localhost:4040', plain)).toBe(false)
    expect(isOriginAllowed('http://localhost:4040', 'evil@localhost:4040', plain)).toBe(false)
    expect(isOriginAllowed('http://localhost:4040', 'localhost:4040/x', plain)).toBe(false)
    expect(isOriginAllowed('http://localhost:4040', '', plain)).toBe(false)
  })

  test('allows an allowlisted origin whatever the Host', () => {
    const allowed = originPolicy(parseAllowedOrigins('https://board.example.com'), '', '')
    expect(isOriginAllowed('https://board.example.com', '127.0.0.1:4040', allowed)).toBe(true)
    expect(isOriginAllowed('https://BOARD.example.com:443', '127.0.0.1:4040', allowed)).toBe(true)
    expect(isOriginAllowed('http://board.example.com', '127.0.0.1:4040', allowed)).toBe(false)
    expect(isOriginAllowed('https://other.example.com', '127.0.0.1:4040', allowed)).toBe(false)
    expect(isOriginAllowed('null', '127.0.0.1:4040', allowed)).toBe(false)
  })
})

describe('isOriginAllowed on a server that serves TLS itself', () => {
  test('accepts only an https Origin for the Host match', () => {
    expect(isOriginAllowed('https://board.example:4040', 'board.example:4040', tls)).toBe(true)
    expect(isOriginAllowed('https://[::1]:4040', '[::1]:4040', tls)).toBe(true)
    // Same host and port, wrong scheme: the page a network attacker can serve.
    expect(isOriginAllowed('http://board.example:4040', 'board.example:4040', tls)).toBe(false)
    expect(isOriginAllowed('http://127.0.0.1:4040', '127.0.0.1:4040', tls)).toBe(false)
  })

  test('a plain-HTTP server accepts both schemes, for TLS-terminating proxies', () => {
    expect(isOriginAllowed('http://board.example:4040', 'board.example:4040', plain)).toBe(true)
    expect(isOriginAllowed('https://board.example:4040', 'board.example:4040', plain)).toBe(true)
    expect(isOriginAllowed('https://board.example', 'board.example', plain)).toBe(true)
  })

  test('default ports follow the https scheme only', () => {
    expect(isOriginAllowed('https://board.example', 'board.example', tls)).toBe(true)
    expect(isOriginAllowed('https://board.example', 'board.example:443', tls)).toBe(true)
    expect(isOriginAllowed('https://board.example:443', 'board.example', tls)).toBe(true)
    expect(isOriginAllowed('http://board.example', 'board.example', tls)).toBe(false)
    expect(isOriginAllowed('http://board.example', 'board.example:80', tls)).toBe(false)
    expect(isOriginAllowed('http://board.example:80', 'board.example', tls)).toBe(false)
    expect(isOriginAllowed('https://board.example', 'board.example:80', tls)).toBe(false)
  })

  test('still allows requests without an Origin and rejects null and foreign origins', () => {
    expect(isOriginAllowed(null, 'board.example:4040', tls)).toBe(true)
    expect(isOriginAllowed('null', 'board.example:4040', tls)).toBe(false)
    expect(isOriginAllowed('https://evil.example:4040', 'board.example:4040', tls)).toBe(false)
  })

  test('an allowlisted origin matches exactly, whatever its scheme', () => {
    const allowed = originPolicy(parseAllowedOrigins('http://proxy.lan:8080,https://board.example.com'), 'cert', 'key')
    expect(isOriginAllowed('http://proxy.lan:8080', '127.0.0.1:4040', allowed)).toBe(true)
    expect(isOriginAllowed('https://board.example.com', '127.0.0.1:4040', allowed)).toBe(true)
    // The allowlist does not widen the Host match: http on the server's own authority stays rejected.
    expect(isOriginAllowed('http://127.0.0.1:4040', '127.0.0.1:4040', allowed)).toBe(false)
    expect(isOriginAllowed('https://proxy.lan:8080', '127.0.0.1:4040', allowed)).toBe(false)
  })
})

describe('originPolicy', () => {
  test('serves TLS only when both the certificate and the key are set', () => {
    expect(originPolicy([], 'cert', 'key').servesTls).toBe(true)
    expect(originPolicy([], 'cert', '').servesTls).toBe(false)
    expect(originPolicy([], '', 'key').servesTls).toBe(false)
    expect(originPolicy(['https://a.example'], '', '')).toEqual({ allowedOrigins: ['https://a.example'], servesTls: false })
  })
})

describe('parseAllowedOrigins', () => {
  test('normalizes whitespace, trailing slashes, case and default ports', () => {
    expect(parseAllowedOrigins(' https://Board.Example.com/ , http://proxy.lan:8080/,https://x.example:443 '))
      .toEqual(['https://board.example.com', 'http://proxy.lan:8080', 'https://x.example'])
  })

  test('drops empty and malformed entries', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([])
    expect(parseAllowedOrigins('')).toEqual([])
    expect(parseAllowedOrigins(',, ,null,board.example,https://ok.example/path,https://ok.example'))
      .toEqual(['https://ok.example'])
  })

  test('deduplicates equivalent entries', () => {
    expect(parseAllowedOrigins('https://a.example,https://A.example/')).toEqual(['https://a.example'])
  })
})

describe('normalizeOrigin', () => {
  test('returns the canonical origin or null', () => {
    expect(normalizeOrigin('HTTP://LocalHost:80')).toBe('http://localhost')
    expect(normalizeOrigin('https://x.example:8443/')).toBe('https://x.example:8443')
    expect(normalizeOrigin('https://x.example?q=1')).toBeNull()
    expect(normalizeOrigin('chrome-extension://abc')).toBeNull()
  })
})

describe('needsOriginCheck', () => {
  const req = (method: string) => new Request('http://localhost/', { method })
  test('covers /ws and every state-changing method on any path', () => {
    expect(needsOriginCheck(req('GET'), '/ws')).toBe(true)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(needsOriginCheck(req(method), '/api/settings/synced')).toBe(true)
    for (const method of ['GET', 'HEAD', 'OPTIONS'])
      expect(needsOriginCheck(req(method), '/api/settings/synced')).toBe(false)
    expect(needsOriginCheck(req('GET'), '/')).toBe(false)
  })

  test('does not depend on the path, which the router decodes differently', () => {
    // Hono routes /%61pi/x as /api/x; URL.pathname leaves it encoded.
    for (const path of ['/%61pi/paste-image', '/a%70i/library/x/resume', '/apiary', '/'])
      expect(needsOriginCheck(req('POST'), path)).toBe(true)
  })
})

describe('crossOriginRejection', () => {
  test('returns 403 and logs origin and host once for a foreign origin', async () => {
    const logs: Array<{ event: string; data: Record<string, unknown> }> = []
    const request = new Request('http://localhost:4040/api/paste-image', {
      method: 'POST',
      headers: { origin: 'http://evil.example', host: 'localhost:4040', cookie: 'secret' },
    })
    const response = await crossOriginRejection(request, '/api/paste-image', plain, (event, data) => logs.push({ event, data }))
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: 'Cross-origin request rejected' })
    expect(logs).toEqual([{
      event: 'cross_origin_request_rejected',
      data: { origin: 'http://evil.example', host: 'localhost:4040', method: 'POST', path: '/api/paste-image' },
    }])
  })

  test('drains a streamed body before answering', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled > 3) controller.close()
        else controller.enqueue(new Uint8Array(1024))
      },
    })
    const request = new Request('http://localhost:4040/api/paste-file', {
      method: 'POST', headers: { origin: 'http://evil.example' }, body,
    })
    const response = await crossOriginRejection(request, '/api/paste-file', plain, () => {})
    expect(response?.status).toBe(403)
    expect(pulled).toBe(4)
  })

  test('returns null without logging for allowed requests', () => {
    const logs: unknown[] = []
    const warn = (...args: unknown[]) => { logs.push(args) }
    const same = new Request('http://localhost:4040/ws', { headers: { origin: 'http://localhost:4040' } })
    const none = new Request('http://localhost:4040/ws')
    expect(crossOriginRejection(same, '/ws', plain, warn)).toBeNull()
    expect(crossOriginRejection(none, '/ws', plain, warn)).toBeNull()
    expect(logs).toEqual([])
  })

  test('rejects an http Origin on the same host and port when the server serves TLS', async () => {
    const request = (origin: string) => new Request('https://board.example:4040/ws', {
      headers: { origin, host: 'board.example:4040' },
    })
    const logs: string[] = []
    const response = await crossOriginRejection(request('http://board.example:4040'), '/ws', tls, event => logs.push(event))
    expect(response?.status).toBe(403)
    expect(logs).toEqual(['cross_origin_request_rejected'])
    expect(crossOriginRejection(request('https://board.example:4040'), '/ws', tls, event => logs.push(event))).toBeNull()
    expect(logs).toHaveLength(1)
  })

  test('falls back to the request URL host when Host is absent', () => {
    const request = new Request('http://localhost:4040/ws', { headers: { origin: 'http://localhost:4040' } })
    request.headers.delete('host')
    expect(crossOriginRejection(request, '/ws', plain, () => {})).toBeNull()
  })
})
