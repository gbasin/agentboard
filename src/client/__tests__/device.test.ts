import { describe, expect, test } from 'bun:test'
import {
  getJumpChordDisplay,
  getNavShortcutMod,
  isIOSDevice,
  isIOSPWA,
  isMacOS,
  isSafari,
  matchesJumpChord,
} from '../utils/device'

const globalAny = globalThis as typeof globalThis & {
  navigator?: any
}

describe('isIOSDevice', () => {
  test('returns false without navigator', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = undefined
      expect(isIOSDevice()).toBe(false)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('detects iPhone user agent', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        platform: 'iPhone',
        maxTouchPoints: 1,
      } as any
      expect(isIOSDevice()).toBe(true)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('detects iPadOS via MacIntel platform with touch', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      } as any
      expect(isIOSDevice()).toBe(true)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })
})

describe('device helpers', () => {
  test('detects iOS PWA mode', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        platform: 'iPhone',
        maxTouchPoints: 1,
        standalone: true,
      } as any
      expect(isIOSPWA()).toBe(true)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('detects Safari without Chrome', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      } as any
      expect(isSafari()).toBe(true)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('treats Chrome as non-Safari', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      } as any
      expect(isSafari()).toBe(false)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('detects macOS and returns shortcut modifiers', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      } as any
      expect(isMacOS()).toBe(true)
      const macShortcut = `${String.fromCharCode(0x2303)}${String.fromCharCode(0x2325)}`
      expect(getNavShortcutMod()).toBe(macShortcut)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('returns Windows/Linux shortcut modifiers on non-macOS', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Win32',
        maxTouchPoints: 0,
      } as any
      expect(isMacOS()).toBe(false)
      // ⌃⇧ (Control+Shift symbols)
      const nonMacShortcut = `${String.fromCharCode(0x2303)}${String.fromCharCode(0x21e7)}`
      expect(getNavShortcutMod()).toBe(nonMacShortcut)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })
})

describe('matchesJumpChord', () => {
  const ev = (init: Partial<KeyboardEvent>) => init as KeyboardEvent

  test('off never matches', () => {
    expect(matchesJumpChord(ev({ metaKey: true }), 'off', 'ctrl-option')).toBe(false)
    expect(matchesJumpChord(ev({ ctrlKey: true }), 'off', 'ctrl-option')).toBe(false)
  })

  test('modifier delegates to the configured letter-shortcut combo', () => {
    const ctrlAlt = ev({ ctrlKey: true, altKey: true, metaKey: false, shiftKey: false })
    expect(matchesJumpChord(ctrlAlt, 'modifier', 'ctrl-option')).toBe(true)
    expect(matchesJumpChord(ctrlAlt, 'modifier', 'cmd-shift')).toBe(false)
  })

  test('meta matches a bare Cmd only', () => {
    const bare = ev({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })
    expect(matchesJumpChord(bare, 'meta', 'ctrl-option')).toBe(true)
    // extra modifiers must not match, so ⌘⇧1 stays available to the browser
    expect(matchesJumpChord(ev({ metaKey: true, shiftKey: true }), 'meta', 'ctrl-option')).toBe(
      false
    )
    expect(matchesJumpChord(ev({ metaKey: false }), 'meta', 'ctrl-option')).toBe(false)
  })

  test('ctrl matches a bare Ctrl only', () => {
    const bare = ev({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })
    expect(matchesJumpChord(bare, 'ctrl', 'ctrl-option')).toBe(true)
    expect(matchesJumpChord(ev({ ctrlKey: true, altKey: true }), 'ctrl', 'ctrl-option')).toBe(false)
  })
})

describe('getJumpChordDisplay', () => {
  test('renders the chord symbols', () => {
    expect(getJumpChordDisplay('meta', 'ctrl-option')).toBe('⌘')
    expect(getJumpChordDisplay('ctrl', 'ctrl-option')).toBe('⌃')
    expect(getJumpChordDisplay('modifier', 'cmd-shift')).toBe('⌘⇧')
    expect(getJumpChordDisplay('off', 'ctrl-option')).toBe('')
  })
})
