/**
 * Generates a consistent color for a project based on its name.
 * Uses a simple hash to select from a curated palette of colors.
 */

// Generate hue directly from hash - full 360° range
const HUE_COUNT = 360

/**
 * Simple string hash function for consistent color selection.
 */
function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash)
}

/**
 * Get color styles for a project name.
 * Text is muted gray with a subtle color tint, background is the colored pill.
 */
export function getProjectColorStyle(projectName: string): {
  backgroundColor: string
  color: string
} {
  const hue = hashString(projectName) % HUE_COUNT

  return {
    // Colored pill background
    backgroundColor: `hsl(${hue} 60% 50% / 0.2)`,
    // Muted text with subtle color tint (low saturation, similar lightness to --text-muted #737373 ≈ 45%)
    color: `hsl(${hue} 20% 55%)`,
  }
}

/**
 * Get the hue for a project name (useful for related styling).
 */
export function getProjectHue(projectName: string): number {
  return hashString(projectName) % HUE_COUNT
}
