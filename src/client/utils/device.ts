import type { SessionJumpChord, ShortcutModifier } from '../stores/settingsStore'

export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const iOS = /iPad|iPhone|iPod/.test(ua)
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  return iOS || iPadOS
}

export function isIOSPWA(): boolean {
  if (typeof navigator === 'undefined') return false
  return isIOSDevice() && (navigator as { standalone?: boolean }).standalone === true
}

export function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // Safari but not Chrome (Chrome includes "Safari" in its UA)
  return /Safari/.test(ua) && !/Chrome/.test(ua) && !/Chromium/.test(ua)
}

export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return navigator.platform.toUpperCase().indexOf('MAC') >= 0
}

// Keyboard shortcut display helpers

export type EffectiveModifier = ShortcutModifier

// Resolve 'auto' to platform default
export function getEffectiveModifier(
  setting: ShortcutModifier | 'auto'
): EffectiveModifier {
  if (setting === 'auto') {
    return isMacOS() ? 'ctrl-option' : 'ctrl-shift'
  }
  return setting
}

// Display symbols for each modifier combo
const MODIFIER_DISPLAY: Record<EffectiveModifier, string> = {
  'ctrl-option': '⌃⌥',
  'ctrl-shift': '⌃⇧',
  'cmd-option': '⌘⌥',
  'cmd-shift': '⌘⇧',
}

// Get display string for the shortcut modifier
export function getModifierDisplay(modifier: EffectiveModifier): string {
  return MODIFIER_DISPLAY[modifier]
}

// Check if a keyboard event matches the modifier combo
export function matchesModifier(
  event: KeyboardEvent,
  modifier: EffectiveModifier
): boolean {
  switch (modifier) {
    case 'ctrl-option':
      return event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey
    case 'ctrl-shift':
      return event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey
    case 'cmd-option':
      return event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
    case 'cmd-shift':
      return event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey
  }
}

// Check if a keyboard event matches the jump-to-session chord.
// 'modifier' reuses the configured letter-shortcut combo; 'meta'/'ctrl' match a
// bare ⌘/⌃ with no other modifiers held.
export function matchesJumpChord(
  event: KeyboardEvent,
  chord: SessionJumpChord,
  modifier: EffectiveModifier
): boolean {
  switch (chord) {
    case 'off':
      return false
    case 'modifier':
      return matchesModifier(event, modifier)
    case 'meta':
      return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    case 'ctrl':
      return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  }
}

// Display string for the jump-to-session chord, e.g. '⌘' or '⌃⌥'
export function getJumpChordDisplay(
  chord: SessionJumpChord,
  modifier: EffectiveModifier
): string {
  switch (chord) {
    case 'off':
      return ''
    case 'modifier':
      return getModifierDisplay(modifier)
    case 'meta':
      return '⌘'
    case 'ctrl':
      return '⌃'
  }
}

// Legacy helper - returns display for current platform default
export function getNavShortcutMod(): string {
  return isMacOS() ? '⌃⌥' : '⌃⇧'
}
