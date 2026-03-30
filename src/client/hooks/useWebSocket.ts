/**
 * useWebSocket.ts — WebSocket connection manager with iOS Safari PWA support.
 *
 * Resume strategy (visibilitychange → visible):
 *
 *   Industry consensus (Socket.IO, graphql-ws, tRPC, ActionCable) is to
 *   force-reconnect on every resume.  We intentionally deviate from this
 *   because on iOS Safari PWA, destroying a healthy socket and creating a
 *   new WebSocket during the visibility transition frequently fails — the
 *   new connection hangs or is rejected, causing an unrecoverable reconnect
 *   loop.  Force-closing the app clears all TCP connections at the OS level
 *   and "fixes" it, but that's not a real solution.
 *
 *   Instead, we verify the existing socket with a quick ping before
 *   destroying it.  For the common case (short background, healthy socket),
 *   the pong arrives in <100 ms and we avoid creating any new connections.
 *   For zombie sockets (iOS reports readyState OPEN but the socket is dead),
 *   the verify times out after 1.5 s and we fall back to force-reconnect.
 *   Because force-reconnect only runs when truly needed (not every resume),
 *   zombie TCP connections don't accumulate and the reconnect is more likely
 *   to succeed.
 *
 * Other reconnection triggers:
 * - pageshow (bfcache restore — always forces reconnect)
 * - Time-jump detector (fallback for deep PWA suspension — always forces)
 * - Connection timeout (prevents zombie sockets from blocking reconnect)
 * - Application-level ping/pong heartbeat (detects dead sockets in foreground)
 * - Debounce on forceReconnect (prevents double reconnect from overlapping triggers)
 * - Leaked socket tracking (force-closes all prior sockets to avoid browser limits)
 * - Resume delay (waits for iOS to restore network before first connect attempt)
 */
import { useEffect, useMemo } from 'react'
import type { ClientMessage, SendClientMessage, ServerMessage, ServerMessageWithDiagnostics } from '@shared/types'
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

/** How often to send an application-level ping to detect dead sockets. */
const HEARTBEAT_INTERVAL_MS = 20_000

/** How long to wait for a pong before declaring the socket dead. */
const PONG_TIMEOUT_MS = 10_000

/**
 * How long to wait for a verification pong on resume before concluding the
 * socket is a zombie and falling back to force-reconnect.  1.5 s is enough
 * for a round-trip on any reasonable network while being short enough that
 * zombie detection feels responsive.
 */
const VERIFY_PONG_TIMEOUT_MS = 1_500

/**
 * After a successful verification, send the first heartbeat ping sooner than
 * the normal 20 s interval to quickly catch sockets that pass verification
 * but die shortly after (e.g. flaky post-resume network).
 */
