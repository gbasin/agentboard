import { afterEach, beforeEach, expect, test } from 'bun:test'
import { matchingBuild, waitForTestFlight } from './testflight-status'

const settings = ['IOS_APP_ID', 'IOS_BETA_GROUP_ID', 'IOS_VERSION', 'IOS_BUILD_NUMBER'] as const
let previous: (string | undefined)[]
beforeEach(() => {
  previous = settings.map(key => process.env[key])
  settings.forEach((key, index) => { process.env[key] = ['app', 'group', '0.1.0', '1001.1'][index] })
})
afterEach(() => settings.forEach((key, index) => {
  if (previous[index] === undefined) delete process.env[key]
  else process.env[key] = previous[index]
}))

function build(state = 'VALID', assigned = true, version = '0.1.0', audience = 'INTERNAL_ONLY') {
  return {
    data: [{ id: 'build', type: 'builds', attributes: { version: '1001.1', processingState: state, buildAudienceType: audience },
      relationships: { preReleaseVersion: { data: { id: 'version' } }, betaGroups: { data: assigned ? [{ id: 'group' }] : [] } } }],
    included: [{ id: 'version', type: 'preReleaseVersions', attributes: { version } }],
  }
}
function api(responses: ReturnType<typeof build>[], writes: string[] = [], internal = true, automatic = true) {
  return async (path: string, options?: RequestInit) => {
    if (path === '/v1/apps/app') return { data: { attributes: { bundleId: 'dev.agentboard.ios-spike' } } }
    if (path === '/v1/betaGroups/group?include=app') return { data: { attributes: { isInternalGroup: internal, hasAccessToAllBuilds: automatic }, relationships: { app: { data: { id: 'app' } } } } }
    if (options?.method === 'POST') { writes.push(String(options.body)); throw new Error('App Store Connect 404: NOT_FOUND') }
    const response = responses.shift()
    if (!response) throw new Error('Unexpected polling request')
    return response
  }
}
const sleep = async () => {}

test('distinguishes the same build number on another marketing version', () => {
  expect(matchingBuild(build('VALID', true, '0.2.0'), '0.1.0', '1001.1')).toBeUndefined()
})
test('waits through processing and verifies internal group availability', async () => {
  expect(await waitForTestFlight(api([build('PROCESSING'), build()]), sleep, 2)).toBe('build')
})
test('waits for automatic assignment without the failing manual POST', async () => {
  const writes: string[] = []
  expect(await waitForTestFlight(api([build('VALID', false), build('VALID', false), build()], writes), sleep, 3)).toBe('build')
  expect(writes).toEqual([])
})
test('refuses external groups before any build assignment', async () => {
  await expect(waitForTestFlight(api([], [], false), sleep, 1)).rejects.toThrow('Expected an internal group')
})
test('fails immediately for rejected builds and wrong audiences', async () => {
  await expect(waitForTestFlight(api([build('INVALID')]), sleep, 1)).rejects.toThrow('Apple rejected')
  await expect(waitForTestFlight(api([build('VALID', true, '0.1.0', 'APP_STORE_ELIGIBLE')]), sleep, 1)).rejects.toThrow('not internal-only')
})
test('does not report an upload as ready on processing timeout', async () => {
  await expect(waitForTestFlight(api([build('PROCESSING')]), sleep, 1)).rejects.toThrow('upload may have succeeded')
})

test('fails clearly when automatic distribution is disabled', async () => {
  await expect(waitForTestFlight(api([], [], true, false), sleep, 1)).rejects.toThrow('Enable automatic distribution')
})
test('does not report a valid but unassigned build as available', async () => {
  const writes: string[] = []
  await expect(waitForTestFlight(api([build('VALID', false), build('VALID', false)], writes), sleep, 2)).rejects.toThrow('Timed out waiting for TestFlight')
  expect(writes).toEqual([])
})
