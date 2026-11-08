// agent-tui.ts - Fixture program that renders a believable coding-agent TUI.
//
// Runs inside a tmux pane in place of a real agent: `claude <scene>` or
// `codex <scene>` (shims in the private bin dir exec this file). It prints the
// scene's transcript inline, like the real CLIs, and keeps a live region at
// the bottom: a spinner while working (the pane changes, so Agentboard infers
// "working"), an idle input box while waiting (static, so "waiting"), or a
// permission card (matches statusInference's permission patterns).
//
// The mode comes from a control file (<state>/<scene>.mode) so the capture
// script can flip it; pressing 1 or Enter on a permission card approves it.
// On resize the whole screen is repainted at the new width.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureScene, type Block, type PaneMode, type Scene } from './scenes'

const [, , agentArg, sceneId, stateDir] = process.argv
const scene: Scene = fixtureScene(sceneId!)
const isCodex = agentArg === 'codex'
const modeFile = join(stateDir!, `${scene.id}.mode`)

// --- styling -------------------------------------------------------------

const ESC = '\x1b['
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(';')
const fg = (h: string) => `${ESC}38;2;${hex(h)}m`
const bg = (h: string) => `${ESC}48;2;${hex(h)}m`
const BOLD = `${ESC}1m`
const RESET = `${ESC}0m`

const C = {
  dim: '#737373',
  faint: '#a3a3a3',
  accent: '#c15f3c', // Claude's spinner orange
  ok: '#15803d',
  userBg: '#ececec',
  addBg: '#dcfce7',
  addFg: '#14532d',
  delBg: '#fee2e2',
  delFg: '#7f1d1d',
  rule: '#d4d4d4',
  perm: '#4f5bd5',
  code: '#7c3aed',
  link: '#2563eb',
}

const paint = (style: string, text: string) => (text ? `${style}${text}${RESET}` : '')

/** Inline `code` spans get a colour, like both CLIs render markdown code. */
function inline(text: string): string {
  return text.replace(/`([^`]+)`/g, (_, code: string) => paint(fg(C.code), code))
}

function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return [...text.replace(/\x1b\[[0-9;]*m/g, '')].length
}

/** Greedy word wrap on plain text (backticks count as zero width later). */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (visibleLength(candidate.replace(/`/g, '')) > width && line) {
        out.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    out.push(line)
  }
  return out
}

