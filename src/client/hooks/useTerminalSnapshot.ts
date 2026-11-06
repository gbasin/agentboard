/**
 * useTerminalSnapshot - request/response state for the "Select text" mode.
 * open() asks the server for the pane's plain text over the WebSocket; the
 * reply is matched by requestId so a late answer for an older request (or
 * another session) is ignored. refresh() re-captures while the current text
 * stays on screen. Switching sessions closes the snapshot. It subscribes
 * only while a request is in flight.
 *
 * useOpenSelectText is the Select key's action: it drops the keyboard and any
 * a11y selection and opens a snapshot. When the on-screen keyboard was up,
 * the capture waits for the terminal to grow back and the TUI to redraw, so
 * the frozen text matches the screen it covers.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { SendClientMessage, SubscribeServerMessage } from '@shared/types'

export type TerminalSnapshotState =
  | { status: 'closed' }
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready'
      text: string
      scrollPosition: number
      historyLines: number
      captureMs: number
      /** The pane was on the alternate screen (a fullscreen TUI). */
      altScreen: boolean
      /** A re-capture is in flight; the text shown is the previous one. */
      refreshing: boolean
    }

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
  const waiting = state.status === 'loading' || (state.status === 'ready' && state.refreshing)
  useEffect(() => waiting ? subscribe((message) => {
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
      altScreen: message.altScreen ?? false,
      refreshing: false,
    })
  }) : undefined, [waiting, sessionId, subscribe])

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }
  useEffect(() => clearTimer, [sessionId])

  const request = useCallback((keepText: boolean, delayMs = 0) => {
    if (!sessionId) return
    clearTimer()
    const requestId = ++requestIdRef.current
    const send = () => {
      timerRef.current = null
      if (requestId !== requestIdRef.current) return
      if (sendMessage({ type: 'terminal-snapshot-request', sessionId, requestId }) === false) {
        setState({ status: 'error' })
      }
    }
    setState((prev) => keepText && prev.status === 'ready' ? { ...prev, refreshing: true } : { status: 'loading' })
    if (delayMs > 0) timerRef.current = setTimeout(send, delayMs)
    else send()
  }, [sessionId, sendMessage])

  const open = useCallback((delayMs = 0) => request(false, delayMs), [request])
  const refresh = useCallback(() => request(true), [request])

  const close = useCallback(() => {
    clearTimer()
    requestIdRef.current += 1
    setState({ status: 'closed' })
  }, [])

  return { state, open, refresh, close }
}

/** How long the on-screen keyboard takes to hide and the TUI to redraw. */
export const KEYBOARD_SETTLE_MS = 600

export function useOpenSelectText(
  open: (delayMs?: number) => void,
  clearIOSSelectionRef: MutableRefObject<(() => void) | null>,
) {
  return useCallback(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    const keyboardUp = !!active?.classList?.contains('xterm-helper-textarea')
    ;(active as HTMLElement | null)?.blur?.()
    clearIOSSelectionRef.current?.()
    open(keyboardUp ? KEYBOARD_SETTLE_MS : 0)
  }, [open, clearIOSSelectionRef])
}

/**
 * Copy rejoins app-wrapped rows only where the app wraps itself: a pane on
 * the alternate screen (fullscreen TUI) or a session whose agent is known
 * (non-fullscreen Claude Code also hard-wraps). In a plain shell tmux's -J
 * capture is already exact, so a heuristic could only do harm.
 */
export function shouldRejoinWrapped(state: TerminalSnapshotState, agentType: string | undefined | null): boolean {
  return (state.status === 'ready' && state.altScreen) || !!agentType
}
