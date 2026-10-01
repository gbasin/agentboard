// Deterministic harness for sidebar e2e specs.
//
// The suite shares ONE agentboard server and ONE tmux session across parallel
// workers, so a sidebar spec would otherwise see every window the other specs
// create, and any synced setting it saved (sidebar anchor, manual order)
// would be broadcast to — and break — every other open page. This harness:
//
// - creates real tmux windows named `<prefix>NN` (selection still attaches a
//   real terminal) and filters every session-bearing WS frame down to them,
//   rewriting createdAt so the default created-desc sort is `<prefix>00`
//   first, then 01, 02, ... regardless of tmux's 1-second creation stamps;
// - replaces the synced-settings channel with an in-test store: PUTs never
//   reach the server, and every `synced-settings` frame carries the store;
// - replaces hibernating/history agent sessions with synthetic entries;
// - stubs /api/server-info so the Tailscale IP is fixed (or absent);
// - can refuse new WebSocket connections to hold a non-connected state.
//
// Specs that use it must block service workers (`serviceWorkers: 'block'`),
// otherwise the PWA worker can answer fetches before page.route sees them.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Locator, Page, WebSocketRoute } from '@playwright/test'

/** Base timestamp for rewritten createdAt values (any fixed past instant). */
const BASE_TIME = Date.parse('2026-01-01T12:00:00.000Z')

export interface SyntheticAgentSession {
  sessionId: string
  logFilePath: string
  projectPath: string
  agentType: 'claude'
  displayName: string
  createdAt: string
  lastActivityAt: string
  isActive: boolean
  isHibernating?: boolean
}

export function syntheticAgentSession(
  id: string,
  options: { hibernating?: boolean } = {}
): SyntheticAgentSession {
  const stamp = new Date(BASE_TIME).toISOString()
  return {
    sessionId: id,
    logFilePath: `/nonexistent/${id}.jsonl`,
    projectPath: '/nonexistent/project',
    agentType: 'claude',
    displayName: id,
    createdAt: stamp,
    lastActivityAt: stamp,
    isActive: false,
    ...(options.hibernating ? { isHibernating: true } : {}),
  }
}

export interface HarnessOptions {
  /** Window-name prefix; only sessions whose name starts with it are shown. */
  prefix: string
  /** Initial synced settings served to the page (e.g. sidebarAnchor). */
  settings?: Record<string, unknown>
  /** Tailscale IP reported by /api/server-info (null: none). */
  tailscaleIp?: string | null
  hibernating?: SyntheticAgentSession[]
  history?: SyntheticAgentSession[]
  /** Added to every shown session (makes the row context menu taller). */
  logFilePath?: boolean
}

export interface Harness {
  /** The in-test synced-settings store (server stand-in). */
  settings: Record<string, unknown>
  /** Every synced-settings PUT body the page sent, in order. */
  puts: Record<string, unknown>[]
  /** When true, new WebSocket connections are closed immediately. */
  refuseConnections: boolean
  /** Close every currently open (routed) socket. */
  closeSockets: () => Promise<void>
}

/** Ordinal encoded in a harness window name; NaN for foreign names. */
function ordinalOf(name: string, prefix: string): number {
  if (!name.startsWith(prefix)) return Number.NaN
  return Number(name.slice(prefix.length))
}

function rewriteSession(
  session: Record<string, unknown>,
  options: HarnessOptions
): Record<string, unknown> | null {
  const name = typeof session.name === 'string' ? session.name : ''
  const ordinal = ordinalOf(name, options.prefix)
  if (Number.isNaN(ordinal)) return null
  return {
    ...session,
    // Lower ordinal = newer = earlier in the created-desc default sort.
    createdAt: new Date(BASE_TIME - ordinal * 60_000).toISOString(),
    ...(options.logFilePath ? { logFilePath: `/nonexistent/${name}.jsonl` } : {}),
  }
}

