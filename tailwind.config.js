/**
 * Theme colors are CSS variables holding hex values (light and dark themes
 * in src/client/styles/index.css; useTerminal reads them as-is for xterm).
 * Tailwind cannot apply an opacity modifier (`bg-danger/10`) to a bare
 * `var(--danger)` string and silently emits no rule, so each color is a
 * function instead:
 *
 * - without an opacity modifier it returns `var(--x)`, byte-for-byte the
 *   value the plain string produced;
 * - with one (`/10`, `/[0.15]`) it mixes the variable with transparent via
 *   `color-mix()`, which works for any CSS color the variable holds.
 *
 * The legacy `*-opacity-*` utilities are disabled below: they would make
 * Tailwind call every color with `var(--tw-bg-opacity)` and wrap even the
 * plain classes in color-mix(). Nothing uses them; opacity modifiers replace
 * them. src/client/__tests__/tailwindThemeColors.test.ts guards all of this.
 */

/** Theme color name -> CSS variable. */
export const themeColorVars = {
  base: '--bg-base',
  elevated: '--bg-elevated',
  surface: '--bg-surface',
  hover: '--bg-hover',
  primary: '--text-primary',
  secondary: '--text-secondary',
  muted: '--text-muted',
  border: '--border',
  'border-subtle': '--border-subtle',
  working: '--working',
  approval: '--approval',
  waiting: '--waiting',
  danger: '--danger',
  'pr-open': '--pr-open',
  'pr-merged': '--pr-merged',
  'pr-closed': '--pr-closed',
  'pr-pending': '--pr-pending',
  accent: '--accent',
}

/** A Tailwind color function for a CSS variable that supports `/alpha`. */
export function themeColor(variable) {
  return ({ opacityValue } = {}) => {
    if (opacityValue === undefined || opacityValue === '1' || opacityValue === 1) {
      return `var(${variable})`
    }
    return `color-mix(in srgb, var(${variable}) calc(${opacityValue} * 100%), transparent)`
  }
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: {
    backgroundOpacity: false,
    borderOpacity: false,
    divideOpacity: false,
    placeholderOpacity: false,
    ringOpacity: false,
    textOpacity: false,
  },
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', '"SF Mono"', '"Fira Code"', 'monospace'],
      },
      colors: Object.fromEntries(
        Object.entries(themeColorVars).map(([name, variable]) => [name, themeColor(variable)])
      ),
    },
  },
  plugins: [],
}
