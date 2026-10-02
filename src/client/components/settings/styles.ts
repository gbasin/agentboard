/**
 * Shared classes for settings controls. The app's root font-size is 13px,
 * so sizes here are explicit px: controls are 32px tall on desktop and 44px
 * (the touch target) below the md breakpoint, and text inputs use 16px on
 * phones because iOS zooms into anything smaller on focus.
 */

/** Height of every settings control: 32px desktop, 44px phone. */
export const CONTROL_HEIGHT = 'h-[32px] max-md:h-[44px]'

/** Square icon/text button sized like the other controls. */
export const CONTROL_BUTTON =
  `${CONTROL_HEIGHT} inline-flex shrink-0 items-center justify-center border border-border bg-surface px-3 text-[12px] text-secondary transition-colors hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50`

/** Square button holding only an icon. */
export const CONTROL_ICON_BUTTON =
  `${CONTROL_BUTTON} w-[32px] max-md:w-[44px] px-0`

/** Text, number and select inputs. Overrides `.input`'s 16px on desktop. */
export const CONTROL_INPUT =
  `input ${CONTROL_HEIGHT} px-2 py-0 text-[13px] max-md:text-[16px] focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 aria-[invalid=true]:border-danger`

/** Muted 12px helper/error text under a control. */
export const HELP_TEXT = 'text-[12px] leading-snug text-muted'

export const ERROR_TEXT = 'text-[12px] leading-snug text-danger'
