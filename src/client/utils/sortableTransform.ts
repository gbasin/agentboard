export interface ComposeSortableTransformOptions {
  useSafariLayoutFallback: boolean
  isDragging: boolean
  dndTransform: string | undefined
  generatedTransform: string
}

export function composeSortableTransform({
  useSafariLayoutFallback,
  isDragging,
  dndTransform,
  generatedTransform,
}: ComposeSortableTransformOptions): string {
  // Safari fallback disables Motion layout transforms, but we still need
  // dnd-kit transforms for non-dragging item displacement during sorting.
  if (useSafariLayoutFallback && !isDragging && !dndTransform) {
    return generatedTransform
  }
  if (!dndTransform) return generatedTransform
  if (!generatedTransform || generatedTransform === 'none') return dndTransform
  return `${dndTransform} ${generatedTransform}`
}
