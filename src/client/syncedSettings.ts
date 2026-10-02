/**
 * Two-way sync for client settings that describe the shared world (theme,
 * command presets, session list prefs) rather than the local device.
 *
 * The server is canonical: `synced-settings` messages carry the full stored
 * state and are applied wholesale. Local changes to synced keys are pushed
 * back with `PUT /api/settings/synced`. Echoes are suppressed by comparing
 * against the last server-confirmed value per key, so applying a broadcast
 * never triggers a write of the same value.
 *
 * A push is debounced, and the value is captured when it is scheduled, not
 * when it flushes: a full-state broadcast from another browser can land in
 * that window still carrying this key's old value, and applying it must not
 * replace what the user just chose. Such a key keeps its local value and the
 * scheduled push then makes the server agree.
 *
 * Migration: a browser that already has persisted local state ("veteran")
 * seeds server-absent keys from its local values on sync. Fresh browsers
 * have nothing to seed and simply adopt the server values.
 */
import { useSettingsStore } from './stores/settingsStore'
import { useThemeStore } from './stores/themeStore'
import { safeStorage } from './utils/storage'
import { clientLog } from './utils/clientLog'
import {
  SYNCED_SETTINGS_KEYS,
  isSyncedSettingsKey,
  isValidSyncedSetting,
  type SyncedSettings,
  type SyncedSettingsKey,
} from '@shared/syncedSettings'

const THEME_STORAGE_KEY = 'agentboard-theme'
const SETTINGS_STORAGE_KEY = 'agentboard-settings'
const PUSH_DEBOUNCE_MS = 200

/** Last server-confirmed value per key, JSON-encoded for deep comparison. */
const serverValues = new Map<string, string>()
/** Keys awaiting a push, with the JSON-encoded value captured on schedule. */
const pendingPush = new Map<SyncedSettingsKey, string>()
let pushTimer: ReturnType<typeof setTimeout> | null = null
let syncInitialized = false

function getLocalValue(key: SyncedSettingsKey): unknown {
  if (key === 'theme') return useThemeStore.getState().theme
  return (useSettingsStore.getState() as unknown as Record<string, unknown>)[key]
}

function isVeteranForKey(key: SyncedSettingsKey): boolean {
  const storageKey = key === 'theme' ? THEME_STORAGE_KEY : SETTINGS_STORAGE_KEY
  return safeStorage.getItem(storageKey) !== null
}

function flushPush(): void {
  pushTimer = null
  if (pendingPush.size === 0) return
  const delta: Record<string, unknown> = {}
  for (const [key, json] of pendingPush) {
    delta[key] = JSON.parse(json)
    // Optimistically mark as pushed so the broadcast echo is ignored.
    serverValues.set(key, json)
  }
  pendingPush.clear()
  try {
    fetch('/api/settings/synced', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: delta }),
    })
      .then((res) => {
        if (!res.ok) {
          clientLog('synced_settings_push_rejected', { status: res.status }, 'warn')
        }
      })
      .catch((error) => {
        clientLog('synced_settings_push_failed', {
          message: error instanceof Error ? error.message : String(error),
        }, 'warn')
      })
  } catch (error) {
    clientLog('synced_settings_push_failed', {
      message: error instanceof Error ? error.message : String(error),
    }, 'warn')
  }
}

function schedulePush(key: SyncedSettingsKey, value: unknown): void {
  pendingPush.set(key, JSON.stringify(value))
  if (pushTimer) return
  pushTimer = setTimeout(flushPush, PUSH_DEBOUNCE_MS)
}

/**
 * Apply a `synced-settings` message: write present keys into the stores and
 * seed absent keys from local values when this client has persisted state.
 */
export function applySyncedSettings(settings: SyncedSettings): void {
  // Snapshot veteran status BEFORE applying: writing to the persisted stores
  // below would create the localStorage entries this check looks for.
  const veteran = new Map<SyncedSettingsKey, boolean>()
  for (const key of SYNCED_SETTINGS_KEYS) {
    veteran.set(key, isVeteranForKey(key))
  }

  const settingsPatch: Record<string, unknown> = {}
  let theme: 'dark' | 'light' | undefined

  for (const [key, value] of Object.entries(settings)) {
    if (!isSyncedSettingsKey(key) || !isValidSyncedSetting(key, value)) continue
    serverValues.set(key, JSON.stringify(value))
    // A local change is on its way to the server; keep it rather than
    // flashing the stale broadcast value and then pushing the stale value.
    if (pendingPush.has(key)) continue
    if (key === 'theme') {
      theme = value as 'dark' | 'light'
    } else {
      settingsPatch[key] = value
    }
  }

  if (theme !== undefined) {
    useThemeStore.setState({ theme })
  }
  if (Object.keys(settingsPatch).length > 0) {
    useSettingsStore.setState(settingsPatch)
  }

  // Keys absent from the server state were never set there. A veteran client
  // (one with persisted local state) pushes its local value so existing
  // preferences survive the move to server-side persistence. Fresh clients
  // skip this so defaults don't overwrite a veteran's seeded values.
  for (const key of SYNCED_SETTINGS_KEYS) {
    if (key in settings || !veteran.get(key)) continue
    const local = getLocalValue(key)
    if (!isValidSyncedSetting(key, local)) continue
    if (serverValues.get(key) === JSON.stringify(local)) continue
    schedulePush(key, local)
  }
}

/**
 * Subscribe to the stores and push local changes to synced keys back to the
 * server. Returns an unsubscribe function. Idempotent.
 */
export function initSyncedSettings(): () => void {
  if (syncInitialized) return () => {}
  syncInitialized = true

  const unsubSettings = useSettingsStore.subscribe((state, prev) => {
    const current = state as unknown as Record<string, unknown>
    const previous = prev as unknown as Record<string, unknown>
    for (const key of SYNCED_SETTINGS_KEYS) {
      if (key === 'theme') continue
      if (
        current[key] !== previous[key] &&
        serverValues.get(key) !== JSON.stringify(current[key])
      ) {
        schedulePush(key, current[key])
      }
    }
  })

  const unsubTheme = useThemeStore.subscribe((state, prev) => {
    if (
      state.theme !== prev.theme &&
      serverValues.get('theme') !== JSON.stringify(state.theme)
    ) {
      schedulePush('theme', state.theme)
    }
  })

  return () => {
    unsubSettings()
    unsubTheme()
    syncInitialized = false
    if (pushTimer) {
      clearTimeout(pushTimer)
      pushTimer = null
    }
    pendingPush.clear()
    // Stale server values would suppress legit pushes after re-init; the next
    // synced-settings message repopulates them anyway.
    serverValues.clear()
  }
}
