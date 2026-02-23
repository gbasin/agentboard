/**
 * useWebSocket.ts — WebSocket connection manager with iOS Safari PWA support.
 *
 * Handles reconnection after background/foreground transitions via:
 * - visibilitychange listener with suspension detection (force reconnect when
 *   time gap > 10s indicates OS froze the process — fixes iOS zombie sockets)
 * - pageshow listener (bfcache restore — always forces reconnect)
 * - Time-jump detector (fallback for deep PWA suspension — always forces)
 * - Connection timeout (prevents zombie sockets from blocking reconnect)
 * - Application-level ping/pong heartbeat (detects dead sockets in foreground)
 * - Debounce on forceReconnect (prevents double reconnect from overlapping triggers)
 * - Leaked socket tracking (force-closes all prior sockets to avoid browser limits)
 * - Resume delay (waits for iOS to restore network before first connect attempt)
 */
import { useEffect, useMemo, useState } from 'react'
import type { ClientMessage, SendClientMessage, ServerMessage } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSessionStore } from '../stores/sessionStore'
import { clientLog } from '../utils/clientLog'

type MessageListener = (message: ServerMessage) => void

type StatusListener = (
  status: ConnectionStatus,
  error: string | null,
  connectionEpoch: number
) => void

const WS_STATES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const

/** How long to wait for a WebSocket to reach OPEN before giving up. */
const CONNECT_TIMEOUT_MS = 3_000

/**
 * Longer timeout for the first connect attempt after a resume — Tailscale /
 * VPN tunnels need extra time and packets may be silently dropped (no ICMP),
 * so the standard 3 s timeout is too aggressive.
 */
const RESUME_CONNECT_TIMEOUT_MS = 8_000

/**
 * If the interval timer detects a time jump larger than this, the device
 * likely slept or the PWA was suspended. Force a fresh reconnect.
 */
const WAKE_JUMP_MS = 15_000

/** Tick interval for the time-jump detector. */
const WAKE_CHECK_INTERVAL_MS = 5_000

// SUSPEND_THRESHOLD_MS (10_000) — removed: we now always force-reconnect
// on resume regardless of gap duration.  The short-vs-long distinction
// was unreliable and the verification ping wasted 3 s on zombie sockets.

/** How often to send an application-level ping to detect dead sockets. */
const HEARTBEAT_INTERVAL_MS = 20_000

/** How long to wait for a pong before declaring the socket dead. */
const PONG_TIMEOUT_MS = 10_000

// RESUME_PONG_TIMEOUT_MS (3_000) — removed: short resumes now always
// force-reconnect instead of sending a verification ping on the zombie.

/**
 * Delay before the first reconnect attempt after a resume event.
 * Gives iOS time to restore WiFi / VPN networking — visibilitychange fires
 * before the network stack is ready (confirmed by Apple Developer Forums).
 */
const RESUME_SETTLE_MS = 750

/**
 * After this many consecutive failed connect attempts, insert an extra delay
 * and aggressively clean up any leaked sockets.  Prevents a tight
 * connect-timeout → reconnect loop from chewing resources.
 */
const STALL_THRESHOLD = 4
const STALL_COOLDOWN_MS = 5_000

export class WebSocketManager {
  private ws: WebSocket | null = null
  private listeners = new Set<MessageListener>()
  private statusListeners = new Set<StatusListener>()
  private status: ConnectionStatus = 'connecting'
  private error: string | null = null
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  private connectTimer: number | null = null
  private manualClose = false
  private lastTick = Date.now()
  private wakeCheckInterval: number | null = null
  private lifecycleStarted = false
  private heartbeatTimer: number | null = null
  private pongTimer: number | null = null
  private lastForceReconnectTs = 0
  private pingSeq = 0
  private connectionEpoch = 0
  /** Consecutive connect attempts that failed (timeout, error, close). */
  private consecutiveFailures = 0
  /** Whether the current connect attempt is the first after a resume. */
  private isResumeAttempt = false
  /**
   * Track all WebSocket instances ever created so we can force-close leaked
   * zombies that Safari keeps alive at the TCP level even after ws.close().
   * Prevents hitting the browser's per-origin connection limit.
   */
  private leakedSockets = new Set<WebSocket>()

