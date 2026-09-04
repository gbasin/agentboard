import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import ArrowKeys, {
  ARROW_KEYS,
  PAD_WIDTH,
  REPEAT_INITIAL_DELAY,
  REPEAT_INTERVAL,
  getPadLeft,
} from '../components/ArrowKeys'

const globalAny = globalThis as any

const originalNavigator = globalAny.navigator
const originalSetTimeout = globalAny.setTimeout
const originalSetInterval = globalAny.setInterval
const originalClearTimeout = globalAny.clearTimeout
const originalClearInterval = globalAny.clearInterval

afterEach(() => {
  globalAny.navigator = originalNavigator
  globalAny.setTimeout = originalSetTimeout
  globalAny.setInterval = originalSetInterval
  globalAny.clearTimeout = originalClearTimeout
  globalAny.clearInterval = originalClearInterval
})

function pointerEvent(extra: Record<string, unknown> = {}) {
  return {
    pointerId: 1,
    preventDefault: () => {},
    currentTarget: { setPointerCapture: () => {} },
    ...extra,
  } as any
}

function render(sent: string[], opts: { onRefocus?: () => void; isKeyboardVisible?: () => boolean } = {}) {
  return TestRenderer.create(
    <ArrowKeys onSendKey={(key) => sent.push(key)} onRefocus={opts.onRefocus} isKeyboardVisible={opts.isKeyboardVisible} />
  )
}

function fakeTimers() {
  const timeouts: Array<{ cb: () => void; delay: number }> = []
  const intervals: Array<{ cb: () => void; delay: number }> = []
  let cleared = 0
  globalAny.setTimeout = ((cb: () => void, delay: number) => {
    timeouts.push({ cb, delay })
    return timeouts.length
  }) as typeof setTimeout
  globalAny.setInterval = ((cb: () => void, delay: number) => {
    intervals.push({ cb, delay })
    return intervals.length
  }) as typeof setInterval
  globalAny.clearTimeout = (() => {}) as typeof clearTimeout
  globalAny.clearInterval = (() => {
    cleared += 1
  }) as typeof clearInterval
  return { timeouts, intervals, cleared: () => cleared }
}

/** Open the cluster, press `direction`, and run the hold until the interval exists. */
function pressAndHold(renderer: TestRenderer.ReactTestRenderer, direction: string, timers: ReturnType<typeof fakeTimers>) {
  act(() => {
    findByLabel(renderer, 'Arrow keys')!.props.onPointerDown(pointerEvent())
  })
  act(() => {
    findByLabel(renderer, `Arrow ${direction}`)!.props.onPointerDown(pointerEvent())
  })
  act(() => {
    timers.timeouts[timers.timeouts.length - 1].cb()
  })
  return timers.intervals[timers.intervals.length - 1]
}

function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find((b) => b.props['aria-label'] === label)
}

describe('getPadLeft', () => {
  test('centers the cluster on the trigger, in container coordinates', () => {
    expect(getPadLeft({ left: 178, width: 44 }, { left: 0, width: 390 })).toBe(200)
    // Container offset (e.g. the transformed iOS root) is subtracted.
    expect(getPadLeft({ left: 188, width: 44 }, { left: 10, width: 390 })).toBe(200)
  })

  test('clamps to the container edges', () => {
    expect(getPadLeft({ left: 0, width: 44 }, { left: 0, width: 390 })).toBe(8 + PAD_WIDTH / 2)
    expect(getPadLeft({ left: 380, width: 44 }, { left: 0, width: 390 })).toBe(390 - 8 - PAD_WIDTH / 2)
  })

  test('centers when the container is narrower than the pad', () => {
    expect(getPadLeft({ left: 10, width: 44 }, { left: 0, width: 120 })).toBe(60)
  })
})

