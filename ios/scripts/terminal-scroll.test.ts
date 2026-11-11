import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../AgentboardSpike/Web/terminal-scroll.js', import.meta.url), 'utf8')
function setup() {
  const handlers: Record<string, (event: any) => void> = {}
  const messages: string[] = []
  let wheel: (event: any) => boolean = () => true
  const state = { live: true, selection: false }
  let now = 0
  let nextFrame = 0
  const frames = new Map<number, (time: number) => void>()
  const advance = (ms = 16) => {
    now += ms
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(now)
  }
  const context = { window: {} as any, performance: { now: () => now },
    requestAnimationFrame: (callback: (time: number) => void) => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: (id: number) => frames.delete(id) }
  runInNewContext(source, context)
  const scroll = context.window.installTerminalScroll({ cols: 80, rows: 24,
    hasSelection: () => state.selection,
    attachCustomWheelEventHandler: (handler: typeof wheel) => { wheel = handler },
  }, { clientHeight: 600, addEventListener: (name: string, handler: any) => { handlers[name] = handler } }, {
    live: () => state.live, input: (data: string) => messages.push(data),
  })
  const touch = (type: string, y: number, x = 10, count = 1) => {
    let prevented = false
    handlers[type]({ touches: Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y })),
      preventDefault: () => { prevented = true }, stopImmediatePropagation() {} })
    return prevented
  }
  return { state, messages, touch, scroll, advance, frames, wheel: (deltaY: number, deltaMode = 0) => wheel({ deltaY, deltaMode }) }
}

test('live finger drag reaches tmux history in both directions without local scrolling', () => {
  const h = setup()
  h.touch('touchstart', 100)
  expect(h.touch('touchmove', 160)).toBe(true)
  expect(h.messages).toEqual(['\x1b[<64;40;12M'.repeat(2)])
  h.touch('touchmove', 130)
  expect(h.messages[1]).toBe('\x1b[<65;40;12M')
})

test('tap, horizontal swipe, selection and multitouch do not send scroll input', () => {
  const h = setup()
  h.touch('touchstart', 100); h.touch('touchend', 100)
  h.touch('touchstart', 100); h.touch('touchmove', 102, 80)
  h.touch('touchmove', 200, 80)
  h.state.selection = true
  h.touch('touchstart', 100); h.touch('touchmove', 200)
  h.state.selection = false
  h.touch('touchstart', 100); h.touch('touchmove', 200, 10, 2)
  expect(h.messages).toEqual([])
})

test('cancel, reconnect reset, and disconnected moves discard gesture state', () => {
  const h = setup()
  for (const end of [() => h.touch('touchcancel', 110), () => h.scroll.reset(), () => { h.state.live = false }]) {
    h.state.live = true
    h.touch('touchstart', 100); h.touch('touchmove', 110)
    end(); h.touch('touchmove', 200)
  }
  expect(h.messages).toEqual([])
})

test('wheel handles pixel and line units; sample terminal keeps native xterm scrolling', () => {
  const h = setup()
  expect(h.wheel(-30)).toBe(false)
  expect(h.wheel(1, 1)).toBe(false)
  expect(h.messages).toEqual(['\x1b[<64;40;12M', '\x1b[<65;40;12M'])
  h.state.live = false
  expect(h.wheel(-30)).toBe(true)
  h.touch('touchstart', 100); h.touch('touchmove', 200)
  expect(h.messages.length).toBe(2)
})


test('flick coasts through history and decays to a stop', () => {
  const h = setup()
  h.touch('touchstart', 100)
  h.advance(100)
  h.touch('touchmove', 250)
  const dragCount = h.messages.join('').split('M').length - 1
  h.touch('touchend', 250)
  for (let i = 0; i < 100; i++) h.advance()
  expect(h.messages.join('').split('M').length - 1).toBeGreaterThan(dragCount * 2)
  expect(h.frames.size).toBe(0)
})

test('new touch, input reset, selection and disconnect stop momentum', () => {
  for (const stop of [(h: any) => h.touch('touchstart', 250), (h: any) => h.scroll.reset(),
    (h: any) => { h.state.selection = true }, (h: any) => { h.state.live = false }]) {
    const h = setup()
    h.touch('touchstart', 100); h.advance(100); h.touch('touchmove', 250); h.touch('touchend', 250)
    stop(h)
    const count = h.messages.length
    h.advance(32); h.advance(32)
    expect(h.messages.length).toBe(count)
    expect(h.frames.size).toBe(0)
  }
})

test('holding still before release and canceled gestures never coast', () => {
  for (const cancel of [false, true]) {
    const h = setup()
    h.touch('touchstart', 100); h.advance(100); h.touch('touchmove', 250)
    h.advance(100)
    h.touch(cancel ? 'touchcancel' : 'touchend', 250)
    expect(h.frames.size).toBe(0)
  }
})
