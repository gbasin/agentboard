/**
 * useWebSocket.ts — WebSocket connection manager with iOS Safari PWA support.
 *
 * Handles reconnection after background/foreground transitions via:
 * - visibilitychange listener (most common resume path)
 * - pageshow listener (bfcache restore)
 * - Time-jump detector (fallback for deep PWA suspension)
 * - Connection timeout (prevents zombie sockets from blocking reconnect)
 */
import { useEffect, useMemo, useState } from 'react'
import type { ClientMessage, ServerMessage } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSessionStore } from '../stores/sessionStore'

type MessageListener = (message: ServerMessage) => void

type StatusListener = (status: ConnectionStatus, error: string | null) => void

/** How long to wait for a WebSocket to reach OPEN before giving up. */
const CONNECT_TIMEOUT_MS = 5_000

/**
 * If the interval timer detects a time jump larger than this, the device
 * likely slept or the PWA was suspended. Force a fresh reconnect.
 */
const WAKE_JUMP_MS = 15_000

/** Tick interval for the time-jump detector. */
const WAKE_CHECK_INTERVAL_MS = 5_000

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

  connect() {
    // Clean up any zombie socket that never opened / already closed
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) return
      this.destroySocket()
    }

    this.manualClose = false
    this.clearConnectTimer()
    this.setStatus('connecting')

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${scheme}://${window.location.host}/ws`

    const ws = new WebSocket(wsUrl)
    this.ws = ws

    // Guard against connections that hang (common on iOS after background)
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null
      if (ws.readyState !== WebSocket.OPEN) {
        this.destroySocket()
        this.scheduleReconnect()
      }
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      this.clearConnectTimer()
      this.reconnectAttempts = 0
      this.setStatus('connected')
    }

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as ServerMessage
        this.listeners.forEach((listener) => listener(parsed))
      } catch {
        // Ignore malformed payloads
      }
    }

    ws.onerror = () => {
      this.clearConnectTimer()
      this.destroySocket()
      this.scheduleReconnect()
    }

    ws.onclose = () => {
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
    if (typeof document === 'undefined') return

    this.lifecycleStarted = true
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('pageshow', this.onPageShow)

    // Time-jump detector catches cases where visibility events don't fire
    // (e.g. iOS PWA suspended for a long period)
    this.lastTick = Date.now()
    this.wakeCheckInterval = window.setInterval(() => {
      const now = Date.now()
      if (now - this.lastTick > WAKE_JUMP_MS) {
        this.forceReconnect()
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

  send(message: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
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
    if (document.visibilityState === 'visible') {
      this.forceReconnect()
    }
  }

  private onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) {
      this.forceReconnect()
    }
  }

  /**
   * If the socket isn't cleanly connected, tear it down and start fresh.
   * Resets the backoff counter so the user doesn't wait up to 30s.
   */
  private forceReconnect() {
    if (this.manualClose) return

    // If socket reports OPEN but our status isn't 'connected', it's a
    // zombie — tear it down. This catches iOS sockets that stay OPEN
    // after wake but are actually dead.
    if (this.ws?.readyState === WebSocket.OPEN && this.status === 'connected')
      return

    this.reconnectAttempts = 0
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.destroySocket()
    this.connect()
  }

  private setStatus(status: ConnectionStatus, error: string | null = null) {
    this.status = status
    this.error = error
    this.statusListeners.forEach((listener) => listener(status, error))
  }

  private scheduleReconnect() {
    if (this.isHidden()) {
      // Don't reconnect in the background — forceReconnect() handles
      // it when the page becomes visible again.
      this.setStatus('reconnecting')
      return
    }

    this.reconnectAttempts += 1
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000)
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

  const sendMessage = useMemo(() => manager.send.bind(manager), [])
  const subscribe = useMemo(() => manager.subscribe.bind(manager), [])

  return {
    status,
    sendMessage,
    subscribe,
  }
}
