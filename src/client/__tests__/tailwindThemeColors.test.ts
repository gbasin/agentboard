// Guards tailwind.config.js's theme colors, which are CSS variables:
//
// - every theme color accepts an opacity modifier (`bg-danger/10`). With a
//   bare `var(--danger)` string Tailwind silently emits no rule at all, which
//   is how kill buttons lost their red tint and the mobile Enter key its
//   accent background;
// - a plain class (`bg-danger`) still compiles to exactly `var(--danger)`,
//   so the base colors are unchanged in every theme;
// - every color variable is defined in both the dark and the light theme;
// - every opacity-modified color class written in src/client compiles to a
//   rule (this also catches names that are not theme colors, such as the
//   `border-error/50` that once rendered nothing).
//
// Tailwind runs in-process on tiny raw-content fixtures. No regex is built
// from a variable: class names are compared as plain strings.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'

const ROOT = join(import.meta.dir, '..', '..', '..')
const CLIENT_DIR = join(ROOT, 'src', 'client')
const CONFIG_PATH = join(ROOT, 'tailwind.config.js')

interface ConfigModule {
  default: Record<string, unknown>
  themeColorVars: Record<string, string>
}

async function loadConfig(): Promise<ConfigModule> {
  return (await import(CONFIG_PATH)) as ConfigModule
}

/** Compile `classes` with the app's config; returns selector -> declarations. */
async function compile(classes: string[]): Promise<Map<string, Map<string, string>>> {
  const { default: config } = await loadConfig()
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: classes.join(' '), extension: 'html' }] }),
  ]).process('@tailwind utilities;', { from: undefined })
  const rules = new Map<string, Map<string, string>>()
  result.root.walkRules((rule) => {
    const decls = new Map<string, string>()
    rule.walkDecls((decl) => {
      decls.set(decl.prop, decl.value)
    })
    rules.set(rule.selector, decls)
  })
  return rules
}

/** Tailwind's selector for a class: `.` plus the name with `/ : . [ ]` escaped. */
function selectorFor(className: string): string {
  let escaped = ''
  for (const char of className) {
    escaped += '/:.[]'.includes(char) ? `\\${char}` : char
  }
  return `.${escaped}`
}

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...sourceFiles(path))
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(path)
    }
  }
  return files
}

/** A color utility with an opacity modifier, optionally behind variants. */
const OPACITY_CLASS =
  /(?<![\w-])((?:[a-z-]+:)*(?:bg|text|border|ring|divide|outline|fill|stroke|from|via|to|decoration|placeholder|caret|accent|shadow)-[a-z]+(?:-[a-z]+)*(?:-\d{2,3})?\/(?:\d+|\[[\d.]+\]))(?![\w-])/g

describe('tailwind theme colors', () => {
  test('every theme color accepts an opacity modifier', async () => {
    const { themeColorVars } = await loadConfig()
    const names = Object.keys(themeColorVars)
    expect(names.length).toBeGreaterThan(10)
    const classes = names.flatMap((name) => [
      `bg-${name}/10`,
      `border-${name}/30`,
      `text-${name}/[0.15]`,
      `ring-${name}/30`,
    ])
    const rules = await compile(classes)
    for (const name of names) {
      const variable = themeColorVars[name]
      const expectations: [string, string, string][] = [
        [`bg-${name}/10`, 'background-color', '0.1'],
        [`border-${name}/30`, 'border-color', '0.3'],
        [`text-${name}/[0.15]`, 'color', '0.15'],
        [`ring-${name}/30`, '--tw-ring-color', '0.3'],
      ]
      for (const [className, prop, alpha] of expectations) {
        const value = rules.get(selectorFor(className))?.get(prop)
        expect({ className, value }).toEqual({
          className,
          value: `color-mix(in srgb, var(${variable}) calc(${alpha} * 100%), transparent)`,
        })
      }
    }
  })

  test('plain theme color classes compile to exactly the CSS variable', async () => {
    const { themeColorVars } = await loadConfig()
    const names = Object.keys(themeColorVars)
    const classes = names.flatMap((name) => [`bg-${name}`, `text-${name}`, `border-${name}`, `ring-${name}`])
    const rules = await compile(classes)
    for (const name of names) {
      const value = `var(${themeColorVars[name]})`
      // One declaration each: no --tw-*-opacity wrapper around the color.
      expect([...(rules.get(selectorFor(`bg-${name}`)) ?? [])]).toEqual([['background-color', value]])
      expect([...(rules.get(selectorFor(`text-${name}`)) ?? [])]).toEqual([['color', value]])
      expect([...(rules.get(selectorFor(`border-${name}`)) ?? [])]).toEqual([['border-color', value]])
      expect([...(rules.get(selectorFor(`ring-${name}`)) ?? [])]).toEqual([['--tw-ring-color', value]])
    }
  })

  test('every theme color variable is defined in the dark and light themes', async () => {
    const { themeColorVars } = await loadConfig()
    const css = readFileSync(join(CLIENT_DIR, 'styles', 'index.css'), 'utf8')
    const darkStart = css.indexOf('[data-theme="dark"] {')
    const lightStart = css.indexOf('[data-theme="light"] {')
    expect(darkStart).toBeGreaterThan(-1)
    expect(lightStart).toBeGreaterThan(darkStart)
    const dark = css.slice(darkStart, css.indexOf('}', darkStart))
    const light = css.slice(lightStart, css.indexOf('}', lightStart))
    for (const variable of Object.values(themeColorVars)) {
      expect({ variable, dark: dark.includes(`${variable}:`) }).toEqual({ variable, dark: true })
      expect({ variable, light: light.includes(`${variable}:`) }).toEqual({ variable, light: true })
    }
  })

  test('every opacity-modified color class in src/client compiles to a rule', async () => {
    const found = new Map<string, string>()
    for (const file of sourceFiles(CLIENT_DIR)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(OPACITY_CLASS)) {
        if (!found.has(match[1])) found.set(match[1], relative(ROOT, file))
      }
    }
    // The scan itself must keep finding the known uses.
    expect(found.has('bg-danger/10')).toBe(true)
    expect(found.has('hover:bg-accent/90')).toBe(true)

    const rules = await compile([...found.keys()])
    const selectors = [...rules.keys()]
    const missing = [...found].filter(([className]) => {
      const selector = selectorFor(className)
      return !selectors.some((s) => s === selector || s.startsWith(`${selector}:`))
    })
    expect(missing).toEqual([])
  })
})
