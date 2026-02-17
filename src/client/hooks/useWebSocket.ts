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
 */
import { useEffect, useMemo, useState } from 'react'
import type { ClientMessage, SendClientMessage, ServerMessage } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSessionStore } from '../stores/sessionStore'
import { clientLog } from '../utils/clientLog'

type MessageListener = (message: ServerMessage) => void

type StatusListener = (status: ConnectionStatus, error: string | null) => void

const WS_STATES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const

/** How long to wait for a WebSocket to reach OPEN before giving up. */
const CONNECT_TIMEOUT_MS = 10_000

/**
 * If the interval timer detects a time jump larger than this, the device
 * likely slept or the PWA was suspended. Force a fresh reconnect.
 */
const WAKE_JUMP_MS = 15_000

/** Tick interval for the time-jump detector. */
const WAKE_CHECK_INTERVAL_MS = 5_000

/** Gap threshold for detecting process suspension on visibility resume. */
const SUSPEND_THRESHOLD_MS = 10_000

/** How often to send an application-level ping to detect dead sockets. */
const HEARTBEAT_INTERVAL_MS = 20_000

/** How long to wait for a pong before declaring the socket dead. */
const PONG_TIMEOUT_MS = 10_000

/** How long to wait for a verification pong on non-suspended resume. */
const RESUME_PONG_TIMEOUT_MS = 3_000

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

  private wsSnap() {
    return { status: this.status, ws: this.ws ? WS_STATES[this.ws.readyState] : null, attempt: this.reconnectAttempts }
  }

  connect() {
    // Clean up any zombie socket that never opened / already closed
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        clientLog('ws_connect_skip', { reason: 'already_open', ...this.wsSnap() })
        return
      }
      clientLog('ws_connect_destroy_zombie', this.wsSnap())
      this.destroySocket()
    }

    this.manualClose = false
    this.clearConnectTimer()
    this.setStatus('connecting')

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${scheme}://${window.location.host}/ws`
    clientLog('ws_connect', { url: wsUrl, ...this.wsSnap() })

    const ws = new WebSocket(wsUrl)
    this.ws = ws

    // Guard against connections that hang (common on iOS after background)
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null
      if (ws.readyState !== WebSocket.OPEN) {
        clientLog('ws_connect_timeout', { wsState: WS_STATES[ws.readyState], ...this.wsSnap() })
        this.destroySocket()
        this.scheduleReconnect()
      }
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      clientLog('ws_onopen', this.wsSnap())
      this.clearConnectTimer()
      this.reconnectAttempts = 0
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
    listener(this.status, this.error)
    return () => this.statusListeners.delete(listener)
  }

  getStatus() {
    return this.status
  }

  // ── Private ──────────────────────────────────────────────

  private onVisibilityChange = () => {
    clientLog('ws_visibility', { state: document.visibilityState, ...this.wsSnap() })
    if (document.visibilityState === 'visible') {
      const now = Date.now()
      const gap = now - this.lastTick
      const wasSuspended = gap > SUSPEND_THRESHOLD_MS
      // Reset lastTick before reconnect to prevent the wake-check interval
      // from seeing a stale gap and firing a second forceReconnect.
      this.lastTick = now
      this.forceReconnect('visibilitychange', wasSuspended)
      // On non-suspended resume: restart heartbeat and send a verification ping
      // to detect zombie sockets that iOS reports as OPEN for ~18ms after wake.
      // Desktop: pong arrives in ms, no disruption. iOS zombie: caught in 3s.
      if (!wasSuspended && this.status === 'connected') {
        this.startHeartbeat()
        this.sendVerificationPing()
      }
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
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.destroySocket()
    this.connect()
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

  /**
   * Send a verification ping with a short timeout to detect zombie sockets
   * on resume. If no matching pong arrives within RESUME_PONG_TIMEOUT_MS,
   * tear down and immediately reconnect.
   */
  private sendVerificationPing() {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.pingSeq += 1
    const seq = this.pingSeq
    clientLog('ws_resume_verify', { seq, ...this.wsSnap() })
    if (!this.send({ type: 'ping', seq })) return
    this.clearPongTimer()
    this.pongTimer = window.setTimeout(() => {
      this.pongTimer = null
      clientLog('ws_resume_verify_timeout', { seq, ...this.wsSnap() })
      this.destroySocket()
      this.reconnectAttempts = 0
      this.connect()
    }, RESUME_PONG_TIMEOUT_MS)
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
    this.statusListeners.forEach((listener) => listener(status, error))
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

  useEffect(() => {
    manager.connect()
    manager.startLifecycleListeners()
    const unsubscribe = manager.subscribeStatus((nextStatus, error) => {
      setStatus(nextStatus)
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
    sendMessage,
    subscribe,
  }
}