  private wsSnap() {
    return {
      status: this.status,
      ws: this.ws ? WS_STATES[this.ws.readyState] : null,
      attempt: this.reconnectAttempts,
      failures: this.consecutiveFailures,
      leaked: this.leakedSockets.size,
      online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
    }
  }

  connect() {
    // Clean up any zombie socket that never opened / already closed
    if (this.ws) {
      const isOpen = this.ws.readyState === WebSocket.OPEN
      // Trust OPEN only when our own state machine also says connected.
      if (isOpen && this.status === 'connected') {
        clientLog('ws_connect_skip', { reason: 'already_open', ...this.wsSnap() })
        return
      }
      clientLog('ws_connect_destroy_zombie', {
        reason: isOpen ? 'open_desynced' : 'not_open',
        ...this.wsSnap(),
      })
      this.destroySocket()
    }

    this.manualClose = false
    this.clearConnectTimer()
    this.setStatus('connecting')

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${scheme}://${window.location.host}/ws`
    clientLog('ws_connect', { url: wsUrl, resume: this.isResumeAttempt, ...this.wsSnap() })

    const ws = new WebSocket(wsUrl)
    this.ws = ws
    this.leakedSockets.add(ws)

    // Use a longer timeout for the first attempt after resume — VPN tunnels
    // need extra time and silently drop SYN packets with no error feedback.
    const timeout = this.isResumeAttempt ? RESUME_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS
    this.isResumeAttempt = false

    // Guard against connections that hang (common on iOS after background)
    this.connectTimer = window.setTimeout(() => {
      // Ignore stale timeout from an earlier socket that was already replaced.
      if (this.ws !== ws) return
      this.connectTimer = null
      const isOpen = ws.readyState === WebSocket.OPEN
      const isHealthyOpen = isOpen && this.status === 'connected'
      if (!isHealthyOpen) {
        clientLog('ws_connect_timeout', {
          wsState: WS_STATES[ws.readyState],
          managerStatus: this.status,
          timeoutMs: timeout,
          ...this.wsSnap(),
        })
        this.consecutiveFailures += 1
        this.destroySocket()
        this.scheduleReconnect()
      }
    }, timeout)

    ws.onopen = () => {
      clientLog('ws_onopen', this.wsSnap())
      this.clearConnectTimer()
      this.reconnectAttempts = 0
      this.consecutiveFailures = 0
      this.connectionEpoch += 1
      // Socket opened successfully — remove from leaked tracking
      this.leakedSockets.delete(ws)
      this.setStatus('connected')
      this.startHeartbeat()
    }

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as ServerMessage
        // Intercept pong — clear timeout only for the current seq.
        if (parsed.type === 'pong') {
          if (parsed.seq === this.pingSeq) {
            this.clearPongTimer()
          }
          return
        }
        this.listeners.forEach((listener) => listener(parsed))
      } catch {
        // Ignore malformed payloads
      }
    }

    ws.onerror = () => {
      clientLog('ws_onerror', this.wsSnap())
      // Don't reconnect here — per the WHATWG spec, onclose always fires
      // after onerror. Let onclose handle reconnection to avoid double-fire.
      this.clearConnectTimer()
    }

    ws.onclose = (e) => {
      clientLog('ws_onclose', { code: e.code, reason: e.reason, clean: e.wasClean, ...this.wsSnap() })
      this.clearConnectTimer()
      this.consecutiveFailures += 1
      this.ws = null
      if (!this.manualClose) {
        this.scheduleReconnect()
      } else {
        this.setStatus('disconnected')
      }
    }
  }

  disconnect() {
    this.manualClose = true
    this.clearConnectTimer()
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.destroySocket()
    this.setStatus('disconnected')
  }

  /**
   * Start listening for page lifecycle events that indicate the app was
   * backgrounded and resumed (iOS Safari PWA, Android Chrome, etc.).
   * Idempotent — repeated calls are no-ops until stopLifecycleListeners().
   */
  startLifecycleListeners() {
    if (this.lifecycleStarted) return
    if (typeof document === 'undefined' || typeof window === 'undefined') return

    this.lifecycleStarted = true
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('pageshow', this.onPageShow)

    // Time-jump detector catches cases where visibility events don't fire
    // (e.g. iOS PWA suspended for a long period)
    this.lastTick = Date.now()
    this.wakeCheckInterval = window.setInterval(() => {
      const now = Date.now()
      const gap = now - this.lastTick
      // Skip while hidden — browser timer clamping causes false positives
      // (e.g. Chrome clamps hidden-tab timers to ~60s, exceeding WAKE_JUMP_MS).
      // Do NOT update lastTick here — keep it frozen at the last visible time
      // so visibilitychange correctly detects the real background duration.
      if (this.isHidden()) {
        return
      }
      if (gap > WAKE_JUMP_MS) {
        clientLog('ws_time_jump', { gapMs: gap, ...this.wsSnap() })
        this.forceReconnect('time_jump', true)
      }
      this.lastTick = now
    }, WAKE_CHECK_INTERVAL_MS)
  }

  stopLifecycleListeners() {
    if (!this.lifecycleStarted) return

    this.lifecycleStarted = false
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('pageshow', this.onPageShow)
    if (this.wakeCheckInterval !== null) {
      window.clearInterval(this.wakeCheckInterval)
      this.wakeCheckInterval = null
    }
  }

  send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false

    try {
      this.ws.send(JSON.stringify(message))
      return true
    } catch (error) {
      clientLog('ws_send_error', {
        messageType: message.type,
        error: error instanceof Error ? error.message : String(error),
        ...this.wsSnap(),
      })
      this.destroySocket()
      this.scheduleReconnect()
      return false
    }
  }

  subscribe(listener: MessageListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeStatus(listener: StatusListener) {
    this.statusListeners.add(listener)
    listener(this.status, this.error, this.connectionEpoch)
    return () => this.statusListeners.delete(listener)
  }

  getStatus() {
    return this.status
  }

  getConnectionEpoch() {
    return this.connectionEpoch
  }

  // ── Private ──────────────────────────────────────────────

  private onVisibilityChange = () => {
    clientLog('ws_visibility', { state: document.visibilityState, ...this.wsSnap() })
    if (document.visibilityState === 'visible') {
      const now = Date.now()
      const gap = now - this.lastTick
      // Reset lastTick before reconnect to prevent the wake-check interval
      // from seeing a stale gap and firing a second forceReconnect.
      this.lastTick = now

      // Always force-reconnect on resume with force=true.  Even short
      // backgrounds (<10 s) can leave zombie sockets on iOS Safari — the
      // verification-ping approach wasted 3 s on a zombie that can never
      // respond.  Instead, tear down immediately and reconnect with a short
      // settle delay so iOS has time to bring the network back.
      clientLog('ws_resume', { gapMs: gap })
      this.forceReconnect('visibilitychange', true)
    } else {
      // Pause heartbeat when hidden — iOS freezes timers anyway,
      // and pong timeout would false-positive on wake.
      this.stopHeartbeat()
      // Cancel pending reconnect — it would fire in the background
      // otherwise (timer was set before the tab was hidden).
      // forceReconnect() handles reconnection when visible again.
      if (this.reconnectTimer) {
        window.clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
    }
  }

  private onPageShow = (e: PageTransitionEvent) => {
    clientLog('ws_pageshow', { persisted: e.persisted, ...this.wsSnap() })
    if (e.persisted) {
      // Reset lastTick to prevent wake-check double reconnect after bfcache restore
      this.lastTick = Date.now()
      this.forceReconnect('pageshow', true)
    }
  }

  /**
   * If the socket isn't cleanly connected, tear it down and start fresh.
   * Resets the backoff counter so the user doesn't wait up to 30s.
   *
   * When `force` is true (resume / suspension), we:
   *   1. Purge all leaked sockets to free browser connection slots
   *   2. Wait RESUME_SETTLE_MS for iOS to restore networking
   *   3. Use a longer connect timeout for the first attempt
   */
  private forceReconnect(trigger: string = 'unknown', force = false) {
    if (this.manualClose) {
      clientLog('ws_force_skip', { trigger, reason: 'manual_close' })
      return
    }

    // Debounce rapid-fire triggers (e.g. visibilitychange + time-jump
    // both firing on resume). Prevents double reconnection.
    // Non-forced triggers use a 500ms debounce window.
    // Forced triggers use a shorter 200ms window — they indicate the socket
    // is definitely stale, but back-to-back forced events (e.g. pageshow +
    // time-jump firing simultaneously) can still tear down a freshly-created
    // socket if not guarded.
    const now = Date.now()
    const debounceMs = force ? 200 : 500
    if (now - this.lastForceReconnectTs < debounceMs) {
      clientLog('ws_force_skip', { trigger, reason: 'debounce', force })
      return
    }

    // When not forced, trust readyState — rely on heartbeat for zombie
    // detection (~30s). When forced (process was suspended), iOS lies
    // about readyState so always tear down and start fresh.
    if (!force &&
        this.ws?.readyState === WebSocket.OPEN &&
        this.status === 'connected') {
      clientLog('ws_force_skip', { trigger, reason: 'already_connected' })
      return
    }

    this.lastForceReconnectTs = now
    clientLog('ws_force_reconnect', { trigger, force, ...this.wsSnap() })
    this.reconnectAttempts = 0
    this.consecutiveFailures = 0
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.destroySocket()

    if (force) {
      // Purge all leaked sockets — iOS Safari keeps zombie TCP connections
      // alive even after ws.close(), which can exhaust the per-origin limit
      // and prevent new connections from being established.
      this.purgeLeakedSockets()

      // Wait for iOS to restore networking before attempting to connect.
      // visibilitychange fires before the network stack is ready (confirmed
      // by WebKit and Apple Developer Forums).  Without this delay, the first
      // connect attempt would hit a dead network and start the backoff loop.
      this.isResumeAttempt = true
      this.setStatus('reconnecting')
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null
        this.connect()
      }, RESUME_SETTLE_MS)
    } else {
      this.connect()
    }
  }

  /**
   * Send periodic application-level pings to detect dead sockets.
   * Bun's protocol-level pings (sendPings: true, idleTimeout: 40) keep the
   * TCP/Tailscale tunnel warm. These application-level pings let the client
   * proactively detect zombie sockets that protocol pings can't surface
   * (browsers don't expose protocol-level pong events to JS).
   */
  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.pingSeq += 1
      if (!this.send({ type: 'ping', seq: this.pingSeq })) return
      // If no pong within timeout, the socket is dead
      this.clearPongTimer()
      this.pongTimer = window.setTimeout(() => {
        this.pongTimer = null
        clientLog('ws_pong_timeout', this.wsSnap())
        this.destroySocket()
        this.scheduleReconnect()
      }, PONG_TIMEOUT_MS)
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.clearPongTimer()
  }

  private clearPongTimer() {
    if (this.pongTimer !== null) {
      window.clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private setStatus(status: ConnectionStatus, error: string | null = null) {
    this.status = status
    this.error = error
    this.statusListeners.forEach((listener) => listener(status, error, this.connectionEpoch))
  }

  private scheduleReconnect() {
    this.stopHeartbeat()
    if (this.isHidden()) {
      clientLog('ws_schedule_skip', { reason: 'hidden', ...this.wsSnap() })
      // Don't reconnect in the background — forceReconnect() handles
      // it when the page becomes visible again.
      this.setStatus('reconnecting')
      return
    }

    // If we've hit the stall threshold, aggressively clean up and add extra
    // cooldown time.  Leaked zombie sockets at the browser level may be
    // exhausting per-origin connection slots, which would explain why
    // force-closing the app (killing all TCP connections) fixes it instantly.
    if (this.consecutiveFailures >= STALL_THRESHOLD) {
      clientLog('ws_stall_detected', this.wsSnap())
      this.purgeLeakedSockets()
      // Give the browser extra time to clean up TCP connections
      this.consecutiveFailures = 0
      this.reconnectAttempts = 0
      this.isResumeAttempt = true
      this.setStatus('reconnecting')
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null
        this.connect()
      }, STALL_COOLDOWN_MS)
      return
    }

    this.reconnectAttempts += 1
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000)
    clientLog('ws_schedule_reconnect', { delay, ...this.wsSnap() })
    this.setStatus('reconnecting')
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private isHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  private clearConnectTimer() {
    if (this.connectTimer) {
      window.clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  /** Forcefully close and null out the socket without triggering reconnect. */
  private destroySocket() {
    this.clearConnectTimer()
    this.stopHeartbeat()
    if (!this.ws) return
    const ws = this.ws
    this.ws = null
    ws.onopen = null
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    try {
      ws.close()
    } catch {
      // Already closed / invalid state
    }
  }

  /**
   * Force-close all previously created sockets that may still be lingering
   * at the browser/TCP level.  On iOS Safari, ws.close() on a zombie socket
   * may have no effect (confirmed by WebKit Bug #247943 and graphql-ws #289),
   * so the browser retains the underlying TCP connection.  If enough zombies
   * accumulate, they can exhaust Safari's per-origin connection limit and
   * prevent new WebSocket connections from being established.
   *
   * This explains why force-closing the PWA fixes the loop instantly — iOS
   * kills all TCP connections belonging to the process.
   */
  private purgeLeakedSockets() {
    if (this.leakedSockets.size === 0) return
    clientLog('ws_purge_leaked', { count: this.leakedSockets.size })
    for (const leaked of this.leakedSockets) {
      try {
        // Null out handlers to prevent any late-firing events
        leaked.onopen = null
        leaked.onmessage = null
        leaked.onerror = null
        leaked.onclose = null
        leaked.close()
      } catch {
        // Already closed / invalid state
      }
    }
    this.leakedSockets.clear()
  }
}

const manager = new WebSocketManager()

export function useWebSocket() {
  const setConnectionStatus = useSessionStore(
    (state) => state.setConnectionStatus
  )
  const setConnectionError = useSessionStore(
    (state) => state.setConnectionError
  )
  const [status, setStatus] = useState<ConnectionStatus>(
    manager.getStatus()
  )
  const [connectionEpoch, setConnectionEpoch] = useState<number>(
    manager.getConnectionEpoch()
  )

  useEffect(() => {
    manager.connect()
    manager.startLifecycleListeners()
    const unsubscribe = manager.subscribeStatus((nextStatus, error, nextConnectionEpoch) => {
      setStatus(nextStatus)
      setConnectionEpoch(nextConnectionEpoch)
      setConnectionStatus(nextStatus)
      setConnectionError(error)
    })

    return () => {
      unsubscribe()
      manager.stopLifecycleListeners()
    }
  }, [setConnectionError, setConnectionStatus])

  const sendMessage = useMemo<SendClientMessage>(
    () => (message) => { void manager.send(message) },
    []
  )
  const subscribe = useMemo(() => manager.subscribe.bind(manager), [])

  return {
    status,
    connectionEpoch,
    sendMessage,
    subscribe,
  }
}
