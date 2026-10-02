/**
 * CommitInput - a settings text input that commits on blur or Enter via
 * useCommitField. Errors render inline under the input and are wired into
 * aria-describedby/aria-invalid; the invalid draft stays local.
 */
import type { InputHTMLAttributes } from 'react'
import { cn } from '../../../utils/cn'
import { CONTROL_INPUT, ERROR_TEXT } from '../styles'
import { useCommitField, type CommitFn } from '../useCommitField'

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onBlur' | 'onKeyDown' | 'defaultValue'
>

interface CommitInputProps extends NativeInputProps {
  value: string
  onCommit: CommitFn
  describedBy?: string
  /** Classes for the wrapper (width etc.). */
  wrapperClassName?: string
}

export function CommitInput({
  value,
  onCommit,
  describedBy,
  id,
  className,
  wrapperClassName,
  ...rest
}: CommitInputProps) {
  const field = useCommitField(value, onCommit)
  const errorId = id ? `${id}-error` : undefined
  const describedByIds = [describedBy, field.error ? errorId : undefined]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cn('min-w-0', wrapperClassName)}>
      <input
        {...rest}
        id={id}
        value={field.value}
        onChange={field.onChange}
        onBlur={field.onBlur}
        onKeyDown={field.onKeyDown}
        aria-invalid={field.error ? true : undefined}
        aria-describedby={describedByIds || undefined}
        className={cn(CONTROL_INPUT, className)}
      />
      {field.error && (
        <p id={errorId} className={cn(ERROR_TEXT, 'mt-1')} role="alert">
          {field.error}
        </p>
      )}
    </div>
  )
}

/** Parse an integer draft and clamp it into [min, max]; null if not a number. */
export function parseClampedInt(draft: string, min: number, max: number): number | null {
  const trimmed = draft.trim()
  if (!/^-?\d+$/.test(trimmed)) return null
  return Math.min(max, Math.max(min, Number.parseInt(trimmed, 10)))
}
