/**
 * Cross-origin guard for browser-reachable endpoints.
 *
 * Agentboard has no authentication, so a page on another site must not be
 * able to open /ws or send state-changing /api requests through the user's
 * browser. The rule (used by the relay worker and the dashboard listener):
 *   1. No Origin header: allow. Browsers always send Origin on WebSocket
 *      handshakes and cross-site non-GET requests; curl, scripts and tests don't.
 *   2. Origin host:port equals the request Host (case-insensitive, omitted port
 *      = the Origin scheme's default): allow.
 *   3. Origin is listed in AGENTBOARD_ALLOWED_ORIGINS: allow (reverse proxies
 *      that rewrite Host).
 *   4. Anything else, including `Origin: null` or a malformed value: reject.
 * Import-free: config.ts parses the allowlist with it, and the relay worker
 * receives that list through RelayOptions instead of reading the environment.
 */
type WarnLog = (event: string, data: Record<string, unknown>) => void

const HOST_HEADER = /^[A-Za-z0-9._~-]+(?::\d+)?$|^\[[0-9A-Fa-f:.]+\](?::\d+)?$/

/** Canonical `scheme://host[:port]` for an http(s) origin, or null if malformed. */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
  return url.origin
}

/** Parses a comma-separated origin list; malformed entries are dropped. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const origins = new Set<string>()
  for (const entry of (raw ?? '').split(',')) {
    const origin = entry.trim() ? normalizeOrigin(entry) : null
    if (origin) origins.add(origin)
  }
  return [...origins]
}

export function isOriginAllowed(
  origin: string | null,
  host: string | null,
  allowedOrigins: readonly string[]
): boolean {
  if (origin === null) return true
  const normalized = normalizeOrigin(origin)
  if (!normalized) return false
  if (host && HOST_HEADER.test(host)) {
    // Resolve Host under the Origin's scheme so `Host: x` and `Host: x:80`
    // both compare equal to `http://x`.
    const scheme = normalized.slice(0, normalized.indexOf('//'))
    try {
      if (new URL(`${scheme}//${host}`).origin === normalized) return true
    } catch {
      // Unparseable Host falls through to the allowlist.
    }
  }
  return allowedOrigins.includes(normalized)
}

/** True for methods a cross-site form or fetch can use to change state. */
export function isStateChangingMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

/** Requests the guard covers: WebSocket upgrades and /api mutations. */
export function needsOriginCheck(req: Request, pathname: string): boolean {
  if (pathname === '/ws') return true
  return (pathname === '/api' || pathname.startsWith('/api/')) && isStateChangingMethod(req.method)
}

/**
 * Returns a 403 (and logs once) when the request's origin is rejected, or null.
 * The 403 resolves only after the request body is drained: Bun's server parses
 * body bytes that arrive after an early response as the next request on the
 * keep-alive connection, and the relay shares that connection pool across
 * clients, so one rejected upload would 400 another user's request.
 */
export function crossOriginRejection(
  req: Request,
  pathname: string,
  allowedOrigins: readonly string[],
  warn: WarnLog
): Promise<Response> | null {
  const origin = req.headers.get('origin')
  const host = req.headers.get('host') ?? new URL(req.url).host
  if (isOriginAllowed(origin, host, allowedOrigins)) return null
  warn('cross_origin_request_rejected', {
    origin: origin?.slice(0, 200),
    host: host.slice(0, 200),
    method: req.method,
    path: pathname,
  })
  return drain(req.body).then(() =>
    Response.json({ error: 'Cross-origin request rejected' }, { status: 403 }))
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return
  const reader = body.getReader()
  try {
    while (!(await reader.read()).done) { /* discard */ }
  } catch {
    // A client that aborts its upload still gets the 403 (or nothing).
  }
}