export async function installHarness(
  page: Page,
  options: HarnessOptions
): Promise<Harness> {
  const sockets = new Set<WebSocketRoute>()
  const harness: Harness = {
    settings: { ...options.settings },
    puts: [],
    refuseConnections: false,
    closeSockets: async () => {
      const open = [...sockets]
      sockets.clear()
      await Promise.all(open.map((ws) => ws.close()))
    },
  }

  await page.route('**/api/server-info', (route) =>
    route.fulfill({
      json: {
        port: Number(new URL(page.url() || 'http://localhost/').port) || 4040,
        tailscaleIp: options.tailscaleIp ?? null,
        protocol: 'http',
      },
    })
  )

  await page.route('**/api/settings/synced', async (route) => {
    const request = route.request()
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as { settings?: Record<string, unknown> }
      const delta = body?.settings ?? {}
      harness.puts.push(delta)
      Object.assign(harness.settings, delta)
    }
    await route.fulfill({ json: { settings: harness.settings } })
  })

  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (harness.refuseConnections) {
      void ws.close()
      return
    }
    sockets.add(ws)
    ws.onClose(() => sockets.delete(ws))
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(String(message))
      } catch {
        ws.send(message)
        return
      }
      switch (parsed.type) {
        case 'sessions': {
          const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : []
          parsed.sessions = sessions
            .map((s: Record<string, unknown>) => rewriteSession(s, options))
            .filter(Boolean)
          break
        }
        case 'session-created':
        case 'session-update': {
          const session = rewriteSession(
            parsed.session as Record<string, unknown>,
            options
          )
          if (!session) return
          parsed.session = session
          break
        }
        case 'synced-settings':
          parsed.settings = harness.settings
          break
        case 'agent-sessions':
          parsed.hibernating = options.hibernating ?? []
          parsed.history = options.history ?? []
          break
      }
      ws.send(JSON.stringify(parsed))
    })
  })

  return harness
}

// --- tmux windows --------------------------------------------------------

function tmux(args: string[]) {
  return spawnSync('tmux', args, { encoding: 'utf-8' })
}

export function tmuxSession(): string {
  const session = process.env.E2E_TMUX_SESSION
  if (!session) throw new Error('E2E_TMUX_SESSION is not set')
  return session
}

/** A unique, short window-name prefix for one test. */
export function uniquePrefix(tag: string): string {
  return `${tag}${randomBytes(2).toString('hex')}-`
}

export function windowName(prefix: string, ordinal: number): string {
  return `${prefix}${String(ordinal).padStart(2, '0')}`
}

export class Windows {
  private ids: string[] = []

  /**
   * Create a window `<prefix>NN` (optionally in `cwd`); returns its name.
   *
   * The pane runs `tail -f /dev/null` (like the server's bootstrap window)
   * instead of the user's login shell: the specs only need a window to list
   * and attach to, and dozens of login-shell startups per run add real load
   * when parallel workers already saturate the machine.
   */
  create(prefix: string, ordinal: number, cwd?: string): string {
    const name = windowName(prefix, ordinal)
    const args = ['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${tmuxSession()}:`, '-n', name]
    if (cwd) args.push('-c', cwd)
    args.push('tail -f /dev/null')
    const result = tmux(args)
    if (result.status !== 0) {
      throw new Error(`tmux new-window ${name} failed: ${result.stderr}`)
    }
    this.ids.push(result.stdout.trim())
    return name
  }

  createMany(prefix: string, count: number, cwdFor?: (i: number) => string): string[] {
    return Array.from({ length: count }, (_, i) => this.create(prefix, i, cwdFor?.(i)))
  }

  cleanup() {
    for (const id of this.ids) {
      tmux(['kill-window', '-t', id])
    }
    this.ids = []
  }
}

// --- sidebar locators and geometry ---------------------------------------

/** The desktop sidebar's SessionList (not the mobile drawer's copy). */
export function desktopSidebar(page: Page): Locator {
  return page.locator('aside:not(.session-drawer aside)')
}

export function cardByName(scope: Locator, name: string): Locator {
  return scope.getByTestId('session-card').filter({ hasText: name })
}

export interface Box {
  top: number
  bottom: number
  left: number
  right: number
  height: number
}

export async function box(locator: Locator): Promise<Box> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }
  })
}

/**
 * Names of the visible session cards in `scope`, ordered by their on-screen
 * vertical position (top first) — not DOM order.
 */
export async function namesTopToBottom(scope: Locator, prefix: string): Promise<string[]> {
  return scope.getByTestId('session-card').evaluateAll(
    (els, pfx) =>
      els
        .map((el) => {
          // Plain string search: the prefix is never interpreted as a regex.
          const text = el.textContent ?? ''
          const at = text.indexOf(pfx)
          const end = at + pfx.length
          const name = at >= 0 && /^\d\d/.test(text.slice(end)) ? text.slice(at, end + 2) : ''
          return { name, top: el.getBoundingClientRect().top }
        })
        .filter((row) => row.name)
        .sort((a, b) => a.top - b.top)
        .map((row) => row.name),
    prefix
  )
}

/** The modifier chord the app uses for its shortcuts on this platform. */
export async function shortcutChord(page: Page): Promise<string> {
  const isMac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform))
  return isMac ? 'Control+Alt' : 'Control+Shift'
}

/** Scroll geometry of an element: distance from the bottom edge, etc. */
export async function scrollState(locator: Locator) {
  return locator.evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
  }))
}
