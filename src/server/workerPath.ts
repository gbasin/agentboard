/** Resolve release entrypoints independently of the executable's output name. */
export function resolveWorkerPath(name: string): string {
  // release.yml compiles from the repository root. Bun retains source paths
  // for additional entrypoints and emits .js, while the main entry is renamed
  // to the executable basename. Relative paths from main therefore miss them.
  return import.meta.url.includes('$bunfs')
    ? `/$bunfs/root/src/server/${name}.js`
    : new URL(`./${name}.ts`, import.meta.url).href
}
