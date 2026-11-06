/**
 * TerminalSnapshotLayer - frozen, natively selectable copy of the pane text,
 * laid in place over the terminal for the "Select text" mode.
 *
 * The text block sits on the xterm screen rect with the same font, cell
 * height and (measured) letter-spacing, re-wrapping joined lines at the
 * terminal width, and starts scrolled so the visible screen lines up with
 * what the terminal showed. Touches stop at this layer so the terminal's
 * gesture handlers (scroll, remote selection, edge-swipe drawer) never see
 * them; iOS native selection, handles and the Copy callout work normally.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { CheckIcon, Copy01Icon, SpinnerIcon, XCloseIcon } from './icons'
import { ICON_SIZE } from './controlStyles'
import { cleanSnapshotText, displaySnapshotText } from '../utils/snapshotText'
import { copyTextWithResult } from '../utils/copyTextWithResult'
import type { TerminalSnapshotState } from '../hooks/useTerminalSnapshot'

interface Props {
  state: Exclude<TerminalSnapshotState, { status: 'closed' }>
  containerRef: RefObject<HTMLDivElement | null>
  terminalRef: RefObject<Terminal | null>
  background: string
  foreground: string
  onClose: () => void
}

interface Geometry {
  left: number
  top: number
  width: number
  height: number
  cols: number
  cellWidth: number
  cellHeight: number
  fontSize: number
  fontFamily: string
}

const STOPPED_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const

/** Screen rect and cell metrics of the xterm grid, relative to its container. */
export function measureTerminalGeometry(container: HTMLElement, terminal: Terminal): Geometry | null {
  const screen = container.querySelector('.xterm-screen') as HTMLElement | null
  if (!screen || terminal.cols <= 0 || terminal.rows <= 0) return null
  const containerRect = container.getBoundingClientRect()
  const screenRect = screen.getBoundingClientRect()
  if (screenRect.width <= 0 || screenRect.height <= 0) return null
  const fontSize = terminal.options.fontSize ?? 13
  const fontFamily = terminal.options.fontFamily ?? 'monospace'
  const cellWidth = screenRect.width / terminal.cols
  return {
    left: screenRect.left - containerRect.left,
    top: screenRect.top - containerRect.top,
    width: screenRect.width,
    height: screenRect.height,
    cols: terminal.cols,
    cellWidth,
    cellHeight: screenRect.height / terminal.rows,
    fontSize,
    fontFamily,
  }
}

/** Letter-spacing that makes glyphs inside `element` advance one cell each. */
export function measureLetterSpacing(element: HTMLElement, cellWidth: number): number {
  const probe = document.createElement('span')
  probe.textContent = '0'.repeat(200)
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;letter-spacing:0px'
  element.appendChild(probe)
  const domCharWidth = probe.getBoundingClientRect().width / 200
  probe.remove()
  return domCharWidth > 0 ? Math.max(-2, Math.min(2, cellWidth - domCharWidth)) : 0
}

export default function TerminalSnapshotLayer({ state, containerRef, terminalRef, background, foreground, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLDivElement | null>(null)
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [letterSpacing, setLetterSpacing] = useState(0)
  const [copied, setCopied] = useState(false)
  const text = state.status === 'ready' ? state.text : null
  const lines = useMemo(() => (text === null ? [] : displaySnapshotText(text).split('\n')), [text])

  // Keep every touch inside the layer away from document/container handlers.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = (event: Event) => event.stopPropagation()
    for (const type of STOPPED_EVENTS) root.addEventListener(type, stop, { passive: true })
    return () => { for (const type of STOPPED_EVENTS) root.removeEventListener(type, stop) }
  }, [])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const terminal = terminalRef.current
      if (terminal) setGeometry(measureTerminalGeometry(container, terminal))
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(container)
    return () => observer?.disconnect()
  }, [containerRef, terminalRef])

  // Measured in the text element itself so the probe inherits its exact font.
  useLayoutEffect(() => {
    if (textRef.current && geometry) setLetterSpacing(measureLetterSpacing(textRef.current, geometry.cellWidth))
  }, [geometry, text])

  // Start where the terminal was: bottom of the text, minus any tmux
  // copy-mode scroll offset. Re-run when the layout changes (keyboard hide).
  const scrollPosition = state.status === 'ready' ? state.scrollPosition : 0
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !geometry || text === null) return
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - scrollPosition * geometry.cellHeight
  }, [geometry, text, scrollPosition, letterSpacing])

  const copyAll = async () => {
    if (text === null) return
    if (await copyTextWithResult(cleanSnapshotText(text))) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }
  }

  const buttonClass = 'flex h-8 items-center gap-1.5 rounded-md border border-border bg-elevated/95 px-2.5 text-xs font-medium text-primary shadow-lg backdrop-blur-sm active:scale-95 select-none'

  return (
    <div ref={rootRef} data-testid="terminal-snapshot-layer" className="absolute inset-0 z-[45]"
      style={{ backgroundColor: background }}>
      {state.status === 'ready' && geometry && (
        <div ref={scrollerRef} data-testid="terminal-snapshot-scroller"
          className="absolute overflow-y-auto overflow-x-hidden"
          style={{ left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height,
            overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}>
          <div ref={textRef} data-testid="terminal-snapshot-text"
            style={{
              // Half a cell of slack so sub-pixel rounding cannot wrap a
              // full-width row one column early.
              width: geometry.width + geometry.cellWidth / 2,
              margin: 0, color: foreground, fontFamily: geometry.fontFamily, fontSize: geometry.fontSize,
              lineHeight: `${geometry.cellHeight}px`, letterSpacing,
              fontKerning: 'none', fontVariantLigatures: 'none',
              WebkitUserSelect: 'text', userSelect: 'text', WebkitTouchCallout: 'default',
              WebkitTextSizeAdjust: '100%',
            } as CSSProperties}>
            {lines.map((line, index) => (
              // One block per captured line (copies as a newline). Lines that
              // fit the terminal never wrap, so a glyph wider than a cell
              // (box drawing in a fallback font) cannot push a row over;
              // longer lines are tmux-joined soft wraps and re-wrap per cell.
              <div key={index} style={[...line].length > geometry.cols
                ? { whiteSpace: 'break-spaces', wordBreak: 'break-all', lineBreak: 'anywhere' }
                : { whiteSpace: 'pre', overflow: 'hidden' }}>
                {line === '' ? <br /> : line}
              </div>
            ))}
          </div>
        </div>
      )}
      {state.status !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted">
          {state.status === 'loading'
            ? <><SpinnerIcon width={ICON_SIZE.pill} height={ICON_SIZE.pill} className="animate-spin" /> Capturing text</>
            : 'Could not capture the pane text'}
        </div>
      )}
      <div className="absolute right-2 top-2 flex gap-2">
        {state.status === 'ready' && (
          <button type="button" className={buttonClass} onClick={copyAll} aria-label="Copy all text">
            {copied ? <CheckIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
              : <Copy01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />}
            {copied ? 'Copied' : 'Copy all'}
          </button>
        )}
        <button type="button" className={buttonClass} onClick={onClose} aria-label="Done selecting text">
          <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
          Done
        </button>
      </div>
    </div>
  )
}
