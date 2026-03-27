export const COMMIT_MESSAGE_TYPES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
] as const

export type CommitMessageType = (typeof COMMIT_MESSAGE_TYPES)[number]

export type CommitMessageValidationErrorCode =
  | 'empty_message'
  | 'invalid_header'
  | 'unsupported_type'
  | 'invalid_scope'
  | 'missing_subject'

export interface CommitMessageValidationError {
  code: CommitMessageValidationErrorCode
  header: string
  message: string
}

export interface ParsedCommitMessage {
  rawHeader: string
  normalizedHeader: string
  remainder: string
  type: CommitMessageType
  scope: string | null
  isBreakingChange: boolean
  subject: string
}

export const GENERATED_COMMIT_MESSAGE_KINDS = [
  'merge',
  'revert',
  'fixup',
  'squash',
  'amend',
] as const

export type GeneratedCommitMessageKind =
  (typeof GENERATED_COMMIT_MESSAGE_KINDS)[number]

export interface GeneratedCommitMessage {
  rawHeader: string
  remainder: string
  kind: GeneratedCommitMessageKind
}

export type ParseCommitMessageResult =
  | {
      ok: true
      parsed: ParsedCommitMessage
    }
  | {
      ok: false
      error: CommitMessageValidationError
    }

export type NormalizeCommitMessageResult =
  | {
      ok: true
      mode: 'normalized'
      normalizedMessage: string
      changed: boolean
      parsed: ParsedCommitMessage
    }
  | {
      ok: true
      mode: 'passthrough'
      normalizedMessage: string
      changed: false
      generated: GeneratedCommitMessage
    }
  | {
      ok: false
      error: CommitMessageValidationError
    }

const COMMIT_MESSAGE_TYPE_SET = new Set<string>(COMMIT_MESSAGE_TYPES)
const HEADER_PATTERN =
  /^\s*([A-Za-z]+)\s*(?:\(\s*([^)]+?)\s*\))?\s*(!)?\s*:\s*(.*?)\s*$/
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/
const GENERATED_HEADER_PATTERNS: Array<{
  kind: GeneratedCommitMessageKind
  pattern: RegExp
}> = [
  {
    kind: 'merge',
    pattern:
      /^\s*Merge (?:branch|branches|remote-tracking branch|pull request|tag|commit)\b/,
  },
  {
    kind: 'revert',
    pattern: /^\s*Revert\s+"/,
  },
  {
    kind: 'fixup',
    pattern: /^\s*fixup!\s+\S/,
  },
  {
    kind: 'squash',
    pattern: /^\s*squash!\s+\S/,
  },
  {
    kind: 'amend',
    pattern: /^\s*amend!\s+\S/,
  },
]

function createError(
  code: CommitMessageValidationErrorCode,
  header: string,
  message: string
): ParseCommitMessageResult {
  return {
    ok: false,
    error: {
      code,
      header,
      message,
    },
  }
}

function splitCommitMessage(message: string): { header: string; remainder: string } {
  const newlineMatch = /\r?\n/.exec(message)

  if (!newlineMatch || newlineMatch.index === undefined) {
    return {
      header: message,
      remainder: '',
    }
  }

  const newlineIndex = newlineMatch.index
  return {
    header: message.slice(0, newlineIndex),
    remainder: message.slice(newlineIndex),
  }
}

function parseGeneratedCommitMessage(
  header: string,
  remainder: string
): GeneratedCommitMessage | null {
  for (const candidate of GENERATED_HEADER_PATTERNS) {
    if (candidate.pattern.test(header)) {
      return {
        rawHeader: header,
        remainder,
        kind: candidate.kind,
      }
    }
  }

  return null
}

export function parseCommitMessage(message: string): ParseCommitMessageResult {
  const { header, remainder } = splitCommitMessage(message)
  const trimmedHeader = header.trim()

  if (trimmedHeader.length === 0) {
    return createError(
      'empty_message',
      header,
      'Commit subject is empty. Use type(scope): subject or type: subject.'
    )
  }

  const match = HEADER_PATTERN.exec(header)
  if (!match) {
    return createError(
      'invalid_header',
      header,
      'Commit subject must use Conventional Commit format: type(scope): subject or type: subject. Add ! before the colon only when the subject is already marked as breaking.'
    )
  }

  const [, rawType, rawScope, breakingMarker, rawSubject] = match
  const type = rawType.toLowerCase()
  if (!COMMIT_MESSAGE_TYPE_SET.has(type)) {
    return createError(
      'unsupported_type',
      header,
      `Unsupported commit type "${rawType}". Allowed types: ${COMMIT_MESSAGE_TYPES.join(', ')}.`
    )
  }

  const scope = rawScope?.trim().toLowerCase() ?? null
  if (scope && !SCOPE_PATTERN.test(scope)) {
    return createError(
      'invalid_scope',
      header,
      'Commit scope may only contain letters, numbers, ".", "/", "_" or "-" after normalization.'
    )
  }

  const subject = rawSubject.trim()
  if (subject.length === 0) {
    return createError(
      'missing_subject',
      header,
      'Commit subject text is required after the colon.'
    )
  }

  const normalizedHeader = `${type}${scope ? `(${scope})` : ''}${breakingMarker ? '!' : ''}: ${subject}`

  return {
    ok: true,
    parsed: {
      rawHeader: header,
      normalizedHeader,
      remainder,
      type: type as CommitMessageType,
      scope,
      isBreakingChange: Boolean(breakingMarker),
      subject,
    },
  }
}

export function normalizeCommitMessage(message: string): NormalizeCommitMessageResult {
  const { header, remainder } = splitCommitMessage(message)
  const generated = parseGeneratedCommitMessage(header, remainder)
  if (generated) {
    return {
      ok: true,
      mode: 'passthrough',
      normalizedMessage: message,
      changed: false,
      generated,
    }
  }

  const parsed = parseCommitMessage(message)
  if (!parsed.ok) {
    return parsed
  }

  const normalizedMessage =
    parsed.parsed.normalizedHeader + parsed.parsed.remainder

  return {
    ok: true,
    mode: 'normalized',
    normalizedMessage,
    changed: normalizedMessage !== message,
    parsed: parsed.parsed,
  }
}
