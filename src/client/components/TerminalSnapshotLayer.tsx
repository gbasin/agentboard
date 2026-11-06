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
 * While open it owns the clipboard text (see snapshotSelection.ts), keeps
 * xterm from taking typed or pasted input, and offers Copy all, Refresh and
 * Done.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { CheckIcon, Copy01Icon, RefreshCcw01Icon, SpinnerIcon, XCloseIcon } from './icons'
import { ICON_SIZE } from './controlStyles'
import { cleanSnapshotText, displaySnapshotText } from '../utils/snapshotText'
import { handleSnapshotCopy, SNAPSHOT_LINE_ATTR } from '../utils/snapshotSelection'
import { measureLetterSpacing, measureTerminalGeometry, type TerminalGeometry } from '../utils/terminalGeometry'
import { copyTextWithResult } from '../utils/copyTextWithResult'
import type { TerminalSnapshotState } from '../hooks/useTerminalSnapshot'

interface Props {
  state: Exclude<TerminalSnapshotState, { status: 'closed' }>
  containerRef: RefObject<HTMLDivElement | null>
  terminalRef: RefObject<Terminal | null>
  background: string
  foreground: string
  onRefresh: () => void
  onClose: () => void
}

const STOPPED_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const

const BUTTON_CLASS = 'flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-md border border-border bg-elevated/95 px-3 text-xs font-medium text-primary shadow-lg backdrop-blur-sm active:scale-95 select-none disabled:opacity-60'

export default function TerminalSnapshotLayer({ state, containerRef, terminalRef, background, foreground, onRefresh, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLDivElement | null>(null)
  const [geometry, setGeometry] = useState<TerminalGeometry | null>(null)
  const [letterSpacing, setLetterSpacing] = useState(0)
  const [copied, setCopied] = useState(false)
  const text = state.status === 'ready' ? state.text : null
  const refreshing = state.status === 'ready' && state.refreshing
  const lines = useMemo(() => (text === null ? [] : displaySnapshotText(text).split('\n')), [text])
  const linesRef = useRef(lines)
  linesRef.current = lines

  // Keep every touch inside the layer away from document/container handlers.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = (event: Event) => event.stopPropagation()
    for (const type of STOPPED_EVENTS) root.addEventListener(type, stop, { passive: true })
    return () => { for (const type of STOPPED_EVENTS) root.removeEventListener(type, stop) }
  }, [])

  // Write the clipboard text ourselves: for selections inside the layer, and
  // for "Copy all", which triggers a copy event with the text it wants.
  const pendingCopyRef = useRef<string | null>(null)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onCopy = (event: ClipboardEvent) => {
      const pending = pendingCopyRef.current
      if (pending !== null && event.clipboardData) {
        pendingCopyRef.current = null
        event.preventDefault()
        event.clipboardData.setData('text/plain', pending)
        return
      }
      const root = textRef.current
      if (root) handleSnapshotCopy(event, window.getSelection(), root, linesRef.current)
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

  // Copying a temporary textarea mangled whitespace on iOS (leading spaces,
  // then newlines), so write through the copy event like a selection does.
  // WebKit only runs the copy command over a non-empty selection, so select
  // the layer's text for the duration of the command. The textarea helper is
  // the fallback when no copy event fires.
  const copyAll = async () => {
    if (text === null) return
    const clean = cleanSnapshotText(text)
    pendingCopyRef.current = clean
    let copied = false
    try {
      const selection = window.getSelection()
      if (selection && textRef.current) {
        const range = document.createRange()
        range.selectNodeContents(textRef.current)
        selection.removeAllRanges()
        selection.addRange(range)
      }
      copied = document.execCommand('copy') && pendingCopyRef.current === null
      selection?.removeAllRanges()
    } catch { /* fall back below */ }
    pendingCopyRef.current = null
    if (copied || await copyTextWithResult(clean)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }
  }

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
      <div className="absolute right-2 top-2 flex gap-2">
        {state.status === 'ready' && (
          <button type="button" className={BUTTON_CLASS} onClick={copyAll} aria-label="Copy all text">
            {copied ? <CheckIcon width={ICON_SIZE.default} height={ICON_SIZE.default} /> : <Copy01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />}
            {copied ? 'Copied' : 'Copy all'}
          </button>
        )}
        {state.status !== 'loading' && (
          <button type="button" className={BUTTON_CLASS} onClick={onRefresh} disabled={refreshing}
            aria-label="Refresh text" aria-busy={refreshing}>
            {refreshing
              ? <SpinnerIcon width={ICON_SIZE.default} height={ICON_SIZE.default} className="animate-spin" />
              : <RefreshCcw01Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />}
          </button>
        )}
        <button type="button" className={BUTTON_CLASS} onClick={onClose} aria-label="Done selecting text">
          <XCloseIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
          Done
        </button>
      </div>
    </div>
  )
}
