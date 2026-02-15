import { useState } from 'react'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { PlusIcon } from '@untitledui-icons/react/line'
import Copy01Icon from '@untitledui-icons/react/line/esm/Copy01Icon'
import Settings02Icon from '@untitledui-icons/react/line/esm/Settings02Icon'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'

interface HeaderProps {
  connectionStatus: ConnectionStatus
  onNewSession: () => void
  onOpenSettings: () => void
  tailscaleIp: string | null
}

const statusDot: Record<ConnectionStatus, string> = {
  connected: 'bg-working',
  connecting: 'bg-approval',
  reconnecting: 'bg-approval',
  disconnected: 'bg-danger',
}

export default function Header({
  connectionStatus,
  onNewSession,
  onOpenSettings,
  tailscaleIp,
}: HeaderProps) {
  const [copied, setCopied] = useState(false)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const modDisplay = getModifierDisplay(getEffectiveModifier(shortcutModifier))

  const handleCopyTailscaleUrl = () => {
    if (!tailscaleIp) return
    const url = `http://${tailscaleIp}:${window.location.port || '4040'}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-elevated px-3">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold tracking-tight text-primary text-balance">
          AGENTBOARD
        </h1>
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <span className={`h-2 w-2 rounded-full ${statusDot[connectionStatus]}`} />
          {tailscaleIp && (
            <button
              onClick={handleCopyTailscaleUrl}
              className="ml-3 inline-flex items-center gap-1 text-muted/70 hover:text-muted transition-colors cursor-pointer"
              title="Tailscale IP - click to copy remote access URL"
            >
              <span className="leading-none translate-y-[1px]">{copied ? 'Copied!' : tailscaleIp}</span>
              {!copied && <Copy01Icon width={12} height={12} className="shrink-0" />}
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          onClick={onNewSession}
          className="flex h-7 w-7 items-center justify-center rounded bg-accent text-white hover:bg-accent/90 active:scale-95 transition-all"
          title={`New session (${modDisplay}N)`}
          aria-label="New session"
        >
          <PlusIcon width={16} height={16} />
        </button>
        <button
          onClick={onOpenSettings}
          className="flex h-7 w-7 items-center justify-center rounded border border-border text-secondary hover:bg-hover hover:text-primary active:scale-95 transition-all"
          title="Settings"
          aria-label="Settings"
        >
          <Settings02Icon width={14} height={14} />
        </button>
      </div>
    </header>
  )
}
