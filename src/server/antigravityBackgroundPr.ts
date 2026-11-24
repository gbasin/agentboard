// Background run_command records separate the executed command from its output.
// The completion identifies the originating task in both its sender and message.
const kickoff = /^Created At: [^\n]+\nTool is running as a background task with task id: ([\w-]+\/task-(\d+))\r?\nTask Description: ([\s\S]*?)\r?\nTask logs are available at: /
const completion = /\n<SYSTEM_MESSAGE>\r?\n\[Message\] timestamp=\S+ sender=([\w-]+\/task-\d+) priority=\S+ content=Task id "\1" finished with result:\r?\nCommand exited with code (\d+)\.\r?\n\s*Command output:\r?\n/
const created = /^Creating (?:draft )?pull request for [^\r\n]+ in ([\w.-]+\/[\w.-]+)\r?\n(?:\s*Working\.\.\.\r?\n)*\s*(https:\/\/github\.com\/\1\/pull\/\d+)[ \t]*\r?$/gm
const standalone = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/

export function backgroundCreateTask(step: Record<string, unknown>, invokesCreate: (command: string) => boolean): string | undefined {
  if (step.type !== 'GENERIC' || step.source !== 'MODEL' || step.status !== 'RUNNING' || typeof step.content !== 'string') return
  const match = kickoff.exec(step.content)
  if (match && Number(match[2]) === step.step_index && invokesCreate(match[3])) return match[1]
}

export function backgroundCreateUrls(step: Record<string, unknown>, pending: Set<string>): string[] {
  if (step.type !== 'SYSTEM_MESSAGE' || step.source !== 'SYSTEM' || step.status !== 'DONE' || typeof step.content !== 'string') return []
  const match = completion.exec(step.content)
  if (!match || !pending.delete(match[1])) return []
  const output = step.content.slice(match.index + match[0].length).split(/\r?\n(?:Log: file:|<\/SYSTEM_MESSAGE>)/, 1)[0]
  const urls = Array.from(output.matchAll(created), result => result[2])
  // A later command can fail after gh has printed its creation receipt.
  if (urls.length || match[2] !== '0') return urls
  const url = standalone.exec(output.trim())
  return url ? [url[0].trim()] : []
}
