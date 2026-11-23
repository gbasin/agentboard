// REST PR creation in completed Codex commands. Completion records pair the
// actual command with its output even when exec yielded and write_stdin polled.
// This deliberately supports literal endpoints only; it never mines prose.
type RecordValue = Record<string, unknown>
type Matcher = (command: string, gh: (args: string[]) => boolean) => boolean

function restRepo(args: string[]): string | null {
  if (args[0] !== 'api') return null
  let endpoint: string | undefined
  let method: string | undefined
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--method' || arg === '-X') method = args[++i]
    else if (arg.startsWith('--method=')) method = arg.slice(9)
    else if (/^-X.+/.test(arg)) method = arg.slice(2)
    else if (/^\/?repos\//.test(arg)) endpoint = arg
    else if (['--input', '--jq', '-q', '--header', '-H', '--field', '-F', '--raw-field', '-f'].includes(arg)) i++
  }
  if (method !== 'POST') return null
  return /^\/?repos\/([\w.-]+\/[\w.-]+)\/pulls$/.exec(endpoint ?? '')?.[1] ?? null
}

interface Token { text: string; literal: boolean; depth: number }
// Python strings/comments are opaque, so examples and printed source cannot
// masquerade as subprocess calls. No Python is executed to inspect a log.
function pythonTokens(source: string): Token[] {
  const tokens: Token[] = []
  let depth = 0
  const re = /#[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[A-Za-z_]\w*|[^\s]/g
  for (const match of source.matchAll(re)) {
    const text = match[0]
    if (text.startsWith('#')) continue
    const literal = text.startsWith("'") || text.startsWith('"')
    if (!literal && [')', ']', '}'].includes(text)) depth--
    tokens.push({ text: literal ? text.slice(1, -1) : text, literal, depth })
    if (!literal && ['(', '[', '{'].includes(text)) depth++
  }
  return tokens
}

function pythonRepos(command: string): string[] {
  // Only an executed Python heredoc is supported, not Python source supplied
  // to cat/echo or embedded in another command's quoted argument.
  const match = /^[ \t]*(?:[\w./-]*\/)?python3?[ \t]+-[ \t]*<<[ \t]*(['"]?)(\w+)\1[ \t]*\n([\s\S]*?)\n\2(?:\n[ \t\n]*)?$/.exec(command)
  if (!match || match[3].split('\n').includes(match[2])) return []
  const tokens = pythonTokens(match[3])
  // Comprehensions in unrelated expressions do not guard a top-level call.
  // Keep rejecting control flow outside brackets and only accept calls at
  // depth zero: a subprocess inside a comprehension/generator may never run.
  if (tokens.some(t => !t.literal && t.depth === 0 && ['def', 'class', 'if', 'for', 'while', 'lambda', 'and', 'or', 'try', 'except'].includes(t.text))) return []
  const repos: string[] = []
  for (let i = 0; i + 6 < tokens.length; i++) {
    if (tokens[i].depth !== 0) continue
    const head = tokens.slice(i, i + 5)
    if (head.some(t => t.literal) || head[0].text !== 'subprocess' || head[1].text !== '.' ||
      !['run', 'check_output', 'check_call'].includes(head[2].text) || head[3].text !== '(' || head[4].text !== '[') continue
    const argv: string[] = []
    let j = i + 5
    // Require the executable, API endpoint and explicit method to be literal.
    // Later --input values may be expressions such as str(path).
    while (tokens[j]?.literal) {
      argv.push(tokens[j++].text)
      if (tokens[j]?.text !== ',') break
      j++
    }
    if (argv[0] !== 'gh') continue
    const repo = restRepo(argv.slice(1))
    if (repo) repos.push(repo)
  }
  return repos
}

function chainedPythonRepos(script: string): string[] {
  if (!script.includes('&&')) return []
  // A final heredoc after successful Git setup commands is also in command
  // position. Accept only literal Git segments joined by &&, so a skipped
  // branch, quoted Python example or heredoc for another command cannot match.
  const word = String.raw`(?:[^\s'"\x60#$\\;&|(){}<>]|'[^'\n]*'|"[^"\n\x60$\\]*")+`
  const segment = new RegExp(
    String.raw`[ \t]*(?:PATH=${word}(?::\$PATH)?[ \t]+)?git(?:[ \t]+${word}|[ \t]+>[ \t]*${word}|[ \t]+2>&1)*[ \t]*&&`,
    'y',
  )
  let end = 0
  while (segment.test(script)) end = segment.lastIndex
  return end ? pythonRepos(script.slice(end)) : []
}

export function restPrCompletionUrls(entry: RecordValue, invokes: Matcher): string[] {
  if (entry.type !== 'event_msg') return []
  const payload = entry.payload as RecordValue | undefined
  if (payload?.type !== 'item_completed') return []
  const item = payload.item as RecordValue | undefined
  if (item?.type !== 'CommandExecution' || item.status !== 'completed' || item.exit_code !== 0) return []
  const argv = item.command
  const command = typeof argv === 'string' ? argv : Array.isArray(argv) ? argv.map(String).join(' ') : ''
  const repos = new Set<string>()
  invokes(command, args => {
    const repo = restRepo(args)
    if (repo) repos.add(repo)
    // Keep scanning all segments; a command can create multiple PRs.
    return false
  })
  const script = Array.isArray(argv) && ['-lc', '-c'].includes(String(argv[1])) ? String(argv[2]) : command
  for (const repo of pythonRepos(script)) repos.add(repo)
  const chainedRepos = new Set(chainedPythonRepos(script))
  const urls = new Set<string>()
  const chainedUrls = new Set<string>()
  for (const key of ['stdout', 'aggregated_output', 'formatted_output']) {
    const output = item[key]
    if (typeof output !== 'string') continue
    for (const match of output.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) {
      if (repos.has(match[1])) urls.add(match[0])
      if (chainedRepos.has(match[1])) chainedUrls.add(match[0])
    }
  }
  // Earlier Git commands share the completion's output. Require one distinct
  // matching URL and a final output line containing only that URL.
  if (chainedUrls.size === 1) {
    const fullOutput = [item.aggregated_output, item.stdout, item.formatted_output]
      .find(output => typeof output === 'string')
    if (fullOutput === undefined) return [...urls]
    const trimmed = fullOutput.trimEnd()
    const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1).trimStart()
    if (chainedUrls.has(lastLine)) urls.add(lastLine)
  }
  return [...urls]
}
