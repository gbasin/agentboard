/**
 * ContextMenu - anchored right-click menu primitive. Renders fixed at the
 * pointer and flips upward when `anchorFromBottom` is set (status rail sits
 * at the viewport bottom, so its menu opens above the cursor).
 * Dismisses on click-outside, touch-outside, or Escape. Items are config
 * objects so callers keep menus declarative.
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export interface ContextMenuItem {
  key: string
  label: string
  icon: ReactNode
  onSelect: () => void
  danger?: boolean
  title?: string
}

export type ContextMenuEntry = ContextMenuItem | 'divider'

interface ContextMenuProps {
  anchor: { x: number; y: number }
  items: ContextMenuEntry[]
  /** Menu renders above the anchor instead of below it */
  anchorFromBottom?: boolean
  onClose: () => void
}

export default function ContextMenu({
  anchor,
  items,
  anchorFromBottom = false,
  onClose,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  // Clamp horizontally so a right-click near the viewport edge keeps the
  // menu on-screen (min-w + padding ≈ 190px).
  const left =
    typeof window === 'undefined'
      ? anchor.x
      : Math.min(anchor.x, Math.max(8, window.innerWidth - 190))

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[180px] rounded-md border border-border bg-elevated py-1 shadow-lg"
      style={{
        left,
        top: anchor.y,
        transform: anchorFromBottom ? 'translateY(calc(-100% - 6px))' : undefined,
      }}
      role="menu"
    >
      {items.map((item, i) =>
        item === 'divider' ? (
          <div key={`divider-${i}`} className="my-1 border-t border-border" />
        ) : (
          <button
            key={item.key}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
              item.onSelect()
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
              item.danger
                ? 'text-danger hover:bg-danger/10'
                : 'text-secondary hover:bg-hover hover:text-primary'
            }`}
            role="menuitem"
            title={item.title}
          >
            {item.icon}
            {item.label}
          </button>
        )
      )}
    </div>
  )
}
