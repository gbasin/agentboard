/**
 * ConnectionIndicator - WebSocket status dot for the desktop sidebar's filter
 * bar. With a Tailscale IP the dot sits inside a bordered square button that
 * matches the settings gear and opens a small popover holding the IP and a
 * click-to-copy remote access URL; the status color stays on the dot. Without
 * an IP it is a plain, borderless, non-interactive status dot.
 *
 * The wrapper is deliberately not `position: relative`: the popover is
 * positioned against the nearest positioned ancestor (the sticky filter bar)
 * so it spans the bar's width and never overflows a narrow sidebar.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { Copy01Icon } from './icons'
import { copyText } from '../utils/copyText'
import type { ConnectionStatus } from '../stores/sessionStore'
import { ICON_BUTTON_CLASS, ICON_SIZE } from './controlStyles'

interface ConnectionIndicatorProps {
  connectionStatus: ConnectionStatus
  tailscaleIp: string | null
  /** 'up' opens the popover above the bar (bottom-anchored sidebar). */
  placement?: 'down' | 'up'
}

const statusDot: Record<ConnectionStatus, string> = {
  connected: 'bg-working',
  connecting: 'bg-approval',
  reconnecting: 'bg-approval',
  disconnected: 'bg-danger',
}

const statusLabel: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
}

export default function ConnectionIndicator({
  connectionStatus,
  tailscaleIp,
  placement = 'down',
}: ConnectionIndicatorProps) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const popoverId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const label = `Connection: ${statusLabel[connectionStatus]}`
  const dot = <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot[connectionStatus]}`} />

  useEffect(() => {
    if (!open || typeof document === 'undefined') return
    if (!document.addEventListener || !document.removeEventListener) return
    const handlePointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null
      if (target && containerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('touchstart', handlePointer, { passive: true })
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('touchstart', handlePointer)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
  }, [])

  if (!tailscaleIp) {
    return (
      <span role="img" aria-label={label} title={label} className="flex h-7 w-5 shrink-0 items-center justify-center">
        {dot}
      </span>
    )
  }

  const handleCopy = () => {
    const url = `http://${tailscaleIp}:${window.location.port || '4040'}`
    copyText(url)
    setCopied(true)
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div ref={containerRef} className="flex shrink-0">
      <button
        type="button"
        aria-label={`${label}. Tailscale remote access`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={`${statusLabel[connectionStatus]} - Tailscale ${tailscaleIp}`}
        onClick={() => setOpen((value) => !value)}
        className={ICON_BUTTON_CLASS}
      >
        {dot}
      </button>
      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="Remote access"
          className={`absolute left-2 right-2 z-20 ${placement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} rounded border border-border bg-surface p-2 text-xs shadow-lg`}
        >
          <div className="flex items-center gap-1.5 px-1 pb-1.5 text-muted">
            {dot}
            <span>{statusLabel[connectionStatus]}</span>
            <span className="ml-auto">Tailscale</span>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left text-secondary hover:bg-hover hover:text-primary"
            title="Tailscale IP - click to copy remote access URL"
          >
            <span className="min-w-0 truncate font-mono">{copied ? 'Copied!' : tailscaleIp}</span>
            {!copied && <Copy01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} className="shrink-0" />}
          </button>
        </div>
      )}
    </div>
  )
}
