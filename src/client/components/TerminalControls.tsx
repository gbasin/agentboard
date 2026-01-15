/**
 * TerminalControls - On-screen control strip for mobile terminal interaction
 * Provides quick access to ESC, numbers (for Claude prompts), arrows, Enter, and Ctrl+C
 * Top row shows session switcher buttons to quickly jump between sessions
 */

import { useState, useRef, useEffect } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import type { Session } from '@shared/types'
import { CornerDownLeftIcon } from '@untitledui-icons/react/line'
import DPad from './DPad'
import NumPad from './NumPad'

interface SessionInfo {
  id: string
  name: string
  status: Session['status']
}

interface TerminalControlsProps {
  onSendKey: (key: string) => void
  disabled?: boolean
  sessions: SessionInfo[]
  currentSessionId: string | null
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
]

// Keys after the d-pad
const CONTROL_KEYS_RIGHT: ControlKey[] = [
  { label: BackspaceIcon, key: '\x17', ariaLabel: 'Delete word' }, // Ctrl+W: delete word backward
  { label: <CornerDownLeftIcon width={18} height={18} />, key: '\r', grow: true, className: 'bg-accent/20 text-accent border-accent/40', ariaLabel: 'Enter' },
]

function triggerHaptic() {
  if ('vibrate' in navigator) {
    navigator.vibrate(10)
  }
}

const statusDot: Record<Session['status'], string> = {
  working: 'bg-working',
  waiting: 'bg-waiting',
  permission: 'bg-approval',
  unknown: 'bg-muted',
}

