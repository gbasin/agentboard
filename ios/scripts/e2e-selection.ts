/** Balanced by hosted workflow timings; each appearance keeps its existing coverage. */
export const shards = ['terminal', 'catalog', 'lifecycle', 'media', 'settings'] as const
const groups: Record<typeof shards[number], string[]> = {
  terminal: ['LiveUITests', 'SimulatorStateUITests', 'SpikeUITests', 'CompactTerminalUITests'],
  catalog: ['NativeGlassUITests', 'ParityGapUITests'],
  lifecycle: [
    'SessionActionUITests',
    'NativeParityUITests/testDirectoryBrowserPresetAndDuplicate',
    'NativeParityUITests/testLibraryTranscriptEventsAndPin',
  ],
  media: [
    'MediaActivityUITests', 'NativeClipboardUITests',
    'NativeParityUITests/testLoadedMediaDocumentAndLink',
    'NativeParityUITests/testFilePickerUploadAndInsert',
    'NativeParityUITests/testPhotoUploadAndInsertIntoShell',
  ],
  settings: [
    'NativeParityUITests/testSettingsFiltersAndTerminalDestinations',
    'NativeParityUITests/testCatalogSearchAndPreferencePersistence',
    'NativeParityUITests/testNativeDevicePreferencesPersist',
    'NativeParityUITests/testPullRequestCheckStatesWithGitHubFixture',
  ],
}
export function e2eSelection(appearance: string, shard = 'all'): string[] {
  if (!['light', 'dark'].includes(appearance)) throw new Error(`Unknown appearance: ${appearance}`)
  if (shard !== 'all' && !shards.includes(shard as typeof shards[number])) throw new Error(`Unknown shard: ${shard}`)
  const selected = shard === 'all' ? shards.flatMap(key => groups[key]) : groups[shard as typeof shards[number]]
  const ui = selected.flatMap(item => {
    if (appearance === 'dark' && item === 'SpikeUITests') return []
    if (appearance === 'dark' && item === 'LiveUITests') return [
      'LiveUITests/testFrozenSnapshotRefreshCopyAndReturnToInput',
      'LiveUITests/testSessionOverviewSwitchesWithStatus',
    ]
    return [item]
  }).map(item => `AgentboardSpikeUITests/${item}`)
  return appearance === 'light' && ['all', 'terminal'].includes(shard) ? ['AgentboardSpikeTests', ...ui] : ui
}
if (import.meta.main) console.log(e2eSelection(process.argv[2] ?? '', process.argv[3]).join('\n'))
