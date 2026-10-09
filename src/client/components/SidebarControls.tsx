/**
 * SidebarControls - the desktop sidebar's global controls (connection status,
 * session recovery, new session, settings), rendered at the right end of the filter bar.
 */

import { ClockRewindIcon, PlusIcon, Settings02Icon } from './icons'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import ConnectionIndicator from './ConnectionIndicator'
import { ICON_BUTTON_CLASS, ICON_SIZE, iconButtonClass } from './controlStyles'

interface SidebarControlsProps {
  connectionStatus: ConnectionStatus
  onNewSession: () => void
  onOpenSettings: () => void
  onOpenHistory?: () => void
  tailscaleIp: string | null
  /** 'up' opens the connection popover above the bar (bottom anchor). */
  placement?: 'down' | 'up'
}

export default function SidebarControls({
  connectionStatus,
  onNewSession,
  onOpenSettings,
  onOpenHistory,
  tailscaleIp,
  placement = 'down',
}: SidebarControlsProps) {
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const modDisplay = getModifierDisplay(getEffectiveModifier(shortcutModifier))

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <ConnectionIndicator
        connectionStatus={connectionStatus}
        tailscaleIp={tailscaleIp}
        placement={placement}
      />
      {onOpenHistory && (
        <button
          type="button"
          onClick={onOpenHistory}
          className={ICON_BUTTON_CLASS}
          title="Session recovery"
          aria-label="Session recovery"
        >
          <ClockRewindIcon width={ICON_SIZE.default} height={ICON_SIZE.default} />
        </button>
      )}
      <button
        type="button"
        onClick={onNewSession}
        className={iconButtonClass('primary')}
        title={`New session (${modDisplay}N)`}
        aria-label="New session"
      >
        <PlusIcon width={ICON_SIZE.primary} height={ICON_SIZE.primary} />
      </button>
      <button
        type="button"
        onClick={onOpenSettings}
        className={ICON_BUTTON_CLASS}
        title={`Settings (${modDisplay},)`}
        aria-label="Settings"
      >
        <Settings02Icon width={ICON_SIZE.default} height={ICON_SIZE.default} />
      </button>
    </div>
  )
}