/** Re-balance backticks across wrapped lines so styling never spans lines. */
function balanceTicks(lines: string[]): string[] {
  let open = false
  return lines.map((line) => {
    let text = open ? `\`${line}` : line
    const ticks = (text.match(/`/g) ?? []).length
    open = ticks % 2 === 1
    if (open) text += '`'
    return text
  })
}

function prefixed(text: string, width: number, first: string, rest: string, firstLen: number): string[] {
  return balanceTicks(wrap(text, Math.max(10, width - firstLen))).map((line, i) => (i === 0 ? first : rest) + inline(line))
}

function clip(text: string, width: number): string {
  const chars = [...text]
  return chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join('')}…` : text
}

// --- transcript ----------------------------------------------------------

function renderBlock(block: Block, width: number): string[] {
  const bullet = isCodex ? '•' : '⏺'
  const result = isCodex ? '  └ ' : '  ⎿  '
  switch (block.t) {
    case 'user': {
      const glyph = isCodex ? '›' : '❯'
      const lines = wrap(block.text, width - 4).map((line, i) => `${i === 0 ? glyph : ' '} ${line}`)
      return lines.map((line) => `${bg(C.userBg)}${line}${' '.repeat(Math.max(0, width - visibleLength(line)))}${RESET}`)
    }
    case 'say':
      return prefixed(block.text, width, `${bullet} `, '  ', 2)
    case 'tool': {
      const head = isCodex
        ? `${paint(BOLD, `• ${block.name}`)} ${clip(block.arg, width - block.name.length - 4)}`
        : `${paint(fg(C.ok), '⏺')} ${paint(BOLD, block.name)}(${clip(block.arg, width - block.name.length - 6)})`
      return [head, ...block.out.map((line, i) => paint(fg(C.dim), `${i === 0 ? result : ' '.repeat(result.length)}${clip(line, width - 6)}`))]
    }
    case 'todo': {
      const head = isCodex ? paint(BOLD, '• Updated Plan') : `${paint(fg(C.ok), '⏺')} ${paint(BOLD, 'Update Todos')}`
      const firstOpen = block.items.findIndex(([done]) => !done)
      return [head, ...block.items.map(([done, text], i) => {
        const lead = i === 0 ? result : ' '.repeat(result.length)
        if (done) return `${lead}${paint(fg(C.faint), `☒ ${text}`)}`
        return `${lead}${i === firstOpen ? paint(BOLD, `☐ ${text}`) : `☐ ${text}`}`
      })]
    }
    case 'diff': {
      const head = isCodex
        ? `${paint(BOLD, '• Edited')} ${clip(block.file, width - 10)}`
        : `${paint(fg(C.ok), '⏺')} ${paint(BOLD, 'Update')}(${clip(block.file, width - 10)})`
      const summary = paint(fg(C.dim), `${result}${clip(block.summary, width - result.length)}`)
      const codeWidth = Math.min(width, 110) - 14
      const rows = block.lines.map(([n, sign, code]) => {
        const body = `${String(n).padStart(4)} ${sign} ${clip(code, codeWidth)}`
        const pad = ' '.repeat(Math.max(0, codeWidth + 7 - visibleLength(body)))
        if (sign === '+') return `      ${bg(C.addBg)}${fg(C.addFg)}${body}${pad}${RESET}`
        if (sign === '-') return `      ${bg(C.delBg)}${fg(C.delFg)}${body}${pad}${RESET}`
        return `      ${paint(fg(C.dim), body)}`
      })
      return [head, summary, ...rows]
    }
  }
}

function transcript(width: number): string[] {
  const lines: string[] = []
  for (const block of scene.blocks) {
    lines.push(...renderBlock(block, width), '')
  }
  return lines
}

// --- live region ---------------------------------------------------------

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const started = Date.now() - (scene.elapsed ?? 0) * 1000
let frame = 0

function duration(): string {
  const s = Math.floor((Date.now() - started) / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

function inputBox(width: number): string[] {
  const rule = paint(fg(C.rule), '─'.repeat(width))
  if (isCodex) {
    return [
      `${bg(C.userBg)}${paint(BOLD, '›')}${bg(C.userBg)} ${fg(C.faint)}Ask Codex to do anything${' '.repeat(Math.max(0, width - 26))}${RESET}`,
      '',
      paint(fg(C.dim), '  62% context left · ? for shortcuts'),
    ]
  }
  return [
    rule,
    `${paint(BOLD, '❯')} ${ESC}7m ${RESET}`,
    rule,
    paint(fg(C.dim), '  ⏵⏵ accept edits on (shift+tab to cycle)'),
  ]
}

function permissionCard(width: number): string[] {
  const p = scene.permission!
  const inner = width - 4
  const border = (l: string, r: string) => paint(fg(C.perm), `${l}${'─'.repeat(width - 2)}${r}`)
  const row = (text: string) => {
    const pad = ' '.repeat(Math.max(0, inner - visibleLength(text)))
    return `${paint(fg(C.perm), '│')} ${text}${pad} ${paint(fg(C.perm), '│')}`
  }
  return [
    border('╭', '╮'),
    row(paint(BOLD + fg(C.perm), p.title)),
    row(''),
    row(`  ${clip(p.command, inner - 2)}`),
    row(paint(fg(C.dim), `  ${clip(p.description, inner - 2)}`)),
    row(''),
    row('Do you want to proceed?'),
    row(`${paint(fg(C.perm), '❯')} ${paint(fg(C.perm), '1. Yes')}`),
    row(clip(`  2. Yes, and don't ask again for ${p.always} commands`, inner)),
    row(clip('  3. No, and tell Claude what to do differently (esc)', inner)),
    border('╰', '╯'),
  ]
}

