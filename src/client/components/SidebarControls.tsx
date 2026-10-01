/**
 * SidebarControls - the desktop sidebar's global controls (connection status,
 * new session, settings), rendered at the right end of the filter bar.
 */

import { PlusIcon } from '@untitledui-icons/react/line'
import Settings02Icon from '@untitledui-icons/react/line/esm/Settings02Icon'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import ConnectionIndicator from './ConnectionIndicator'
import { SIDEBAR_ICON_BUTTON_CLASS } from './sidebarControlStyles'

interface SidebarControlsProps {
  connectionStatus: ConnectionStatus
  onNewSession: () => void
  onOpenSettings: () => void
  tailscaleIp: string | null
  /** 'up' opens the connection popover above the bar (bottom anchor). */
  placement?: 'down' | 'up'
}

export default function SidebarControls({
  connectionStatus,
  onNewSession,
  onOpenSettings,
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
      <button
        type="button"
        onClick={onNewSession}
        className="flex h-7 w-7 items-center justify-center rounded bg-accent text-white hover:bg-accent/90 active:scale-95 transition-all"
        title={`New session (${modDisplay}N)`}
        aria-label="New session"
      >
        <PlusIcon width={16} height={16} />
      </button>
      <button
        type="button"
        onClick={onOpenSettings}
        className={SIDEBAR_ICON_BUTTON_CLASS}
        title="Settings"
        aria-label="Settings"
      >
        <Settings02Icon width={14} height={14} />
      </button>
    </div>
  )
}
