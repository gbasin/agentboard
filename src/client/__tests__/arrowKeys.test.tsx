import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import ArrowKeys, {
  ARROW_KEYS,
  PAD_WIDTH,
  REPEAT_INITIAL_DELAY,
  REPEAT_INTERVAL,
  getPadPosition,
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

function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find((b) => b.props['aria-label'] === label)
}

describe('getPadPosition', () => {
  test('centers the cluster above the key deck and keeps the deck outside the backdrop', () => {
    const pos = getPadPosition({ left: 178, top: 794, width: 44 }, 788, { width: 390, height: 844 })
    expect(pos.left).toBe(200)
    expect(pos.bottom).toBe(844 - 788 + 10)
    expect(pos.backdropHeight).toBe(788)
  })

  test('clamps to the viewport edges', () => {
    const nearLeft = getPadPosition({ left: 0, top: 794, width: 44 }, 788, { width: 390, height: 844 })
    expect(nearLeft.left).toBe(8 + PAD_WIDTH / 2)
    const nearRight = getPadPosition({ left: 380, top: 794, width: 44 }, 788, { width: 390, height: 844 })
    expect(nearRight.left).toBe(390 - 8 - PAD_WIDTH / 2)
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
    expect(cleared).toBeGreaterThan(0)
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

  test('does not open while disabled', () => {
    const sent: string[] = []
    const renderer = TestRenderer.create(<ArrowKeys onSendKey={(key) => sent.push(key)} disabled />)
    act(() => {
      findByLabel(renderer, 'Arrow keys')!.props.onPointerDown(pointerEvent())
    })
    expect(findByLabel(renderer, 'Arrow up')).toBeUndefined()
  })
})
