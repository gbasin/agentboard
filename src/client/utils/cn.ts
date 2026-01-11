import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Utility for conditionally constructing className strings with Tailwind merge support.
 * Combines clsx for conditional classes with tailwind-merge for proper Tailwind class deduplication.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
