/**
 * Generates a consistent color for a project based on its name.
 * Hashes the name into a curated palette of evenly-spaced, perceptually
 * distinct hues; oklch() in the CSS keeps perceived brightness uniform.
 */

// 14 hand-tuned OKLCH hues covering the full wheel — adjacent slots are
// ~25° apart, so names hashing to neighboring entries still render as
// visibly different pills.
const PROJECT_HUES = [
  25, // red
  50, // orange
  85, // amber
  110, // yellow
  130, // lime
  150, // green
  175, // emerald
  200, // cyan
  225, // sky
  255, // blue
  280, // violet
  305, // purple
  330, // magenta
  355, // rose
] as const

/**
 * String hash with a final avalanche mix, so similar names
 * (e.g. "api" vs "api2") land on unrelated palette slots.
 */
function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x7feb352d)
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x846ca68b)
  hash ^= hash >>> 16
  return hash >>> 0
}

/**
 * Get color styles for a project name.
 * Sets a --badge-hue custom property; actual colors are theme-aware via CSS.
 */
export function getProjectColorStyle(projectName: string): Record<string, string> {
  return {
    '--badge-hue': `${getProjectHue(projectName)}`,
  }
}

/**
 * Get the palette hue for a project name (useful for related styling).
 */
export function getProjectHue(projectName: string): number {
  return PROJECT_HUES[hashString(projectName) % PROJECT_HUES.length]
}
