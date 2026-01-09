import { useEffect, useMemo, useState } from 'react'
import type { ClientMessage, ServerMessage } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSessionStore } from '../stores/sessionStore'

type MessageListener = (message: ServerMessage) => void

type StatusListener = (status: ConnectionStatus, error: string | null) => void

class WebSocketManager {
  private ws: WebSocket | null = null
  private listeners = new Set<MessageListener>()
  private statusListeners = new Set<StatusListener>()
  private status: ConnectionStatus = 'connecting'
  private error: string | null = null
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  private manualClose = false

  connect() {
    if (this.ws) {
      return
    }

    this.manualClose = false
    this.setStatus('connecting')
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${scheme}://${window.location.host}/ws`

    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => {
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
      this.setStatus('error', 'WebSocket error')
    }

    ws.onclose = () => {
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
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
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

  private setStatus(status: ConnectionStatus, error: string | null = null) {
    this.status = status
    this.error = error
    this.statusListeners.forEach((listener) => listener(status, error))
  }

  private scheduleReconnect() {
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
    const unsubscribe = manager.subscribeStatus((nextStatus, error) => {
      setStatus(nextStatus)
      setConnectionStatus(nextStatus)
      setConnectionError(error)
    })

    return () => {
      unsubscribe()
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
