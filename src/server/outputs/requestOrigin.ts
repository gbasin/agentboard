/** Browser requests to board APIs/sockets must originate in the board itself. */
export function isBoardOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true // CLI clients and top-level navigations have no Origin.
  try {
    // Reverse proxies may terminate TLS. Host (including port) must still be
    // preserved; unlike cookies, origin isolation includes the port.
    return new URL(origin).host === new URL(request.url).host
  } catch { return false }
}
