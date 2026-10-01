// Enforces the client's icon conventions with a plain source scan, so the
// sizes and sources unified in controlStyles.ts / icons.tsx cannot drift:
//
// - `<svg` only in components/icons.tsx (custom glyphs) and AgentIcon.tsx
//   (agent/brand logos);
// - the icon library is imported only by components/icons.tsx;
// - every `<...Icon>` element (except AgentIcon) is sized through
//   width/height props taken from ICON_SIZE (or PR_STATE_MARK_SIZE), never
//   by numeric literals or Tailwind h-/w-/size- classes;
// - ICON_SIZE holds only the allowed scale.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ICON_SIZE, PR_STATE_MARK_SIZE } from '../components/controlStyles'

const CLIENT_DIR = join(import.meta.dir, '..')
const SVG_ALLOWED = new Set(['components/icons.tsx', 'components/AgentIcon.tsx'])
const LIBRARY_ALLOWED = new Set(['components/icons.tsx'])
const ALLOWED_SIZES = [12, 14, 16, 18]
const SIZE_EXPRESSION = /^\{(ICON_SIZE\.(pill|default|primary|key)|PR_STATE_MARK_SIZE)\}$/
const ICON_ELEMENT = /<([A-Z][A-Za-z0-9]*Icon)\b((?:[^>]|=>)*?)\/?>/g
const SIZE_CLASS = /(^|[\s"'`{])(h|w|size|min-h|min-w)-[\w.[\]]+/

/** Violations of the icon conventions in one source file. */
function scanSource(path: string, source: string): string[] {
  const problems: string[] = []
  if (!SVG_ALLOWED.has(path) && source.includes('<svg')) {
    problems.push(`${path}: inline <svg> (add it to components/icons.tsx)`)
  }
  if (!LIBRARY_ALLOWED.has(path) && source.includes('@untitledui-icons')) {
    problems.push(`${path}: imports the icon library directly (use ./icons)`)
  }
  if (SVG_ALLOWED.has(path)) return problems
  for (const match of source.matchAll(ICON_ELEMENT)) {
    const [, name, attributes] = match
    if (name === 'AgentIcon') continue
    for (const prop of ['width', 'height']) {
      const value = attributes.match(prop === 'width' ? /\bwidth=(\{[^}]*\}|"[^"]*")/ : /\bheight=(\{[^}]*\}|"[^"]*")/)
      if (!value) {
        problems.push(`${path}: <${name}> has no ${prop} prop`)
      } else if (!SIZE_EXPRESSION.test(value[1])) {
        problems.push(`${path}: <${name}> ${prop}=${value[1]} (use ICON_SIZE)`)
      }
    }
    const className = attributes.match(/\bclassName=(\{[^}]*\}|"[^"]*")/)
    if (className && SIZE_CLASS.test(className[1])) {
      problems.push(`${path}: <${name}> sized by class ${className[1]} (use width/height)`)
    }
  }
  return problems
}

function clientSources(): string[] {
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  return Array.from(glob.scanSync({ cwd: CLIENT_DIR }))
    .filter((path) => !path.startsWith('__tests__/'))
    .sort()
}

describe('icon conventions', () => {
  test('ICON_SIZE is the allowed scale and nothing else', () => {
    const sizes: number[] = Object.values(ICON_SIZE)
    expect(sizes.sort((a, b) => a - b)).toEqual(ALLOWED_SIZES)
    // The PR mark is a corner overlay inside a 12px glyph, not an icon size.
    expect(PR_STATE_MARK_SIZE).toBeLessThan(ICON_SIZE.pill)
  })

  test('the client source follows the icon conventions', () => {
    const files = clientSources()
    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain('components/icons.tsx')
    const problems = files.flatMap((path) =>
      scanSource(path, readFileSync(join(CLIENT_DIR, path), 'utf8'))
    )
    expect(problems).toEqual([])
  })

  test('the scan catches each kind of violation', () => {
    const file = 'components/Example.tsx'
    expect(scanSource(file, 'const a = <svg viewBox="0 0 24 24" />')).toHaveLength(1)
    expect(
      scanSource(file, "import X from '@untitledui-icons/react/line/esm/XCloseIcon'")
    ).toHaveLength(1)
    expect(scanSource(file, '<XCloseIcon width={20} height={20} />')).toEqual([
      `${file}: <XCloseIcon> width={20} (use ICON_SIZE)`,
      `${file}: <XCloseIcon> height={20} (use ICON_SIZE)`,
    ])
    expect(scanSource(file, '<PlusIcon className="h-3.5 w-3.5" />')).toEqual([
      `${file}: <PlusIcon> has no width prop`,
      `${file}: <PlusIcon> has no height prop`,
      `${file}: <PlusIcon> sized by class "h-3.5 w-3.5" (use width/height)`,
    ])
    expect(
      scanSource(
        file,
        '<Moon01Icon\n  width={ICON_SIZE.pill}\n  height={ICON_SIZE.pill}\n  className="shrink-0 text-muted"\n/>'
      )
    ).toEqual([])
    // Custom glyphs and brand logos may draw SVG; AgentIcon is out of scope.
    expect(scanSource('components/icons.tsx', '<svg />')).toEqual([])
    expect(scanSource(file, '<AgentIcon className="h-3.5 w-3.5" />')).toEqual([])
  })
})
