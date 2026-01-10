/**
 * TerminalControls - On-screen control strip for mobile terminal interaction
 * Provides quick access to ESC, numbers (for Claude prompts), arrows, Enter, and Ctrl+C
 */

interface TerminalControlsProps {
  onSendKey: (key: string) => void
  disabled?: boolean
}

interface ControlKey {
  label: string | JSX.Element
  key: string
  className?: string
  grow?: boolean
}

// Backspace icon (solid, clear)
const BackspaceIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <path d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H7.07L2.4 12l4.66-7H22v14zm-11.59-2L14 13.41 17.59 17 19 15.59 15.41 12 19 8.41 17.59 7 14 10.59 10.41 7 9 8.41 12.59 12 9 15.59z"/>
  </svg>
)

const CONTROL_KEYS: ControlKey[] = [
  { label: 'esc', key: '\x1b' },
  { label: '1', key: '1' },
  { label: '2', key: '2' },
  { label: '3', key: '3' },
  { label: '↑', key: '\x1b[A' },
  { label: '↓', key: '\x1b[B' },
  { label: BackspaceIcon, key: '\x7f' },
  { label: 'return', key: '\r', grow: true, className: 'bg-accent/20 text-accent border-accent/40' },
  { label: '^C', key: '\x03', className: 'text-danger border-danger/40' },
]

function triggerHaptic() {
  if ('vibrate' in navigator) {
    navigator.vibrate(10)
  }
}

// Tmux copy-mode sequences
const TMUX_PREFIX = '\x02' // Ctrl+B
const TMUX_COPY_MODE = '['
const TMUX_PAGE_UP = '\x1b[5~'
const TMUX_PAGE_DOWN = '\x1b[6~'
const TMUX_EXIT_COPY = 'q'

export default function TerminalControls({
  onSendKey,
  disabled = false,
}: TerminalControlsProps) {
  const handlePress = (key: string) => {
    if (disabled) return
    triggerHaptic()
    onSendKey(key)
  }

  // Enter tmux copy-mode, page up, then exit
  const handleScrollUp = () => {
    if (disabled) return
    triggerHaptic()
    // Enter copy mode, page up, exit
    onSendKey(TMUX_PREFIX)
    setTimeout(() => {
      onSendKey(TMUX_COPY_MODE)
      setTimeout(() => {
        onSendKey(TMUX_PAGE_UP)
      }, 50)
    }, 50)
  }

  // Enter tmux copy-mode, page down, then exit
  const handleScrollDown = () => {
    if (disabled) return
    triggerHaptic()
    onSendKey(TMUX_PREFIX)
    setTimeout(() => {
      onSendKey(TMUX_COPY_MODE)
      setTimeout(() => {
        onSendKey(TMUX_PAGE_DOWN)
      }, 50)
    }, 50)
  }

  // Exit copy mode
  const handleExitScroll = () => {
    if (disabled) return
    triggerHaptic()
    onSendKey(TMUX_EXIT_COPY)
  }

  return (
    <div className="terminal-controls flex flex-col gap-1.5 px-2 py-2.5 bg-elevated border-t border-border md:hidden">
      {/* Scroll row - tmux copy-mode */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="terminal-key flex-1 flex items-center justify-center h-9 text-xs font-medium bg-surface border border-border rounded-md active:bg-hover active:scale-95 transition-transform duration-75 select-none touch-manipulation text-secondary"
          onClick={handleScrollUp}
          disabled={disabled}
        >
          ▲ PgUp
        </button>
        <button
          type="button"
          className="terminal-key flex-1 flex items-center justify-center h-9 text-xs font-medium bg-surface border border-border rounded-md active:bg-hover active:scale-95 transition-transform duration-75 select-none touch-manipulation text-secondary"
          onClick={handleScrollDown}
          disabled={disabled}
        >
          ▼ PgDn
        </button>
        <button
          type="button"
          className="terminal-key flex items-center justify-center h-9 px-4 text-xs font-medium rounded-md active:scale-95 transition-transform duration-75 select-none touch-manipulation bg-accent/20 text-accent border border-accent/40"
          onClick={handleExitScroll}
          disabled={disabled}
          title="Exit scroll mode to type"
        >
          Done
        </button>
      </div>
      {/* Key row */}
      <div className="flex items-center gap-1.5">
        {CONTROL_KEYS.map((control, i) => (
          <button
            key={i}
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
            onClick={() => handlePress(control.key)}
            disabled={disabled}
          >
            {control.label}
          </button>
        ))}
      </div>
    </div>
  )
}
