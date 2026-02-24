import { describe, expect, test } from 'bun:test'
import { composeSortableTransform } from '../utils/sortableTransform'

describe('composeSortableTransform', () => {
  test('applies dnd transform for non-dragging items in Safari fallback', () => {
    const result = composeSortableTransform({
      useSafariLayoutFallback: true,
      isDragging: false,
      dndTransform: 'translate3d(0px, 12px, 0)',
      generatedTransform: 'none',
    })

    expect(result).toBe('translate3d(0px, 12px, 0)')
  })

  test('keeps generated transform when Safari fallback has no dnd transform', () => {
    const result = composeSortableTransform({
      useSafariLayoutFallback: true,
      isDragging: false,
      dndTransform: undefined,
      generatedTransform: 'scale(1)',
    })

    expect(result).toBe('scale(1)')
  })

  test('merges dnd and generated transforms when both are present', () => {
    const result = composeSortableTransform({
      useSafariLayoutFallback: false,
      isDragging: false,
      dndTransform: 'translate3d(0px, 12px, 0)',
      generatedTransform: 'scale(0.98)',
    })

    expect(result).toBe('translate3d(0px, 12px, 0) scale(0.98)')
  })
})
