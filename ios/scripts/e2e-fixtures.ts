/** Setup dependencies follow the selected XCTest methods, including appearance exclusions. */
import { e2eSelection } from './e2e-selection'

export const fixtureNames = ['backend', 'live', 'parity', 'warm', 'shell-server', 'pr-fixture', 'parity-gap-fixture', 'media-activity-fixture', 'photos', 'files'] as const
type Fixture = typeof fixtureNames[number]
const dependencies: Record<string, Fixture[]> = {
  LiveUITests: ['backend', 'live'],
  SimulatorStateUITests: ['backend', 'live', 'media-activity-fixture'],
  SpikeUITests: ['shell-server'],
  NativeGlassUITests: ['parity-gap-fixture'],
  ParityGapUITests: ['parity-gap-fixture'],
  SessionActionUITests: ['backend'],
  NativeClipboardUITests: ['backend', 'live'],
  MediaActivityUITests: ['backend', 'media-activity-fixture'],
  'NativeParityUITests/testDirectoryBrowserPresetAndDuplicate': ['backend', 'parity', 'warm'],
  'NativeParityUITests/testLibraryTranscriptEventsAndPin': ['backend', 'parity', 'warm'],
  'NativeParityUITests/testLoadedMediaDocumentAndLink': ['backend', 'parity', 'warm'],
  'NativeParityUITests/testFilePickerUploadAndInsert': ['backend', 'live', 'parity', 'files'],
  'NativeParityUITests/testPhotoUploadAndInsertIntoShell': ['backend', 'live', 'parity', 'photos'],
  'NativeParityUITests/testSettingsFiltersAndTerminalDestinations': ['backend', 'live', 'parity'],
  'NativeParityUITests/testCatalogSearchAndPreferencePersistence': ['backend', 'live'],
  'NativeParityUITests/testNativeDevicePreferencesPersist': ['backend'],
  'NativeParityUITests/testPullRequestCheckStatesWithGitHubFixture': ['backend', 'parity', 'warm', 'pr-fixture'],
}
export function e2eFixtures(mode: string, shard = 'all'): Fixture[] {
  if (!['all', 'light', 'dark'].includes(mode)) throw new Error(`Unknown appearance: ${mode}`)
  const selected = (mode === 'all' ? ['light', 'dark'] : [mode]).flatMap(appearance => e2eSelection(appearance, shard))
  const needed = new Set<Fixture>()
  for (const selector of selected) {
    if (selector === 'AgentboardSpikeTests') continue
    const test = selector.replace('AgentboardSpikeUITests/', '')
    const required = dependencies[test] ?? dependencies[test.split('/')[0]]
    if (!required) throw new Error(`Missing fixture dependencies: ${selector}`)
    for (const fixture of required) needed.add(fixture)
  }
  return fixtureNames.filter(fixture => needed.has(fixture))
}
if (import.meta.main) console.log(e2eFixtures(process.argv[2] ?? '', process.argv[3]).join('\n'))
