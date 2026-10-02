/**
 * Notifications page: the permission and idle sounds. Enabling either primes
 * audio on the user gesture so browsers allow later playback.
 */
import { useSettingsStore } from '../../../stores/settingsStore'
import { playIdleSound, playPermissionSound, primeAudio } from '../../../utils/sound'
import { Switch } from '../../Switch'
import { CONTROL_BUTTON } from '../styles'
import type { RowControlProps, SettingsRowDef } from '../types'

type SoundKey = 'soundOnPermission' | 'soundOnIdle'
type SoundSetter = 'setSoundOnPermission' | 'setSoundOnIdle'

function soundControl(key: SoundKey, setter: SoundSetter, play: () => Promise<void> | void, noun: string) {
  return function SoundControl({ ids }: RowControlProps) {
    const checked = useSettingsStore((state) => state[key])
    const set = useSettingsStore((state) => state[setter])
    return (
      <>
        <button
          type="button"
          className={CONTROL_BUTTON}
          aria-label={`Test ${noun}`}
          onClick={() => void play()}
        >
          Test
        </button>
        <Switch
          id={ids.control}
          checked={checked}
          onCheckedChange={(next) => {
            set(next)
            if (next) void primeAudio() // Unlock audio on the user gesture
          }}
          ariaLabelledBy={ids.label}
          ariaDescribedBy={ids.description}
        />
      </>
    )
  }
}

export const notificationRows: SettingsRowDef[] = [
  {
    id: 'sound-permission',
    page: 'notifications',
    label: 'Permission sound',
    description: 'Play a ping when any session needs permission.',
    keywords: ['sound', 'audio', 'alert', 'ping', 'approval'],
    Control: soundControl('soundOnPermission', 'setSoundOnPermission', playPermissionSound, 'permission sound'),
  },
  {
    id: 'sound-idle',
    page: 'notifications',
    label: 'Idle sound',
    description: 'Play a chime when a session finishes working.',
    keywords: ['sound', 'audio', 'alert', 'chime', 'done', 'finished'],
    Control: soundControl('soundOnIdle', 'setSoundOnIdle', playIdleSound, 'idle sound'),
  },
]