const EARLY_HEARTBEAT_MS = 5_000

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
  /** Pending verification timer — non-null while awaiting a verify pong. */
  private verifyTimer: number | null = null

  private wsSnap() {
    return {
      status: this.status,
      ws: this.ws ? WS_STATES[this.ws.readyState] : null,
      attempt: this.reconnectAttempts,
      failures: this.consecutiveFailures,
      leaked: this.leakedSockets.size,
      online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
      verifying: this.verifyTimer !== null,
      buffered: this.ws ? this.ws.bufferedAmount : undefined,
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
    clientLog('ws_connect', { url: wsUrl, resume: this.isResumeAttempt, ...this.wsSnap() }, 'info')

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
        }, 'info')
        this.consecutiveFailures += 1
        this.destroySocket()
        this.scheduleReconnect()
      }
    }, timeout)

    ws.onopen = () => {
      // Guard: ignore late events from a socket that was already replaced.
      // iOS Safari can queue events during resume and dispatch them after
      // a new socket has been created.
      if (this.ws !== ws) {
        clientLog('ws_onopen_stale', this.wsSnap(), 'info')
        return
      }
      clientLog('ws_onopen', this.wsSnap(), 'info')
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
        const raw = event.data as string
        const t0 = performance.now()
        const parsed = JSON.parse(raw) as ServerMessage
        const parseMs = performance.now() - t0
        // Attach timing metadata for switch diagnostics (read by useTerminal)
        const withDiag = parsed as ServerMessageWithDiagnostics
        withDiag._parseMs = Math.round(parseMs)
        withDiag._rawLength = raw.length
        // Intercept pong — clear timeout only for the current seq.
        if (parsed.type === 'pong') {
          if (parsed.seq === this.pingSeq) {
            this.clearPongTimer()
            // If we were waiting for a verification pong, the socket is
            // confirmed alive — cancel the verify timeout and resume normal
            // operation with an early heartbeat to catch post-resume flakiness.
            if (this.verifyTimer !== null) {
              this.cancelVerify()
              clientLog('ws_verify_ok', this.wsSnap(), 'info')
              this.startHeartbeat(EARLY_HEARTBEAT_MS)
            }
          }
          return
        }
        this.listeners.forEach((listener) => listener(parsed))
      } catch {
        // Ignore malformed payloads
      }
    }

    ws.onerror = () => {
      if (this.ws !== ws) return
      clientLog('ws_onerror', this.wsSnap(), 'info')
      // Don't reconnect here — per the WHATWG spec, onclose always fires
      // after onerror. Let onclose handle reconnection to avoid double-fire.
      this.clearConnectTimer()
    }

    ws.onclose = (e) => {
      // Guard: ignore close events from a socket that was already replaced.
      if (this.ws !== ws) {
        clientLog('ws_onclose_stale', { code: e.code, ...this.wsSnap() }, 'info')
        return
      }
      clientLog('ws_onclose', { code: e.code, reason: e.reason, clean: e.wasClean, ...this.wsSnap() }, 'info')
      this.clearConnectTimer()
      this.cancelVerify()
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
    this.cancelVerify()
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
        clientLog('ws_time_jump', { gapMs: gap, ...this.wsSnap() }, 'info')
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
      }, 'info')
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
    clientLog('ws_visibility', { state: document.visibilityState, ...this.wsSnap() }, 'info')
    if (document.visibilityState === 'visible') {
      const now = Date.now()
      const gap = now - this.lastTick
      // Reset lastTick before reconnect to prevent the wake-check interval
      // from seeing a stale gap and firing a second forceReconnect.
      this.lastTick = now

      clientLog('ws_resume', { gapMs: gap, ...this.wsSnap() }, 'info')

      // If the socket still reports OPEN, verify it with a quick ping before
      // tearing it down.  On short backgrounds the socket is almost always
      // healthy — destroying it and creating a new WebSocket during the iOS
      // resume transition is what causes the unrecoverable reconnect loop.
      // See file-level comment for the full rationale.
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.verifyConnection()
      } else {
        // Socket already closed/closing/connecting — go straight to reconnect
        this.forceReconnect('visibilitychange', true)
      }
    } else {
      // Pause heartbeat when hidden — iOS freezes timers anyway,
      // and pong timeout would false-positive on wake.
      this.stopHeartbeat()
      this.cancelVerify()
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
    clientLog('ws_pageshow', { persisted: e.persisted, ...this.wsSnap() }, 'info')
    if (e.persisted) {
      // Reset lastTick to prevent wake-check double reconnect after bfcache restore
      this.lastTick = Date.now()
      this.forceReconnect('pageshow', true)
    }
  }

  /**
   * Send a verification ping on the existing socket to check if it's still
   * alive after a background/foreground transition.  If the server responds
   * with a matching pong within VERIFY_PONG_TIMEOUT_MS, the socket is
   * confirmed healthy and we restart the heartbeat.  If no pong arrives in
   * time, the socket is a zombie — fall back to forceReconnect.
   *
   * On zombie sockets, send() succeeds silently (data is buffered but never
   * delivered, per WHATWG spec).  The timeout is the real detection mechanism.
   */
  private verifyConnection() {
    this.cancelVerify()
    // Stop heartbeat so an in-flight pong timeout can't race with verify.
    // Both use pingSeq — advancing it here would orphan any pending heartbeat
    // pong, causing pongTimer to fire and kill a healthy socket.
    this.stopHeartbeat()
    this.pingSeq += 1
    const seq = this.pingSeq
    const ws = this.ws
    clientLog('ws_verify', { seq, ...this.wsSnap() }, 'info')

    // send() checks readyState and wraps in try/catch.  If it fails, the
    // socket is clearly dead — go straight to force-reconnect.
    if (!this.send({ type: 'ping', seq })) {
      clientLog('ws_verify_send_fail', this.wsSnap(), 'info')
      this.forceReconnect('verify_send_fail', true)
      return
    }

    this.verifyTimer = window.setTimeout(() => {
      this.verifyTimer = null
      // Guard: ignore stale timeout from a socket that was already replaced.
      if (this.ws !== ws) return
      clientLog('ws_verify_timeout', this.wsSnap(), 'info')
      this.forceReconnect('verify_timeout', true)
    }, VERIFY_PONG_TIMEOUT_MS)
  }

  private cancelVerify() {
    if (this.verifyTimer !== null) {
      window.clearTimeout(this.verifyTimer)
      this.verifyTimer = null
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
    clientLog('ws_force_reconnect', { trigger, force, ...this.wsSnap() }, 'info')
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
   *
   * @param firstDelayMs — if provided, fire the first ping after this delay
   *   instead of waiting the full HEARTBEAT_INTERVAL_MS.  Used after
   *   verification to quickly catch flaky post-resume sockets.
   */
  private startHeartbeat(firstDelayMs?: number) {
    this.stopHeartbeat()

    const sendPing = () => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.pingSeq += 1
      if (!this.send({ type: 'ping', seq: this.pingSeq })) return
      // If no pong within timeout, the socket is dead
      this.clearPongTimer()
      this.pongTimer = window.setTimeout(() => {
        this.pongTimer = null
        clientLog('ws_pong_timeout', this.wsSnap(), 'info')
        this.destroySocket()
        this.scheduleReconnect()
      }, PONG_TIMEOUT_MS)
    }

    if (firstDelayMs !== undefined && firstDelayMs < HEARTBEAT_INTERVAL_MS) {
      // Fire one early ping, then switch to the normal interval.
      this.heartbeatTimer = window.setTimeout(() => {
        sendPing()
        this.heartbeatTimer = window.setInterval(sendPing, HEARTBEAT_INTERVAL_MS)
      }, firstDelayMs)
    } else {
      this.heartbeatTimer = window.setInterval(sendPing, HEARTBEAT_INTERVAL_MS)
    }
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      // Could be either setTimeout (early ping) or setInterval — both
      // use the same ID space and clearTimeout/clearInterval are
      // interchangeable per the HTML spec.
      window.clearTimeout(this.heartbeatTimer)
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
      clientLog('ws_stall_detected', this.wsSnap(), 'info')
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
    this.cancelVerify()
    if (!this.ws) return
    const ws = this.ws
    this.ws = null
    // Re-track as potentially leaked — even healthy sockets can become TCP
    // zombies when destroyed after resume on iOS Safari.  This ensures
    // purgeLeakedSockets() can attempt to close them.
    this.leakedSockets.add(ws)
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
    clientLog('ws_purge_leaked', { count: this.leakedSockets.size }, 'info')
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
  const setConnectionState = useSessionStore(
    (state) => state.setConnectionState
  )

  useEffect(() => {
    manager.connect()
    manager.startLifecycleListeners()
    const unsubscribe = manager.subscribeStatus((nextStatus, error, nextConnectionEpoch) => {
      // Atomic Zustand update — connectionStatus and connectionEpoch land in the
      // same store commit, so useTerminal sees both changes in a single render.
      // Previously connectionEpoch was in React useState while connectionStatus
      // was in Zustand, causing two renders and a double terminal-attach.
      setConnectionState(nextStatus, error, nextConnectionEpoch)
    })

    return () => {
      unsubscribe()
      manager.stopLifecycleListeners()
    }
  }, [setConnectionState])

  const sendMessage = useMemo<SendClientMessage>(
    () => (message) => { void manager.send(message) },
    []
  )
  const subscribe = useMemo(() => manager.subscribe.bind(manager), [])
  // Stable getter that reads the manager's epoch synchronously — safe to call
  // inside subscription callbacks without waiting for a React re-render.
  const getConnectionEpoch = useMemo(() => () => manager.getConnectionEpoch(), [])

  return {
    sendMessage,
    subscribe,
    getConnectionEpoch,
  }
}
