// Byte-level prefilter for the PR extractor. Decides from raw log bytes,
// without decoding them, whether a span may hold `gh pr create`, a
// GitHub connector create call, REST pulls endpoint, or a `pr-link` record. Every check over-matches and never under-matches: a
// false positive only costs a decode, a false negative loses a PR.

export const CREATE_BYTES = Buffer.from('create')
const REST_BYTES = Buffer.from('pulls')
const CONNECTOR_CREATE_BYTES = Buffer.from('github_create_pull_request')
const CONNECTOR_COMPLETION_BYTES = Buffer.from('github.create_pull_request')
// Claude Code's `{"type":"pr-link",...}` session↔PR records. The bare word
// over-matches ("pr-links", prose) — fine, that only costs a decode.
export const PR_LINK_BYTES = Buffer.from('pr-link')
// Bytes the regexes accept between `pr` and `create`: whitespace, quotes,
// comma, backslash. Bytes >= 0x80 are treated as separators too (Unicode
// whitespace) so the prefilter can only over-match.
function isSeparatorByte(b: number): boolean {
  return (
    b <= 0x20 || b === 0x22 || b === 0x27 || b === 0x2c || b === 0x5c || b >= 0x80
  )
}

// True when the bytes hold a `pr<seps>create` candidate, or a `create` whose
// context may start before the buffer. Over-matches, never under-matches.
export function hasCreateCandidate(bytes: Buffer): boolean {
  if (bytes.includes(REST_BYTES)) return true
  if (bytes.includes(CONNECTOR_CREATE_BYTES) || bytes.includes(CONNECTOR_COMPLETION_BYTES)) return true
  let at = bytes.indexOf(CREATE_BYTES)
  while (at !== -1) {
    if (at === 0) return true
    let j = at - 1
    while (j >= 0 && isSeparatorByte(bytes[j])) j--
    if (j < at - 1) {
      // At least one separator precedes `create`, as `gh pr create` needs.
      if (j < 1) return true
      if (bytes[j] === 0x72 && bytes[j - 1] === 0x70) return true
    }
    at = bytes.indexOf(CREATE_BYTES, at + 1)
  }
  return false
}

// REST endpoint marker; deliberately over-matches reads and prose.
export function hasRestCandidate(bytes: Buffer): boolean { return bytes.includes(REST_BYTES) }

// True when `bytes` holds a `pr-link` candidate.
export function hasPrLinkCandidate(bytes: Buffer): boolean {
  return bytes.includes(PR_LINK_BYTES)
}

// True when `word` spans the seam between the partial line and `bytes`.
// word.length - 1 bytes per side cover every split. The partial side may
// span several short pieces (small appends across polls).
function seamHasWord(partial: Buffer[], bytes: Buffer, word: Buffer): boolean {
  if (partial.length === 0) return false
  const tail = word.length - 1
  const sides: Buffer[] = [bytes.subarray(0, tail)]
  let need = tail
  for (let i = partial.length - 1; i >= 0 && need > 0; i--) {
    const piece = partial[i]
    const take = Math.min(need, piece.length)
    sides.unshift(piece.subarray(piece.length - take))
    need -= take
  }
  return Buffer.concat(sides).includes(word)
}

export function seamHasCreate(partial: Buffer[], bytes: Buffer): boolean {
  return seamHasWord(partial, bytes, REST_BYTES) || seamHasWord(partial, bytes, CREATE_BYTES) ||
    seamHasWord(partial, bytes, CONNECTOR_CREATE_BYTES) ||
    seamHasWord(partial, bytes, CONNECTOR_COMPLETION_BYTES)
}

export function seamHasPrLink(partial: Buffer[], bytes: Buffer): boolean {
  return seamHasWord(partial, bytes, PR_LINK_BYTES)
}
