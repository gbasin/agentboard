/**
 * TerminalSnapshotLayer - frozen, natively selectable copy of the pane text,
 * laid in place over the terminal for the "Select text" mode.
 *
 * The text block sits on the xterm screen rect with the same font, cell
 * height and (measured) letter-spacing, re-wrapping joined lines at the
 * terminal width, and starts scrolled so the visible screen lines up with
 * what the terminal showed. It is a sibling of the terminal container, so
 * neither the container's touch handlers nor its `data-app-mouse` CSS reach
 * it, and touches stop here so document-level handlers (edge-swipe drawer,
 * a11y selection tracking) never see them either.
 *
 * While open it owns the clipboard text (see snapshotSelection.ts): a copy
 * inside the layer writes the selected rows, rejoined where the app wrapped
 * them itself when `rejoinWrapped` is set (see snapshotRejoin.ts), then
 * closes the layer. It keeps xterm from taking typed or pasted input. Done
 * and Refresh live in the key deck (TerminalControls), not over the text.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { SpinnerIcon } from './icons'
import { ICON_SIZE } from './controlStyles'
import { displaySnapshotText } from '../utils/snapshotText'
import { copyThenAfter, SNAPSHOT_LINE_ATTR } from '../utils/snapshotSelection'
import { findWrappedRows, type RowJoin } from '../utils/snapshotRejoin'
import { measureLetterSpacing, measureTerminalGeometry, type TerminalGeometry } from '../utils/terminalGeometry'
import type { TerminalSnapshotState } from '../hooks/useTerminalSnapshot'

interface Props {
  state: Exclude<TerminalSnapshotState, { status: 'closed' }>
  containerRef: RefObject<HTMLDivElement | null>
  terminalRef: RefObject<Terminal | null>
  background: string
  foreground: string
  /** Rejoin rows the app wrapped itself (TUIs); false copies rows as shown. */
  rejoinWrapped: boolean
  /** Called after a copy made inside the layer has been written. */
  onCopied: () => void
}

const STOPPED_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const

export default function TerminalSnapshotLayer({ state, containerRef, terminalRef, background, foreground, rejoinWrapped, onCopied }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLDivElement | null>(null)
  const [geometry, setGeometry] = useState<TerminalGeometry | null>(null)
  const [letterSpacing, setLetterSpacing] = useState(0)
  const text = state.status === 'ready' ? state.text : null
  const lines = useMemo(() => (text === null ? [] : displaySnapshotText(text).split('\n')), [text])
  const cols = geometry?.cols ?? 0
  const joins = useMemo<RowJoin[]>(
    () => (rejoinWrapped && cols > 0 ? findWrappedRows(lines, cols) : []),
    [lines, cols, rejoinWrapped],
  )
  const copySourceRef = useRef({ lines, joins, onCopied })
  copySourceRef.current = { lines, joins, onCopied }

  // Keep every touch inside the layer away from document/container handlers.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = (event: Event) => event.stopPropagation()
    for (const type of STOPPED_EVENTS) root.addEventListener(type, stop, { passive: true })
    return () => { for (const type of STOPPED_EVENTS) root.removeEventListener(type, stop) }
  }, [])

  // Write the clipboard text ourselves for selections inside the layer, then
  // return to the live terminal once the copy event has finished: closing
  // inside the handler would unmount the selection the copy is reading.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onCopy = (event: ClipboardEvent) => {
      const root = textRef.current
      const { lines: copyLines, joins: copyJoins, onCopied: done } = copySourceRef.current
      if (root) copyThenAfter(event, window.getSelection(), root, copyLines, copyJoins, done)
    }
    document.addEventListener('copy', onCopy, true)
    return () => document.removeEventListener('copy', onCopy, true)
  }, [])

  // Typed (hardware keyboard) or pasted input must not reach the TUI while
  // the pane is frozen; xterm drops input entirely while stdin is disabled.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    const previous = terminal.options.disableStdin ?? false
    terminal.options.disableStdin = true
    return () => { terminal.options.disableStdin = previous }
  }, [terminalRef])

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

  // New text (open or refresh) invalidates any selection made in the old one.
  useLayoutEffect(() => {
    const selection = typeof window === 'undefined' ? null : window.getSelection?.()
    const root = rootRef.current
    if (!selection || !root || selection.rangeCount === 0) return
    if (selection.anchorNode && root.contains(selection.anchorNode)) selection.removeAllRanges()
  }, [text])

  // Start where the terminal was: bottom of the text, minus any tmux
  // copy-mode scroll offset. Re-run when the layout or the text changes.
  const scrollPosition = state.status === 'ready' ? state.scrollPosition : 0
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !geometry || text === null) return
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - scrollPosition * geometry.cellHeight
  }, [geometry, text, scrollPosition, letterSpacing])

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
              // One block per captured line. Lines that fit the terminal never
              // wrap, so a glyph wider than a cell (box drawing in a fallback
              // font) cannot push a row over; longer lines are tmux-joined
              // soft wraps and re-wrap per cell.
              <div key={index} {...{ [SNAPSHOT_LINE_ATTR]: index }} style={[...line].length > geometry.cols
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
    </div>
  )
}
