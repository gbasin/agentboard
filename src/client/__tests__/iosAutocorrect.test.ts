import { describe, expect, test } from 'bun:test'
import { correctionDelta } from '../utils/iosAutocorrect'

describe('experimental autocorrect terminal delta', () => {
  test('replaces a misspelling without retyping the unchanged prefix', () => {
    expect(correctionDelta('please fix teh', 'please fix the')).toBe('\x7f\x7fhe')
  })
  test('handles longer and shorter replacements', () => {
    expect(correctionDelta('dont', "don't")).toBe("\x7f't")
    expect(correctionDelta('helllo', 'hello')).toBe('\x7f\x7fo')
  })
  test('appends, deletes, and suppresses duplicate composition updates', () => {
    expect(correctionDelta('the', 'the ')).toBe(' ')
    expect(correctionDelta('the ', 'the')).toBe('\x7f')
    expect(correctionDelta('the', 'the')).toBe('')
  })
  test('does not split surrogate pairs', () => {
    expect(correctionDelta('hi 😀', 'hi 😃')).toBe('\x7f😃')
  })
})
