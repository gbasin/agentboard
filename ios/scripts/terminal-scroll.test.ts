import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../AgentboardSpike/Web/terminal-scroll.js', import.meta.url), 'utf8')
function setup() {
  const handlers: Record<string, (event: any) => void> = {}
  const messages: string[] = []
  let wheel: (event: any) => boolean = () => true
  const state = { live: true, selection: false }
  const context = { window: {} as any }
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
  return { state, messages, touch, scroll, wheel: (deltaY: number, deltaMode = 0) => wheel({ deltaY, deltaMode }) }
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