describe('ArrowKeys component', () => {
  test('cluster is hidden until the trigger is tapped, and toggles closed', () => {
    globalAny.navigator = { vibrate: () => true }
    const sent: string[] = []
    const renderer = render(sent)

    expect(findByLabel(renderer, 'Arrow up')).toBeUndefined()

    const trigger = findByLabel(renderer, 'Arrow keys')!
    act(() => {
      trigger.props.onPointerDown(pointerEvent())
    })
    expect(trigger.props['aria-expanded']).toBe(true)
    expect(findByLabel(renderer, 'Arrow up')).toBeDefined()
    expect(findByLabel(renderer, 'Arrow down')).toBeDefined()
    expect(findByLabel(renderer, 'Arrow left')).toBeDefined()
    expect(findByLabel(renderer, 'Arrow right')).toBeDefined()

    act(() => {
      trigger.props.onPointerDown(pointerEvent())
    })
    expect(findByLabel(renderer, 'Arrow up')).toBeUndefined()
    expect(sent).toEqual([])
  })

  test('tap sends one arrow; hold repeats after the initial delay', () => {
    globalAny.navigator = { vibrate: () => true }
    const { timeouts, intervals, cleared } = fakeTimers()

    const sent: string[] = []
    const renderer = render(sent)
    act(() => {
      findByLabel(renderer, 'Arrow keys')!.props.onPointerDown(pointerEvent())
    })

    const up = findByLabel(renderer, 'Arrow up')!
    act(() => {
      up.props.onPointerDown(pointerEvent())
    })
    expect(sent).toEqual([ARROW_KEYS.up])

    // Held: the initial delay elapses, then the interval fires repeatedly.
    const delay = timeouts[timeouts.length - 1]
    expect(delay.delay).toBe(REPEAT_INITIAL_DELAY)
    act(() => {
      delay.cb()
    })
    const repeat = intervals[intervals.length - 1]
    expect(repeat.delay).toBe(REPEAT_INTERVAL)
    act(() => {
      repeat.cb()
      repeat.cb()
    })
    expect(sent).toEqual([ARROW_KEYS.up, ARROW_KEYS.up, ARROW_KEYS.up])

    // Release stops the repeat; a late tick sends nothing.
    act(() => {
      up.props.onPointerUp(pointerEvent())
    })
    expect(cleared()).toBeGreaterThan(0)
    act(() => {
      repeat.cb()
    })
    expect(sent).toHaveLength(3)

    // The cluster stays open for the next press.
    act(() => {
      findByLabel(renderer, 'Arrow right')!.props.onPointerDown(pointerEvent())
      findByLabel(renderer, 'Arrow right')!.props.onPointerUp(pointerEvent())
    })
    expect(sent[3]).toBe(ARROW_KEYS.right)
  })

  test('tapping the backdrop closes and refocuses when the keyboard was up', () => {
    globalAny.navigator = { vibrate: () => true }
    const sent: string[] = []
    let refocused = 0
    const renderer = render(sent, { onRefocus: () => { refocused += 1 }, isKeyboardVisible: () => true })

    act(() => {
      findByLabel(renderer, 'Arrow keys')!.props.onPointerDown(pointerEvent())
    })
    const backdrop = renderer.root.findAll((n) => n.props?.['data-testid'] === 'arrow-keys-backdrop')[0]
    expect(backdrop).toBeDefined()
    act(() => {
      backdrop.props.onPointerDown(pointerEvent())
    })
    expect(findByLabel(renderer, 'Arrow up')).toBeUndefined()
    expect(refocused).toBe(1)
    expect(sent).toEqual([])
  })

  test('a held repeat uses the latest sender and stops on session switch', () => {
    globalAny.navigator = { vibrate: () => true }
    const timers = fakeTimers()
    const sentA: string[] = []
    const sentB: string[] = []
    const renderer = TestRenderer.create(
      <ArrowKeys onSendKey={(key) => sentA.push(key)} sessionKey="a" />
    )
    const repeat = pressAndHold(renderer, 'up', timers)
    act(() => {
      repeat.cb()
    })
    expect(sentA).toEqual([ARROW_KEYS.up, ARROW_KEYS.up])

    // The sender prop changes (e.g. rebinding) while still held: the timer
    // must call the new one, never the stale closure.
    act(() => {
      renderer.update(<ArrowKeys onSendKey={(key) => sentB.push(key)} sessionKey="a" />)
    })
    act(() => {
      repeat.cb()
    })
    expect(sentA).toHaveLength(2)
    expect(sentB).toEqual([ARROW_KEYS.up])

    // The session changes while held: the repeat stops outright.
    act(() => {
      renderer.update(<ArrowKeys onSendKey={(key) => sentB.push(key)} sessionKey="b" />)
    })
    act(() => {
      repeat.cb()
    })
    expect(sentB).toHaveLength(1)
  })

  test('disabling mid-hold stops the repeat, including an already-queued tick', () => {
    globalAny.navigator = { vibrate: () => true }
    const timers = fakeTimers()
    const sent: string[] = []
    const renderer = TestRenderer.create(<ArrowKeys onSendKey={(key) => sent.push(key)} />)
    const repeat = pressAndHold(renderer, 'down', timers)
    act(() => {
      renderer.update(<ArrowKeys onSendKey={(key) => sent.push(key)} disabled />)
    })
    act(() => {
      repeat.cb()
    })
    expect(sent).toEqual([ARROW_KEYS.down])
    expect(findByLabel(renderer, 'Arrow up')).toBeUndefined()
  })

  test('a second finger neither replaces nor releases the held arrow', () => {
    globalAny.navigator = { vibrate: () => true }
    const timers = fakeTimers()
    const sent: string[] = []
    const renderer = TestRenderer.create(<ArrowKeys onSendKey={(key) => sent.push(key)} />)
    const repeat = pressAndHold(renderer, 'up', timers)

    act(() => {
      findByLabel(renderer, 'Arrow right')!.props.onPointerDown(pointerEvent({ pointerId: 2 }))
    })
    act(() => {
      findByLabel(renderer, 'Arrow right')!.props.onPointerUp(pointerEvent({ pointerId: 2 }))
    })
    act(() => {
      repeat.cb()
    })
    expect(sent).toEqual([ARROW_KEYS.up, ARROW_KEYS.up])

    act(() => {
      findByLabel(renderer, 'Arrow up')!.props.onPointerUp(pointerEvent({ pointerId: 1 }))
    })
    act(() => {
      repeat.cb()
    })
    expect(sent).toHaveLength(2)
  })

  test('keyboard activation opens and sends; the click that follows a pointerdown is ignored', () => {
    globalAny.navigator = { vibrate: () => true }
    const sent: string[] = []
    const renderer = TestRenderer.create(<ArrowKeys onSendKey={(key) => sent.push(key)} />)
    const trigger = findByLabel(renderer, 'Arrow keys')!

    // Touch: pointerdown opens, the browser's synthesized click must not
    // toggle it straight back closed.
    act(() => {
      trigger.props.onPointerDown(pointerEvent())
    })
    act(() => {
      trigger.props.onClick({ detail: 0 })
    })
    expect(findByLabel(renderer, 'Arrow up')).toBeDefined()

    // Same for an arrow: one send, not two.
    act(() => {
      findByLabel(renderer, 'Arrow up')!.props.onPointerDown(pointerEvent())
      findByLabel(renderer, 'Arrow up')!.props.onPointerUp(pointerEvent())
      findByLabel(renderer, 'Arrow up')!.props.onClick({ detail: 0 })
    })
    expect(sent).toEqual([ARROW_KEYS.up])

    // Keyboard / AT: a click with no recent pointerdown activates.
    const realNow = Date.now
    Date.now = () => realNow() + 5000
    try {
      act(() => {
        findByLabel(renderer, 'Arrow right')!.props.onClick({ detail: 0 })
      })
      expect(sent).toEqual([ARROW_KEYS.up, ARROW_KEYS.right])
      act(() => {
        trigger.props.onClick({ detail: 0 })
      })
      expect(findByLabel(renderer, 'Arrow up')).toBeUndefined()
    } finally {
      Date.now = realNow
    }
  })

  test('does not open while disabled', () => {
    const sent: string[] = []
    const renderer = TestRenderer.create(<ArrowKeys onSendKey={(key) => sent.push(key)} disabled />)
    act(() => {
      findByLabel(renderer, 'Arrow keys')!.props.onPointerDown(pointerEvent())
    })
    expect(findByLabel(renderer, 'Arrow up')).toBeUndefined()
  })
})
