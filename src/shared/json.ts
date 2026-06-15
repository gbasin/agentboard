// Small structural type-guards shared by the log parsers (eventTaxonomy and the
// client transcript reader). Kept in one place so the two parsers agree on what
// counts as a plain object record vs. a string.

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
