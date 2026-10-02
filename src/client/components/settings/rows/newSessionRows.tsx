/**
 * New sessions page: where new sessions start and which commands they run.
 */
import { DEFAULT_PROJECT_DIR, useSettingsStore } from '../../../stores/settingsStore'
import { CommitInput } from '../controls/CommitInput'
import { PresetsTable } from '../PresetsTable'
import type { RowControlProps, SettingsRowDef } from '../types'

function DefaultProjectDirControl({ ids }: RowControlProps) {
  const value = useSettingsStore((state) => state.defaultProjectDir)
  return (
    <CommitInput
      id={ids.control}
      value={value}
      placeholder={DEFAULT_PROJECT_DIR}
      describedBy={ids.description}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      maxLength={4096}
      wrapperClassName="w-72 max-md:w-full"
      onCommit={(draft) => {
        // An empty field means "use the default", never an empty path.
        useSettingsStore.getState().setDefaultProjectDir(draft.trim() || DEFAULT_PROJECT_DIR)
        return null
      }}
    />
  )
}

export const newSessionRows: SettingsRowDef[] = [
  {
    id: 'default-project-dir',
    page: 'new-sessions',
    label: 'Default project directory',
    description: `Folder the new session dialog starts in. Default ${DEFAULT_PROJECT_DIR}.`,
    keywords: ['path', 'folder', 'cwd', 'directory'],
    layout: 'wide',
    Control: DefaultProjectDirControl,
  },
  {
    id: 'command-presets',
    page: 'new-sessions',
    label: 'Command presets',
    description:
      'Commands offered when creating a session. The default preset is pre-selected.',
    keywords: ['preset', 'command', 'agent', 'claude', 'codex', 'default', 'icon'],
    layout: 'block',
    Control: PresetsTable,
  },
]
