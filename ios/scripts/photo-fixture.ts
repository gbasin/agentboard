/** The 32x32 PNG that the photo-picker tests insert. Run directly to write it to a path. */
import { writeFile } from 'node:fs/promises'
export const photoFixturePNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPgSvlAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAOVLeEwhyp0SAAAAAElFTkSuQmCC', 'base64')
if (import.meta.main) {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: bun ios/scripts/photo-fixture.ts PATH')
  await writeFile(path, photoFixturePNG)
}
