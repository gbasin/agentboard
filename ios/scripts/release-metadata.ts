/** Version/build identity shared by manual and tag-triggered TestFlight runs. */
export function releaseMetadata(version: string, ref: string, run: number, attempt: number) {
  version = version.trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('iOS version must be major.minor.patch')
  if (ref.startsWith('ios-v') && ref !== `ios-v${version}`) throw new Error('iOS tag does not match ios/version.txt')
  // Keep the first field within Apple's four-digit limit; retries remain unique.
  if (!Number.isInteger(run) || run < 1 || run > 8999) throw new Error('Workflow run number is outside the build-number range')
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 99) throw new Error('Workflow attempt must be 1–99')
  return { version, build: `${1000 + run}.${attempt}` }
}

if (import.meta.main) {
  const { version, build } = releaseMetadata(await Bun.file('ios/version.txt').text(), process.env.RELEASE_REF ?? '', Number(process.env.GITHUB_RUN_NUMBER), Number(process.env.GITHUB_RUN_ATTEMPT))
  console.log(`version=${version}\nbuild=${build}`)
}
