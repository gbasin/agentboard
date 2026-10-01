/**
 * Shared look for the sidebar's square icon buttons (filter funnel, settings
 * gear, connection-dot button): a 28px bordered square with hover and
 * keyboard focus-ring states. One constant so they cannot drift apart.
 */
export const SIDEBAR_ICON_BUTTON_BASE =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded border active:scale-95 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

export const SIDEBAR_ICON_BUTTON_TONE = {
  neutral: 'border-border text-secondary hover:bg-hover hover:text-primary',
  /** A control whose state is engaged (e.g. a filter is applied). */
  active: 'border-accent/60 text-accent hover:bg-hover',
} as const

export const SIDEBAR_ICON_BUTTON_CLASS = `${SIDEBAR_ICON_BUTTON_BASE} ${SIDEBAR_ICON_BUTTON_TONE.neutral}`

/**
 * Widens a control's touch target to 44x44 CSS px on coarse pointers without
 * growing the visible control: an invisible ::before box centered on it.
 * Percent insets resolve against the control itself, so this works for any
 * visible size (note the app's 13px root: h-7 is 22.75px, not 28px). The
 * control must be positioned (`relative` or absolute/fixed).
 */
export const TOUCH_TARGET_CLASS =
  "[@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:inset-[calc(50%-22px)] [@media(pointer:coarse)]:before:content-['']"
