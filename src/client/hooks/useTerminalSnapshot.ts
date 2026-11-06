/**
 * useTerminalSnapshot - request/response state for the "Select text" mode.
 * open() asks the server for the pane's plain text over the WebSocket; the
 * reply is matched by requestId so a late answer for an older request (or
 * another session) is ignored. Switching sessions closes the snapshot. It
 * subscribes only while a request is in flight.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SendClientMessage, SubscribeServerMessage } from '@shared/types'

export type TerminalSnapshotState =
  | { status: 'closed' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; text: string; scrollPosition: number; historyLines: number; captureMs: number }

interface Options {
  sessionId: string | null
  sendMessage: SendClientMessage
  subscribe: SubscribeServerMessage
}

export function useTerminalSnapshot({ sessionId, sendMessage, subscribe }: Options) {
  const [state, setState] = useState<TerminalSnapshotState>({ status: 'closed' })
  const requestIdRef = useRef(0)

  useEffect(() => {
    requestIdRef.current += 1
    setState({ status: 'closed' })
  }, [sessionId])

  // Subscribe only while a request is in flight, so an idle board carries
  // no extra listener.
  const loading = state.status === 'loading'
  useEffect(() => loading ? subscribe((message) => {
    if (message.type !== 'terminal-snapshot') return
    if (message.sessionId !== sessionId || message.requestId !== requestIdRef.current) return
    if (!message.ok || typeof message.text !== 'string') {
      setState({ status: 'error' })
      return
    }
    setState({
      status: 'ready',
      text: message.text,
      scrollPosition: message.scrollPosition ?? 0,
      historyLines: message.historyLines ?? 0,
      captureMs: message.captureMs ?? 0,
    })
  }) : undefined, [loading, sessionId, subscribe])

  const open = useCallback(() => {
    if (!sessionId) return
    const requestId = ++requestIdRef.current
    if (sendMessage({ type: 'terminal-snapshot-request', sessionId, requestId }) === false) {
      setState({ status: 'error' })
      return
    }
    setState({ status: 'loading' })
  }, [sessionId, sendMessage])

  const close = useCallback(() => {
    requestIdRef.current += 1
    setState({ status: 'closed' })
  }, [])

  return { state, open, close }
}
