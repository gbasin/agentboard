import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { cn } from '../utils/cn'

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

/**
 * Accessible switch component built on Base UI primitives.
 * Provides keyboard navigation, focus management, and proper ARIA attributes.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
}: SwitchProps) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'group relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors',
        'bg-border data-[checked]:bg-accent',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform',
          'translate-x-1 group-data-[checked]:translate-x-5'
        )}
      />
    </BaseSwitch.Root>
  )
}
