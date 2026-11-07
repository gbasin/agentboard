import { afterEach, beforeEach, expect, test } from 'bun:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { editDeferredText, MAX_RECOVERY_TEXT, useRecoveryDraft } from '../hooks/useRecoveryDraft'

const originalStorage = globalThis.localStorage
beforeEach(() => {
  const values = new Map<string, string>()
  globalThis.localStorage = { get length() { return values.size }, key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) }, clear: () => values.clear() }
})
afterEach(() => { globalThis.localStorage = originalStorage })

test('draft editing preserves text/newlines, handles deletion, and excludes commands', () => {
  expect(editDeferredText('hello🙂', '\x7f', 'typing')).toBe('hello')
  expect(editDeferredText('a', '\r', 'typing')).toBe('a\n')
  expect(editDeferredText('a', '\x1b[A', 'typing')).toBe('a')
  expect(editDeferredText('a', '\x03', 'typing')).toBe('a')
  expect(editDeferredText('a', '\t', 'typing')).toBe('a')
  expect(editDeferredText('a', '\tcode\r\n', 'paste')).toBe('a\tcode\n')
  expect(editDeferredText('a', 'text\x1b[31m', 'paste')).toBe('a')
})

test('drafts stay with exact terminal identity and remain bounded across sessions', () => {
  let draft!: ReturnType<typeof useRecoveryDraft>
  const Harness = ({ identity }: { identity: string | null }) => { draft = useRecoveryDraft(identity); return null }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<Harness identity="A:target1" />) })
  act(() => { draft.capture('remember A', 'typing') })
  act(() => { renderer.update(<Harness identity="B:target2" />) })
  expect(draft.text).toBe('')
  act(() => { draft.capture('B', 'paste') })
  act(() => { renderer.update(<Harness identity="A:target1" />) })
  expect(draft.text).toBe('remember A')
  act(() => { draft.edit('x'.repeat(MAX_RECOVERY_TEXT + 10)) })
  expect(draft.text).toHaveLength(MAX_RECOVERY_TEXT - 1)
  expect(draft.atLimit).toBe(true)
  act(() => { renderer.update(<Harness identity="A:new-target" />) })
  expect(draft.text).toBe('')
  act(() => { renderer.update(<Harness identity="A:target1" />); })
  act(() => { draft.discard() })
  expect(draft.text).toBe('')
  act(() => { renderer.update(<Harness identity="B:target2" />) })
  expect(draft.text).toBe('B')
  act(() => { draft.edit('review\x1b[31m\r\n') })
  expect(draft.text).toBe('review[31m\n')
  act(() => { renderer.unmount() })
})

test('capacity rejection remains visible and requires review even when another terminal consumed the budget', () => {
  let draft!: ReturnType<typeof useRecoveryDraft>
  const Harness = ({ identity }: { identity: string }) => { draft = useRecoveryDraft(identity); return null }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<Harness identity="A" />) })
  act(() => { draft.capture('x'.repeat(MAX_RECOVERY_TEXT), 'paste') })
  act(() => { renderer.update(<Harness identity="B" />) })
  expect(draft.pending).toBe(false)
  act(() => { draft.capture('must not disappear silently', 'typing') })
  expect(draft.text).toBe('')
  expect(draft.pending).toBe(true)
  expect(draft.truncated).toBe(true)
  expect(draft.hasOtherDrafts).toBe(true)
  act(() => { draft.discardOthers() })
  expect(draft.pending).toBe(true)
  expect(draft.atLimit).toBe(false)
  act(() => { draft.edit('reviewed replacement') })
  expect(draft.truncated).toBe(false)
  expect(draft.text).toBe('reviewed replacement')
  act(() => { draft.discard() })
  expect(draft.pending).toBe(false)
  act(() => { renderer.unmount() })
})


test('hook remount restores a review draft and explicit discard survives another remount', () => {
  let draft!: ReturnType<typeof useRecoveryDraft>
  const Harness = () => { draft = useRecoveryDraft('durable'); return null }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<Harness />) })
  act(() => { draft.capture('preserved', 'typing') })
  expect(draft.persistence).toBe('saved')
  act(() => { renderer.unmount() })
  act(() => { renderer = TestRenderer.create(<Harness />) })
  expect(draft.text).toBe('preserved')
  expect(draft.pending).toBe(true)
  act(() => { draft.discard(); renderer.unmount() })
  act(() => { renderer = TestRenderer.create(<Harness />) })
  expect(draft.pending).toBe(false)
  act(() => { renderer.unmount() })
})
