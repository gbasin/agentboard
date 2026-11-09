/** Wait for Apple processing and confirm assignment to the existing internal group. */
import { appStoreRequest } from './app-store-connect'

interface Resource {
  id: string
  type: string
  attributes: { version?: string; processingState?: string; expired?: boolean; buildAudienceType?: string; isInternalGroup?: boolean; bundleId?: string }
  relationships?: { preReleaseVersion?: { data: { id: string } }; betaGroups?: { data: { id: string }[] }; app?: { data: { id: string } } }
}
interface Builds { data: Resource[]; included?: Resource[] }

export function matchingBuild(response: Builds, version: string, build: string) {
  return response.data.find(item => item.attributes.version === build && response.included?.some(related =>
    related.type === 'preReleaseVersions' && related.id === item.relationships?.preReleaseVersion?.data.id && related.attributes.version === version))
}

export async function waitForTestFlight(request = appStoreRequest, sleep = Bun.sleep, attempts = 60) {
  const { IOS_APP_ID: app, IOS_BETA_GROUP_ID: group, IOS_VERSION: version, IOS_BUILD_NUMBER: build } = process.env
  if (!app || !group || !version || !build) throw new Error('Missing TestFlight app/group/version/build settings')
  const appResponse = await request(`/v1/apps/${encodeURIComponent(app)}`)
  if (appResponse.data.attributes.bundleId !== 'dev.agentboard.ios-spike') throw new Error('Wrong App Store Connect app')
  const groupResponse = await request(`/v1/betaGroups/${encodeURIComponent(group)}?include=app`)
  if (!groupResponse.data.attributes.isInternalGroup || groupResponse.data.relationships.app.data.id !== app) throw new Error('Expected an internal group for this app')
  const query = new URLSearchParams({ 'filter[app]': app, 'filter[version]': build, include: 'preReleaseVersion,betaGroups', limit: '200' })
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response: Builds = await request(`/v1/builds?${query}`)
    const candidate = matchingBuild(response, version, build)
    if (candidate) {
      const { processingState, expired, buildAudienceType } = candidate.attributes
      if (expired || processingState === 'FAILED' || processingState === 'INVALID') throw new Error(`Apple rejected or expired build ${build}: ${processingState}`)
      if (processingState === 'VALID') {
        if (buildAudienceType !== 'INTERNAL_ONLY') throw new Error('Uploaded build is not internal-only')
        if (candidate.relationships?.betaGroups?.data.some(item => item.id === group)) {
          console.log(`TestFlight ${version} (${build}) processed and assigned to the internal group.`)
          return candidate.id
        }
        // Existing automatic distribution normally handles this. Explicitly attach
        // only to the validated internal group if it has not appeared yet.
        await request(`/v1/betaGroups/${encodeURIComponent(group)}/relationships/builds`, {
          method: 'POST', body: JSON.stringify({ data: [{ type: 'builds', id: candidate.id }] }),
        })
      }
      console.log(`Apple processing: ${processingState}; waiting for internal group availability.`)
    } else console.log('Waiting for the uploaded build to appear in App Store Connect.')
    if (attempt + 1 < attempts) await sleep(30_000)
  }
  throw new Error(`Timed out waiting for TestFlight ${version} (${build}); upload may have succeeded. Check App Store Connect before publishing again.`)
}

if (import.meta.main) await waitForTestFlight()
