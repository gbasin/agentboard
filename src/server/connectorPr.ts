// Connector PR association: recognize actual create calls, then consume only
// successful, correlated MCP structured results. Never mine result prose.

const CREATE_TOOL = /^(?:mcp__\w+__)?github_create_pull_request$/

type ObjectRecord = Record<string, unknown>
function object(value: unknown): ObjectRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectRecord
    : undefined
}

// Unified exec is JavaScript, not shell text. Keep string literals, comments,
// and regex literals opaque so source/documentation mentions cannot register
// a call. Templates with interpolation are conservatively unsupported. A token barrier prevents matching across any ignored literal.
function jsTokens(source: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (/\s/.test(c)) { i++; continue }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2)
      i = end < 0 ? source.length : end + 1
      continue
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (c === '`' && source.startsWith('${', i)) return []
        if (source[i++] === c) break
      }
      tokens.push('<literal>')
      continue
    }
    // Treat ambiguous slashes as regex literals too. Division expressions
    // are unsupported rather than risking a source-pattern false positive.
    if (c === '/') {
      i++
      let inClass = false
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === '[') inClass = true
        if (source[i] === ']') inClass = false
        if (source[i++] === '/' && !inClass) break
      }
      while (i < source.length && /[a-z]/i.test(source[i])) i++
      tokens.push('<literal>')
      continue
    }
    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))
    if (identifier) {
      tokens.push(identifier[0])
      i += identifier[0].length
    } else {
      tokens.push(c)
      i++
    }
  }
  return tokens
}

// Supported exec shape: straight-line, awaited calls to tools.<name>(...).
// Mixed tools, control flow, declarations with callbacks, template
// interpolation, and calls inside blocks are intentionally unsupported:
// static recognition cannot establish which operation produced the output.
function execCreatesPr(input: unknown): boolean {
  if (typeof input !== 'string') return false
  const tokens = jsTokens(input)
  // Declarations and control flow may merely store an example for later,
  // or skip it altogether. Limit association to straight-line exec scripts.
  if (tokens.some((token) => ['function', 'if', 'for', 'while', 'switch', 'class', '?', '&', '|'].includes(token)) ||
    tokens.some((token, i) => token === '=' && tokens[i + 1] === '>')) return false
  let creates = false
  let braces = 0
  for (let i = 0; i + 3 < tokens.length; i++) {
    if (tokens[i] === '{') braces++
    if (tokens[i] === '}') braces--
    if (tokens[i] !== 'tools' || tokens[i + 1] !== '.' || tokens[i + 3] !== '(') continue
    // A larger property chain (docs.tools.foo) is not the injected tools API.
    if (tokens[i - 1] === '.') continue
    // A wrapper result cannot distinguish outputs from different tool calls.
    // Do not associate search/read output from a mixed-operation script.
    if (!CREATE_TOOL.test(tokens[i + 2]) || tokens[i - 1] !== 'await' || braces !== 0) return false
    creates = true
  }
  return creates
}

export function connectorCreateIds(entry: ObjectRecord): string[] {
  const ids: string[] = []
  function call(value: unknown): void {
    const item = object(value)
    if (!item) return
    const id = item.call_id ?? item.id
    if (typeof id !== 'string' || !id) return
    if (typeof item.name !== 'string') return
    if (CREATE_TOOL.test(item.name) ||
      (item.type === 'custom_tool_call' && item.name === 'exec' && execCreatesPr(item.input))) {
      ids.push(id)
    }
  }
  const payload = object(entry.payload) ?? entry
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') call(payload)
  const message = object(entry.message)
  for (const item of Array.isArray(message?.content) ? message.content : []) {
    if (item?.type === 'tool_use') call(item)
  }
  return ids
}

export interface ConnectorResult { id: string; urls: string[] }
export function connectorResults(entry: ObjectRecord): ConnectorResult[] {
  const results: ConnectorResult[] = []
  function result(id: unknown, output: unknown, failed = false): void {
    if (typeof id !== 'string' || !id) return
    const urls: string[] = []
    function visit(value: unknown, depth = 0): void {
      if (failed || depth > 6) return
      if (typeof value === 'string') {
        try { visit(JSON.parse(value), depth + 1) } catch { /* Prose is not structured output. */ }
        return
      }
      if (Array.isArray(value)) {
        for (const part of value) {
          const item = object(part)
          if (item?.type === 'input_text' || item?.type === 'text') visit(item.text, depth + 1)
        }
        return
      }
      const item = object(value)
      if (!item || item.isError === true || item.error) return
      const pr = object(item.structuredContent)
      if (!pr || pr.error || pr.isError === true || typeof pr.url !== 'string') return
      const match = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)$/.exec(pr.url)
      if (match && Number(match[1]) === pr.number && Number.isSafeInteger(pr.number) && Number(pr.number) > 0) urls.push(pr.url)
    }
    visit(output)
    results.push({ id, urls })
  }
  const payload = object(entry.payload) ?? entry
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    result(payload.call_id, payload.output, payload.is_error === true || payload.isError === true)
  }
  const message = object(entry.message)
  for (const item of Array.isArray(message?.content) ? message.content : []) {
    if (item?.type === 'tool_result') result(item.tool_use_id, item.content, item.is_error === true)
  }
  return results
}
