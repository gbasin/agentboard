/**
 * TerminalControls - On-screen control strip for mobile terminal interaction
 * Provides quick access to ESC, numbers (for Claude prompts), arrows, Enter, and Ctrl+C
 * Top row shows session switcher buttons to quickly jump between sessions
 */

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import type { AgentType, Session } from '@shared/types'
import { CornerDownLeftIcon } from '@untitledui-icons/react/line'
import ArrowKeys from './ArrowKeys'
import NumPad from './NumPad'
import { isIOSDevice } from '../utils/device'
import PasteDialog, { type PasteDraft } from './PasteDialog'
import { readBrowserClipboard } from '../utils/browserFiles'

interface SessionInfo {
  id: string
  name: string
  status: Session['status']
}

interface TerminalControlsProps {
  onSendKey: (key: string) => void
  /**
   * Deliver pasted text as an explicit paste (bracketed via tmux) instead of raw
   * keystrokes, so multi-line content isn't auto-submitted line-by-line. Falls
   * back to onSendKey when not provided.
   */
  onPasteText?: (text: string) => void
  onPasteImage?: (text: string) => void
  disabled?: boolean
  sessions: SessionInfo[]
  currentSessionId: string | null
  /** Agent type of the attached session — controls image-paste delivery. */
  agentType?: AgentType
  fileUploadsAllowed?: boolean
  onSelectSession: (sessionId: string) => void
  hideSessionSwitcher?: boolean
  onRefocus?: () => void
  isKeyboardVisible?: () => boolean
  onEnterTextMode?: () => void
}

interface ControlKey {
  label: string | JSX.Element
  key: string
  className?: string
  grow?: boolean
  ariaLabel?: string
}

// Backspace icon (solid, clear)
const BackspaceIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <path d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H7.07L2.4 12l4.66-7H22v14zm-11.59-2L14 13.41 17.59 17 19 15.59 15.41 12 19 8.41 17.59 7 14 10.59 10.41 7 9 8.41 12.59 12 9 15.59z"/>
  </svg>
)

// Paste/clipboard icon
const PasteIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
  </svg>
)

// Keyboard icon
const KeyboardIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
    <line x1="6" y1="8" x2="6" y2="8" />
    <line x1="10" y1="8" x2="10" y2="8" />
    <line x1="14" y1="8" x2="14" y2="8" />
    <line x1="18" y1="8" x2="18" y2="8" />
    <line x1="6" y1="12" x2="6" y2="12" />
    <line x1="10" y1="12" x2="10" y2="12" />
    <line x1="14" y1="12" x2="14" y2="12" />
    <line x1="18" y1="12" x2="18" y2="12" />
    <line x1="7" y1="16" x2="17" y2="16" />
  </svg>
)

// Keys before the numpad (Ctrl toggle handled separately)
const CONTROL_KEYS_LEFT: ControlKey[] = [
  { label: 'esc', key: '\x1b' },
  { label: 'tab', key: '\t' },
  // Shift+Tab (CSI Z): toggles Claude Code's plan / auto-accept mode
  { label: '⇧tab', key: '\x1b[Z', ariaLabel: 'Shift+Tab' },
]

// Keys after the arrow-key trigger
const CONTROL_KEYS_RIGHT: ControlKey[] = [
  { label: BackspaceIcon, key: '\x17', ariaLabel: 'Delete word' }, // Ctrl+W: delete word backward
  { label: <CornerDownLeftIcon width={18} height={18} />, key: '\r', grow: true, className: 'bg-accent/20 text-accent border-accent/40', ariaLabel: 'Enter' },
]

function triggerHaptic() {
  if ('vibrate' in navigator) {
    navigator.vibrate(10)
  }
}

/**
 * Applies Ctrl modifier to a single character input.
 * Converts A-Z to Ctrl+A through Ctrl+Z (0x01-0x1A).
 * Other characters pass through unchanged.
 */
function applyCtrlModifier(
  input: string,
  ctrlActive: boolean
): { output: string; consumeCtrl: boolean } {
  if (!ctrlActive || input.length !== 1) {
    return { output: input, consumeCtrl: false }
  }
  const code = input.toUpperCase().charCodeAt(0)
  if (code >= 65 && code <= 90) {
    return { output: String.fromCharCode(code - 64), consumeCtrl: true }
  }
  // Non-letter characters pass through unchanged but consume ctrl
  return { output: input, consumeCtrl: true }
}

const statusDot: Record<Session['status'], string> = {
  working: 'bg-working',
  waiting: 'bg-waiting',
  permission: 'bg-approval',
  unknown: 'bg-muted',
}