export default function TerminalControls({
  onSendKey,
  disabled = false,
  sessions,
  currentSessionId,
  onSelectSession,
  hideSessionSwitcher = false,
  onRefocus,
  isKeyboardVisible,
  onEnterTextMode,
}: TerminalControlsProps) {
  const [showPasteInput, setShowPasteInput] = useState(false)
  const [pasteValue, setPasteValue] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [ctrlActive, setCtrlActive] = useState(false)
  const pasteInputRef = useRef<HTMLInputElement>(null)
  const pasteZoneRef = useRef<HTMLDivElement>(null)
  const lastTouchTimeRef = useRef(0)
  const controlsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (showPasteInput && pasteInputRef.current) {
      pasteInputRef.current.focus()
    }
  }, [showPasteInput])

  useEffect(() => {
    const controls = controlsRef.current
    if (!controls) return

    const handleTouchStartCapture = (event: TouchEvent) => {
      if (disabled) return
      if (!controls.contains(event.target as Node)) return
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
    if (!ctrlActive || disabled || typeof document === 'undefined') return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only intercept single character keys
      if (e.key.length === 1) {
        e.preventDefault()
        e.stopPropagation()
        const code = e.key.toUpperCase().charCodeAt(0)
        let ctrlChar: string
        // Convert A-Z to Ctrl+A through Ctrl+Z (0x01-0x1A)
        if (code >= 65 && code <= 90) {
          ctrlChar = String.fromCharCode(code - 64)
        } else {
          // For other characters, send with ctrl modifier via escape sequence
          ctrlChar = e.key
        }
        triggerHaptic()
        onSendKey(ctrlChar)
        setCtrlActive(false)
      }
    }

    // Use capture phase to intercept before the terminal gets it
    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }, [ctrlActive, disabled, onSendKey])

  // Handle paste events in the modal (for images via native paste gesture)
  useEffect(() => {
    if (!showPasteInput) return
    const zone = pasteZoneRef.current
    if (!zone) return

    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const blob = item.getAsFile()
          if (!blob) continue

          setIsUploading(true)
          try {
            const formData = new FormData()
            formData.append('image', blob, `paste.${item.type.split('/')[1] || 'png'}`)
            const res = await fetch('/api/paste-image', { method: 'POST', body: formData })
            if (res.ok) {
              const { path } = await res.json()
              onSendKey(path)
              setShowPasteInput(false)
              setPasteValue('')
              onRefocus?.()
            }
          } finally {
            setIsUploading(false)
          }
          return
        }
      }
    }

    zone.addEventListener('paste', handlePaste)
    return () => zone.removeEventListener('paste', handlePaste)
  }, [showPasteInput, onSendKey, onRefocus])

  const handlePress = (key: string) => {
    if (disabled) return
    // Check if keyboard was visible before we do anything
    const wasKeyboardVisible = isKeyboardVisible?.() ?? false
    triggerHaptic()

    // Apply Ctrl modifier if active (convert letter to control character)
    let keyToSend = key
    if (ctrlActive && key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0)
      // Convert A-Z to Ctrl+A through Ctrl+Z (0x01-0x1A)
      if (code >= 65 && code <= 90) {
        keyToSend = String.fromCharCode(code - 64)
      }
      setCtrlActive(false)
    }

    onSendKey(keyToSend)
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

  // Wrapper for child components (NumPad, DPad) to apply Ctrl modifier
  const handleSendKeyWithCtrl = (key: string) => {
    let keyToSend = key
    if (ctrlActive && key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0)
      if (code >= 65 && code <= 90) {
        keyToSend = String.fromCharCode(code - 64)
      }
      setCtrlActive(false)
    }
    onSendKey(keyToSend)
  }

  const handlePasteButtonClick = async () => {
    if (disabled) return
    // Check if keyboard was visible before we do anything
    const wasKeyboardVisible = isKeyboardVisible?.() ?? false
    triggerHaptic()

    // Try Clipboard API with image support
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        // Check for image first
        const imageType = item.types.find((t) => t.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          // Upload image to server
          const formData = new FormData()
          formData.append('image', blob, `paste.${imageType.split('/')[1] || 'png'}`)
          const res = await fetch('/api/paste-image', { method: 'POST', body: formData })
          if (res.ok) {
            const { path } = await res.json()
            // Send file path - Claude Code can reference images by path
            onSendKey(path)
            if (wasKeyboardVisible) {
              onRefocus?.()
            }
            return
          }
        }

        // Check for text
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain')
          const text = await blob.text()
          if (text) {
            onSendKey(text)
            if (wasKeyboardVisible) {
              onRefocus?.()
            }
            return
          }
        }
      }
    } catch {
      // Clipboard API not available - try text fallback
      try {
        const text = await navigator.clipboard.readText()
        if (text) {
          onSendKey(text)
          if (wasKeyboardVisible) {
            onRefocus?.()
          }
          return
        }
      } catch {
        // Fall through to manual paste input
      }
    }

    // Show paste input for manual paste on iOS
    setShowPasteInput(true)
    setPasteValue('')
  }

  const handlePasteSubmit = () => {
    if (pasteValue) {
      triggerHaptic()
      onSendKey(pasteValue)
    }
    setShowPasteInput(false)
    setPasteValue('')
    onRefocus?.()
  }

  const handlePasteCancel = () => {
    setShowPasteInput(false)
    setPasteValue('')
    onRefocus?.()
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
      className="terminal-controls flex flex-col gap-1.5 px-2 py-2.5 bg-elevated border-t border-border md:hidden"
    >
      {/* Session switcher row */}
      {showSessionRow && (
        <div className="relative -mx-2">
          {/* Left fade indicator */}
          <div className="absolute left-0 top-0 bottom-0 w-3 bg-gradient-to-r from-elevated to-transparent z-10 pointer-events-none" />
          {/* Right fade indicator */}
          <div className="absolute right-0 top-0 bottom-0 w-3 bg-gradient-to-l from-elevated to-transparent z-10 pointer-events-none" />
          <div
            className="flex items-center gap-1.5 px-3 overflow-x-auto scrollbar-none scroll-smooth snap-x snap-mandatory"
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
                    h-8 min-w-[3rem] px-2.5 text-xs font-medium rounded-md
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
      <div className="flex items-center gap-1.5">
        {/* Ctrl toggle */}
        <button
          type="button"
          className={`
            terminal-key
            flex items-center justify-center
            h-11 min-w-[2.75rem] px-2.5
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
            className={`
              terminal-key
              flex items-center justify-center
              h-11 min-w-[2.75rem] px-2.5
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

        {/* D-pad for arrow keys */}
        <DPad
          onSendKey={handleSendKeyWithCtrl}
          disabled={disabled}
          onRefocus={onRefocus}
          isKeyboardVisible={isKeyboardVisible}
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
              h-11 min-w-[2.75rem] px-2.5
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
            h-11 min-w-[2.75rem] px-2.5
            text-sm font-medium
            bg-surface border border-border rounded-md
            active:bg-hover active:scale-95
            transition-transform duration-75
            select-none touch-manipulation
            text-secondary
            ${disabled ? 'opacity-50' : ''}
          `}
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={handleTouchAction(() => { void handlePasteButtonClick() })}
          onClick={handleClickAction(() => { void handlePasteButtonClick() })}
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
            h-11 min-w-[2.75rem] px-2.5
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

      {/* Paste modal - shown when Clipboard API unavailable (iOS) */}
      {showPasteInput && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div
            ref={pasteZoneRef}
            className="mx-4 w-full max-w-sm rounded-lg border border-border bg-elevated p-4 shadow-xl"
          >
            <h3 className="text-base font-medium text-primary mb-1 text-balance">Paste</h3>
            <p className="text-xs text-muted mb-3 text-pretty">Text or image (long-press → Paste)</p>
            {isUploading ? (
              <div className="w-full h-11 flex items-center justify-center bg-surface border border-border rounded-md text-secondary">
                Uploading image...
              </div>
            ) : (
              <input
                ref={pasteInputRef}
                type="text"
                value={pasteValue}
                onChange={(e) => setPasteValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handlePasteSubmit()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    handlePasteCancel()
                  }
                }}
                placeholder="Paste here..."
                className="w-full h-11 px-3 text-[16px] bg-surface border border-border rounded-md text-primary placeholder:text-muted outline-none focus:border-accent"
                style={{ fontSize: '16px' }}
              />
            )}
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={handlePasteCancel}
                className="px-4 py-2 text-sm font-medium text-secondary bg-surface border border-border rounded-md active:scale-95 transition-transform"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePasteSubmit}
                disabled={isUploading}
                className="px-4 py-2 text-sm font-medium bg-accent text-white rounded-md active:scale-95 transition-transform disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
