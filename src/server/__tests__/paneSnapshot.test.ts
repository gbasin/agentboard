import { describe, expect, test } from 'bun:test'
import { capturePaneSnapshot, parsePaneState, SNAPSHOT_HISTORY_LINES, type TmuxRunner } from '../paneSnapshot'

function fakeTmux(state: string, capture: string, failOn?: 'display-message' | 'capture-pane') {
  const calls: string[][] = []
  const run: TmuxRunner = async (args) => {
    calls.push(args)
    if (args[0] === failOn) return { exitCode: 1, stdout: '' }
    return { exitCode: 0, stdout: args[0] === 'display-message' ? state : capture }
  }
  return { run, calls }
}

describe('parsePaneState', () => {
  test('reads alt screen, history and copy-mode scroll position', () => {
    expect(parsePaneState('0,120,1,7\n')).toEqual({ altScreen: false, historySize: 120, scrollPosition: 7 })
  })

  test('ignores the scroll position outside copy mode and bad numbers', () => {
    expect(parsePaneState('1,abc,0,9')).toEqual({ altScreen: true, historySize: 0, scrollPosition: 0 })
    expect(parsePaneState('')).toEqual({ altScreen: false, historySize: 0, scrollPosition: 0 })
  })
})

describe('capturePaneSnapshot', () => {
  test('main screen captures joined scrollback plus the visible screen', async () => {
    const { run, calls } = fakeTmux('0,40,0,', 'a\nb\n')
    const snapshot = await capturePaneSnapshot('=s:1', run)
    expect(calls[1]).toEqual(['capture-pane', '-p', '-J', '-S', '-40', '-t', '=s:1'])
    expect(snapshot).toEqual({ text: 'a\nb', historyLines: 40, scrollPosition: 0, altScreen: false })
  })

  test('caps the history, drops the possibly partial first line, clamps the offset', async () => {
    const { run, calls } = fakeTmux(`0,99999,1,99999`, 'r the lazy dog\nrow 2\nrow 3\n')
    const snapshot = await capturePaneSnapshot('t', run)
    expect(calls[1]).toContain(`-${SNAPSHOT_HISTORY_LINES}`)
    expect(snapshot?.text).toBe('row 2\nrow 3')
    expect(snapshot?.scrollPosition).toBe(SNAPSHOT_HISTORY_LINES)
  })

  test('keeps the first line when the whole history fits', async () => {
    const { run } = fakeTmux(`0,${SNAPSHOT_HISTORY_LINES},0,`, 'first\nsecond\n')
    expect((await capturePaneSnapshot('t', run))?.text).toBe('first\nsecond')
    const single = fakeTmux('0,99999,0,', 'only\n')
    expect((await capturePaneSnapshot('t', single.run))?.text).toBe('only')
  })

  test('alternate screen captures only the visible screen', async () => {
    const { run, calls } = fakeTmux('1,500,0,', 'screen\n\n')
    const snapshot = await capturePaneSnapshot('t', run)
    expect(calls[1]).toEqual(['capture-pane', '-p', '-J', '-t', 't'])
    expect(snapshot).toEqual({ text: 'screen\n', historyLines: 0, scrollPosition: 0, altScreen: true })
  })

  test('returns null when either tmux call fails', async () => {
    expect(await capturePaneSnapshot('t', fakeTmux('0,0,0,', '', 'display-message').run)).toBeNull()
    expect(await capturePaneSnapshot('t', fakeTmux('0,0,0,', '', 'capture-pane').run)).toBeNull()
  })
})