/** Cut a styled line to `width` visible columns, keeping escape sequences. */
function clipAnsi(line: string, width: number): string {
  let visible = 0
  let outText = ''
  // eslint-disable-next-line no-control-regex
  for (const part of line.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) { outText += part; continue }
    for (const ch of part) {
      if (visible >= width) return outText + RESET
      outText += ch
      visible++
    }
  }
  return outText
}

/** The working status line; drops detail rather than wrapping when narrow. */
function statusLine(width: number): string {
  const label = scene.activity ?? 'Working'
  if (isCodex) {
    const glyph = paint(BOLD, frame % 10 < 5 ? '•' : '◦')
    const full = `${glyph} ${paint(BOLD, label)} ${paint(fg(C.dim), `(${duration()} • esc to interrupt)`)}`
    return visibleLength(full) <= width ? full : `${glyph} ${paint(BOLD, label)} ${paint(fg(C.dim), `(${duration()})`)}`
  }
  const glyph = paint(fg(C.accent), SPINNER[frame % SPINNER.length]!)
  const tokens = `↓ ${(1.2 + frame * 0.01).toFixed(1)}k tokens`
  const variants = [
    `(${duration()} · ${tokens} · esc to interrupt)`,
    `(${duration()} · ${tokens})`,
    `(${duration()})`,
  ]
  for (const detail of variants) {
    const line = `${glyph} ${paint(fg(C.accent), `${label}…`)} ${paint(fg(C.dim), detail)}`
    if (visibleLength(line) <= width) return line
  }
  return `${glyph} ${paint(fg(C.accent), `${label}…`)}`
}

function liveRegion(width: number): string[] {
  let lines: string[]
  if (mode === 'permission' && scene.permission) lines = permissionCard(width)
  else if (mode === 'working') lines = [statusLine(width), '', ...inputBox(width)]
  else lines = inputBox(width)
  // A wrapped live line would break the cursor arithmetic in drawLive.
  return lines.map((line) => clipAnsi(line, width))
}

// --- screen management ---------------------------------------------------

let mode: PaneMode = readMode()
/** Row of the live region the cursor was left on (-1: nothing drawn yet). */
let cursorRow = -1

function readMode(): PaneMode {
  if (!existsSync(modeFile)) return scene.mode
  const value = readFileSync(modeFile, 'utf-8').trim()
  return value === 'working' || value === 'waiting' || value === 'permission' ? value : scene.mode
}

const out = (text: string) => process.stdout.write(text)
const width = () => Math.max(20, (process.stdout.columns || 80) - 1)

/**
 * Where the hardware cursor rests: on the input caret, or on the selected
 * option of a permission card. The CLIs hide it, but parking it there means
 * a terminal that still draws it shows it in the natural place.
 */
function cursorAnchor(): [row: number, col: number] {
  if (mode === 'permission' && scene.permission) return [7, 2]
  const lead = mode === 'working' ? 2 : 0
  return isCodex ? [lead, 2] : [lead + 1, 2]
}

function drawLive(): void {
  const lines = liveRegion(width())
  // Back to the first live line, clear to the end of the screen, redraw.
  let move = '\r'
  if (cursorRow > 0) move += `${ESC}${cursorRow}A`
  const [row, col] = cursorAnchor()
  const up = lines.length - 1 - row
  out(`${ESC}?25l${move}${ESC}J${lines.join('\r\n')}\r${up > 0 ? `${ESC}${up}A` : ''}${ESC}${col}C`)
  cursorRow = row
}

function repaint(): void {
  // Clear screen and scrollback, then print everything at the new width.
  out(`${ESC}?25l${ESC}H${ESC}2J${ESC}3J${transcript(width()).join('\r\n')}\r\n`)
  cursorRow = -1
  drawLive()
}

out(`${ESC}?25l`)
repaint()
process.stdout.on('resize', repaint)

setInterval(() => {
  const next = readMode()
  if (next !== mode) {
    mode = next
    drawLive()
  } else if (mode === 'working') {
    frame++
    drawLive()
  }
}, 150)

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.on('data', (data: Buffer) => {
    const key = data.toString()
    if (key === '\x03') process.exit(0)
    if (mode === 'permission' && (key === '1' || key === '\r')) {
      writeFileSync(modeFile, 'working')
    }
  })
}
