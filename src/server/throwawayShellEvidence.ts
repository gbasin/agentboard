// Pure process-evidence checks shared by the background terminal cleanup.
export interface ProcessInfo {
  pid: number
  ppid: number
  ageSec: number
  stat: string
  tty: string
  comm: string
}

const NO_TTY = new Set(['', '?', '??', '-'])
export const PS_FORMAT = 'pid=,ppid=,etime=,stat=,tty=,comm='

export function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1
}

/** `[[dd-]hh:]mm:ss` → seconds; NaN when malformed. */
export function parseEtime(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value)
  if (!match) return Number.NaN
  const [, days, hours, minutes, seconds] = match
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds)
  )
}

export function parsePidList(output: string): number[] {
  const pids: number[] = []
  for (const line of output.split('\n')) {
    const pid = Number(line.trim())
    if (line.trim() !== '' && isValidPid(pid)) pids.push(pid)
  }
  return pids
}

export function parseProcessInfo(output: string): ProcessInfo[] {
  const rows: ProcessInfo[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!match) continue
    const ageSec = parseEtime(match[3] ?? '')
    if (Number.isNaN(ageSec)) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      ageSec,
      stat: match[4] ?? '',
      tty: match[5] ?? '',
      comm: (match[6] ?? '').trim(),
    })
  }
  return rows
}

/** `#{pid} #{pane_pid}` lines → server pids seen and pane pids. */
export function parsePaneList(output: string): { serverPids: Set<number>; panePids: Set<number> } {
  const serverPids = new Set<number>()
  const panePids = new Set<number>()
  for (const line of output.split('\n')) {
    const [server, pane] = line.trim().split(' ')
    if (!server || !pane) continue
    serverPids.add(Number(server))
    panePids.add(Number(pane))
  }
  return { serverPids, panePids }
}

/** `lsof -F pf` output → numeric fds per pid (cwd, txt, … are dropped). */
export function parseLsofFds(output: string): Map<number, Set<number>> {
  const fds = new Map<number, Set<number>>()
  let current: Set<number> | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      current = new Set()
      fds.set(Number(line.slice(1)), current)
    } else if (line.startsWith('f') && current) {
      const fd = line.slice(1)
      if (/^\d+$/.test(fd)) current.add(Number(fd))
    }
  }
  return fds
}

/** The checks one `ps` row can answer: child, live, tty, login argv0, age. */
export function rowLooksStuck(row: ProcessInfo, serverPid: number | null, minAgeMs: number): boolean {
  return (
    row.ppid === serverPid &&
    !row.stat.startsWith('Z') &&
    !NO_TTY.has(row.tty) &&
    row.comm.length > 1 &&
    row.comm.startsWith('-') &&
    row.ageSec * 1000 >= minAgeMs
  )
}

export function hasOnlyStdioOpen(fds: ReadonlySet<number> | undefined): boolean {
  return fds !== undefined && fds.size === 3 && fds.has(0) && fds.has(1) && fds.has(2)
}

export interface StuckShellEvidence {
  rows: readonly ProcessInfo[]
  serverPid: number | null
  panePids: ReadonlySet<number>
  parentsWithChildren: ReadonlySet<number>
  fdsByPid: ReadonlyMap<number, ReadonlySet<number>>
  minAgeMs: number
  markedOrphans?: ReadonlySet<number>
}

/** The full candidate test. Missing evidence for a pid never matches. */
export function findStuckShells(evidence: StuckShellEvidence): number[] {
  return evidence.rows
    .filter(
      (row) =>
        (rowLooksStuck(row, evidence.serverPid, evidence.minAgeMs) ||
          (evidence.markedOrphans?.has(row.pid) && rowLooksStuck(row, 1, evidence.minAgeMs))) &&
        !evidence.panePids.has(row.pid) &&
        !evidence.parentsWithChildren.has(row.pid) &&
        hasOnlyStdioOpen(evidence.fdsByPid.get(row.pid))
    )
    .map((row) => row.pid)
}

export function pidArgs(flag: string, pids: readonly number[]): string[] {
  return pids.filter(isValidPid).flatMap((pid) => [flag, String(pid)])
}

/** Cwd provenance is visible on macOS even when SIP hides process environments. */
export function parseLsofCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid = 0
  let fd = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); fd = '' }
    else if (line.startsWith('f')) fd = line.slice(1)
    else if (line.startsWith('n') && fd === 'cwd' && isValidPid(pid)) cwds.set(pid, line.slice(1))
  }
  return cwds
}
