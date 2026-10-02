/**
 * controlStyles - the one place icon sizes and shared button classes live,
 * so they cannot drift apart again. iconConventions.test.ts enforces that
 * icon sizes come from ICON_SIZE.
 *
 * Units: the app's root font-size is 13px, so Tailwind's rem utilities run
 * at 13/16 scale (h-7 is 22.75 CSS px, h-10 is 32.5). Icon sizes are set in
 * CSS px through width/height props; touch targets use explicit px.
 */

/** Icon sizes in CSS px. Desktop uses pill/default/primary; mobile adds key. */
export const ICON_SIZE = {
  /** Inside pills, chips and badges (and inline status marks in rows). */
  pill: 12,
  /** Default: menus, square icon buttons, inline with text. */
  default: 14,
  /** Primary actions (new session) and the mobile header's 44px buttons. */
  primary: 16,
  /** Mobile key strip keys (44px). */
  key: 18,
} as const

/**
 * Stroke for key strip icons: the library's 1.5 default reads lighter than
 * the medium-weight text keys (esc, tab, 123) beside them.
 */
export const KEY_ICON_STROKE = 2

/**
 * Corner marks composited onto a 12px PR state glyph (draft pencil, closed
 * cross). Part of one 12px glyph, not a standalone icon.
 */
export const PR_STATE_MARK_SIZE = 6

/** Minimum touch target on mobile, CSS px. */
export const TOUCH_TARGET_PX = 44

const ICON_BUTTON_BASE =
  'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40'

/** Color treatments for square icon buttons (desktop and mobile). */
export const BUTTON_TONE = {
  neutral: 'border-border text-secondary hover:bg-hover hover:text-primary',
  /**
   * A control whose state is engaged (e.g. a filter is applied): the same
   * accent tint as engaged keys on the mobile key strip (ctrl, Enter).
   */
  active: 'border-accent/40 bg-accent/20 text-accent hover:bg-accent/30',
  danger: 'border-danger/30 bg-danger/10 text-danger hover:bg-danger/20',
  primary: 'border-transparent bg-accent text-white hover:bg-accent/90',
} as const

export type ButtonTone = keyof typeof BUTTON_TONE

/**
 * Desktop square icon button: h-7 (nominally 28px), bordered, holding an
 * ICON_SIZE.default icon (primary for the accent "+"). Used in the sidebar
 * filter bar and the status rail, both 40px (h-10) bars.
 */
export function iconButtonClass(tone: ButtonTone = 'neutral'): string {
  return `${ICON_BUTTON_BASE} ${BUTTON_TONE[tone]}`
}

/** The neutral desktop icon button (settings gear, connection dot). */
export const ICON_BUTTON_CLASS = iconButtonClass('neutral')

/**
 * Mobile header button: a 44px square (the touch target is the visible
 * control here; the 52px header has room for it), holding an
 * ICON_SIZE.primary icon. Neutral buttons sit on the surface color.
 */
export function mobileButtonClass(tone: ButtonTone = 'neutral', display = 'flex'): string {
  const fill = tone === 'neutral' ? 'bg-surface ' : ''
  return `${display} size-[44px] shrink-0 items-center justify-center rounded-md border transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${fill}${BUTTON_TONE[tone]}`
}

/**
 * Dense in-row control (inside session rows and rail pills): h-5, no
 * border, holding an ICON_SIZE.pill icon. Callers add positioning.
 */
export const ROW_ICON_BUTTON_CLASS =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:text-primary'

/**
 * Full-width tappable rows in the mobile drawer (session rows, section
 * toggles): at least 44px tall below md, content centered. No effect on
 * the desktop sidebar.
 */
export const MOBILE_ROW_TARGET_CLASS =
  'max-md:flex max-md:min-h-[44px] max-md:flex-col max-md:justify-center'

/**
 * Widens a control's touch target to 44x44 CSS px on coarse pointers without
 * growing the visible control: an invisible ::before box centered on it.
 * Percent insets resolve against the control itself, so this works at any
 * visible size. The control must be positioned (relative/absolute/fixed).
 */
export const TOUCH_TARGET_CLASS =
  "[@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:inset-[calc(50%-22px)] [@media(pointer:coarse)]:before:content-['']"