export default function TerminalControls({
  onSendKey,
  onPasteText,
  onPasteImage,
  disabled = false,
  sessions,
  currentSessionId,
  agentType,
  fileUploadsAllowed = true,
  onSelectSession,
  hideSessionSwitcher = false,
  onRefocus,
  isKeyboardVisible,
  onEnterTextMode,
}: TerminalControlsProps) {
  const [pasteClipboard, setPasteClipboard] = useState<Promise<PasteDraft> | null>(null)
  const [ctrlActive, setCtrlActive] = useState(false)
  const lastTouchTimeRef = useRef(0)
  const controlsRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => { setPasteClipboard(null) }, [currentSessionId])

  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return

    const handleTouchStartCapture = (event: TouchEvent) => {
      if (disabled) return
      if (!controls.contains(event.target as Node)) return
      if ((event.target as HTMLElement).closest?.('[data-native-gesture]')) return
      if (isKeyboardVisible?.()) {
        event.preventDefault()
      }
    }

    controls.addEventListener('touchstart', handleTouchStartCapture, {
      passive: false,
      capture: true,
    })

    return () => {
      controls.removeEventListener('touchstart', handleTouchStartCapture, {
        capture: true,
      })
    }
  }, [disabled, isKeyboardVisible])

  // Intercept keyboard input when ctrl is active to send control characters
  useEffect(() => {
    if (!ctrlActive || disabled || pasteClipboard || typeof document === 'undefined') return

    const handleKeyDown = (e: KeyboardEvent) => {
      const { output, consumeCtrl } = applyCtrlModifier(e.key, true)
      if (consumeCtrl) {
        e.preventDefault()
        e.stopPropagation()
        triggerHaptic()
        onSendKey(output)
        setCtrlActive(false)
      }
    }

    // Use capture phase to intercept before the terminal gets it
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [ctrlActive, disabled, pasteClipboard, onSendKey])

  const handlePress = (key: string) => {
    if (disabled) return
    // Check if keyboard was visible before we do anything
    const wasKeyboardVisible = isKeyboardVisible?.() ?? false
    triggerHaptic()

    const { output, consumeCtrl } = applyCtrlModifier(key, ctrlActive)
    if (consumeCtrl) {
      setCtrlActive(false)
    }

    onSendKey(output)
    // Only refocus if keyboard was already visible (don't bring it up if it wasn't)
    if (wasKeyboardVisible) {
      onRefocus?.()
    }
  }

  const handleCtrlToggle = () => {
    if (disabled) return
    triggerHaptic()
    setCtrlActive(!ctrlActive)
  }

  // Wrapper for child components (NumPad, ArrowKeys) to apply Ctrl modifier
  const handleSendKeyWithCtrl = (key: string) => {
    const { output, consumeCtrl } = applyCtrlModifier(key, ctrlActive)
    if (consumeCtrl) {
      setCtrlActive(false)
    }
    onSendKey(output)
  }

  // Route pasted text through the explicit paste path (bracketed via tmux) so
  // multi-line content isn't auto-submitted line-by-line; fall back to raw keys.
  const sendPasteText = (text: string) => {
    if (onPasteText) {
      onPasteText(text)
    } else {
      onSendKey(text)
    }
  }

  const handlePasteButtonClick = () => {
    if (disabled) return
    triggerHaptic()
    // Start the browser read synchronously within the click gesture (Safari).
    // A denied read still opens a draft with native paste and a file picker.
    setPasteClipboard(readBrowserClipboard().catch(() => ({ text: '', files: [] })))
  }

  const handleSessionSelect = (sessionId: string) => {
    triggerHaptic()
    onSelectSession(sessionId)
  }

  const handleKeyboardPress = () => {
    if (disabled) return
    triggerHaptic()
    // Toggle: if keyboard visible, hide it; otherwise show it
    if (isKeyboardVisible?.()) {
      // Blur to hide keyboard
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    } else {
      onEnterTextMode?.()
    }
  }

  // Only show session row if there are multiple sessions and not hidden
  const showSessionRow = sessions.length > 1 && !hideSessionSwitcher

  const handleTouchAction = (handler: () => void) => (e: ReactTouchEvent) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    lastTouchTimeRef.current = Date.now()
    handler()
  }

  const handleClickAction = (handler: () => void) => () => {
    if (disabled) return
    if (Date.now() - lastTouchTimeRef.current < 700) {
      return
    }
    handler()
  }

  return (
    <div
      ref={controlsRef}
      className={`terminal-controls flex flex-col gap-[6px] border-t border-border bg-elevated p-[6px] ${isIOSDevice() ? '' : 'md:hidden'}`}
    >
      {/* Session switcher row */}
      {showSessionRow && (
        <div className="relative -mx-[6px]">
          {/* Left fade indicator */}
          <div className="absolute left-0 top-0 bottom-0 w-3 bg-gradient-to-r from-elevated to-transparent z-10 pointer-events-none" />
          {/* Right fade indicator */}
          <div className="absolute right-0 top-0 bottom-0 w-3 bg-gradient-to-l from-elevated to-transparent z-10 pointer-events-none" />
          <div
            className="flex items-center gap-[6px] overflow-x-auto px-[6px] scrollbar-none scroll-smooth snap-x snap-mandatory"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            {sessions.map((session, index) => {
              const isActive = session.id === currentSessionId
              return (
                <button
                  key={session.id}
                  type="button"
                  className={`
                    terminal-key flex items-center justify-center gap-1.5 shrink-0 snap-start
                    h-[44px] min-w-[44px] px-2.5 text-xs font-medium rounded-md
                    active:scale-95 transition-transform duration-75
                    select-none touch-manipulation
                    ${isActive
                      ? 'bg-accent/20 text-accent border border-accent/40'
                      : 'bg-surface border border-border text-secondary'}
                  `}
                  onClick={() => handleSessionSelect(session.id)}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot[session.status]}`} />
                  <span className="truncate">{index + 1}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
      {/* Key row */}
      <div className="grid grid-flow-col auto-cols-[44px] items-center gap-[4px] overflow-x-auto scrollbar-none">
        {/* Ctrl toggle */}
        <button
          type="button"
          className={`
            terminal-key
            flex items-center justify-center
            size-[44px] p-0
            text-sm font-medium
            rounded-md
            active:scale-95
            transition-transform duration-75
            select-none touch-manipulation
            ${ctrlActive
              ? 'bg-accent/20 text-accent border border-accent/40'
              : 'bg-surface border border-border text-secondary'}
            ${disabled ? 'opacity-50' : ''}
          `}
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={handleTouchAction(handleCtrlToggle)}
          onClick={handleClickAction(handleCtrlToggle)}
          disabled={disabled}
        >
          ctrl
        </button>
        {/* Left controls */}
        {CONTROL_KEYS_LEFT.map((control, i) => (
          <button
            key={`left-${i}`}
            type="button"
            aria-label={control.ariaLabel}
            className={`
              terminal-key
              flex items-center justify-center
              size-[44px] p-0
              text-sm font-medium
              bg-surface border border-border rounded-md
              active:bg-hover active:scale-95
              transition-transform duration-75
              select-none touch-manipulation
              ${control.grow ? 'flex-1' : ''}
              ${control.className ?? 'text-secondary'}
              ${disabled ? 'opacity-50' : ''}
            `}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={handleTouchAction(() => handlePress(control.key))}
            onClick={handleClickAction(() => handlePress(control.key))}
            disabled={disabled}
          >
            {control.label}
          </button>
        ))}

        {/* NumPad for number input */}
        <NumPad
          onSendKey={handleSendKeyWithCtrl}
          disabled={disabled}
          onRefocus={onRefocus}
          isKeyboardVisible={isKeyboardVisible}
        />

        {/* Arrow keys: tap to open a cluster above the deck */}
        <ArrowKeys
          onSendKey={handleSendKeyWithCtrl}
          disabled={disabled}
          onRefocus={onRefocus}
          isKeyboardVisible={isKeyboardVisible}
          sessionKey={currentSessionId}
        />

        {/* Right controls */}
        {CONTROL_KEYS_RIGHT.map((control, i) => (
          <button
            key={`right-${i}`}
            type="button"
            aria-label={control.ariaLabel}
            className={`
              terminal-key
              flex items-center justify-center
              size-[44px] p-0
              text-sm font-medium
              bg-surface border border-border rounded-md
              active:bg-hover active:scale-95
              transition-transform duration-75
              select-none touch-manipulation
              ${control.grow ? 'flex-1' : ''}
              ${control.className ?? 'text-secondary'}
              ${disabled ? 'opacity-50' : ''}
            `}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={handleTouchAction(() => handlePress(control.key))}
            onClick={handleClickAction(() => handlePress(control.key))}
            disabled={disabled}
          >
            {control.label}
          </button>
        ))}
        {/* Paste button */}
        <button
          type="button"
          aria-label="Paste"
          className={`
            terminal-key
            flex items-center justify-center
            size-[44px] p-0
            text-sm font-medium
            bg-surface border border-border rounded-md
            active:bg-hover active:scale-95
            transition-transform duration-75
            select-none touch-manipulation
            text-secondary
            ${disabled ? 'opacity-50' : ''}
          `}
          onMouseDown={(e) => e.preventDefault()}
          data-native-gesture
          onClick={handlePasteButtonClick}
          disabled={disabled}
        >
          {PasteIcon}
        </button>
        {/* Keyboard button - enter text mode (exit copy-mode and show keyboard) */}
        <button
          type="button"
          aria-label="Show keyboard"
          className={`
            terminal-key
            flex items-center justify-center
            size-[44px] p-0
            text-sm font-medium
            bg-surface border border-border rounded-md
            active:bg-hover active:scale-95
            transition-transform duration-75
            select-none touch-manipulation
            text-secondary
            ${disabled ? 'opacity-50' : ''}
          `}
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={handleTouchAction(handleKeyboardPress)}
          onClick={handleClickAction(handleKeyboardPress)}
          disabled={disabled}
        >
          {KeyboardIcon}
        </button>
      </div>

      {pasteClipboard && (
        <PasteDialog
          key={currentSessionId}
          clipboard={pasteClipboard}
          agentType={agentType}
          fileUploadsAllowed={fileUploadsAllowed}
          disabled={disabled}
          onPasteText={sendPasteText}
          onSendKey={onPasteImage ?? onSendKey}
          onClose={() => { setPasteClipboard(null); onRefocus?.() }}
        />
      )}
    </div>
  )
}
