// Synthetic Codex app-server transcripts (codex-chat-sessions §5): the
// shared Script builder the unit harness (codexDriverHarness) and the e2e
// spec (chat-codex) both write for tests/fixtures/fake-codex-app-server.ts
// to replay — client requests must arrive in the scripted order, responses
// wait for their request, server requests wait for the reply. No real Codex
// is involved. Kept free of server imports so the Playwright process can
// import it.
import fs from 'node:fs'
import path from 'node:path'

export const THREAD_ID = 'thread-0001'
// The observed nested layout (spike, 0.163.0): sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl.
export const ROLLOUT = '/codex-home/sessions/2026/10/18/rollout-2026-10-18T17-46-05-thread-0001.jsonl'

export type Line = { dir: 'out' | 'in'; line: string } | { fake: 'append'; file: string; line?: string } | { fake: 'gate'; path: string } | { fake: 'assertInput'; input: unknown[] }

/** A transcript under construction; request ids follow the client's (1, 2, …). */
export class Script {
  readonly lines: Line[] = []
  private nextId = 1

  /** A client request and its recorded response. */
  request(method: string, result: unknown = {}): this {
    const id = this.nextId++
    this.lines.push({ dir: 'out', line: JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) })
    this.lines.push({ dir: 'in', line: JSON.stringify({ id, result }) })
    return this
  }

  notify(method: string, params: Record<string, unknown>): this {
    this.lines.push({ dir: 'in', line: JSON.stringify({ method, params }) })
    return this
  }

  /** A server request; the replay waits for the client's reply to `id`. */
  serverRequest(id: number, method: string, params: Record<string, unknown>): this {
    this.lines.push({ dir: 'in', line: JSON.stringify({ method, id, params }) })
    return this
  }

  /** initialize + thread/start (or resume) answered with THREAD_ID at `rollout`. */
  boot(method: 'thread/start' | 'thread/resume' = 'thread/start', model = 'gpt-test', rollout = ROLLOUT): this {
    return this.request('initialize', { userAgent: 'fake' })
      .request(method, { thread: { id: THREAD_ID, path: rollout }, model })
  }

  /** turn/start answered, then turn/started for `codexTurn`. */
  turn(codexTurn: string): this {
    return this.request('turn/start', { turn: { id: codexTurn, status: 'inProgress', items: [], error: null } })
      .notify('turn/started', { threadId: THREAD_ID, turn: { id: codexTurn, status: 'inProgress', items: [], error: null } })
  }

  item(phase: 'started' | 'completed', codexTurn: string, item: Record<string, unknown>): this {
    return this.notify(`item/${phase}`, { item, threadId: THREAD_ID, turnId: codexTurn })
  }

  completed(codexTurn: string, status = 'completed', items: unknown[] = [], error: unknown = null): this {
    return this.notify('turn/completed', { threadId: THREAD_ID, turn: { id: codexTurn, status, items, error } })
  }

  /**
   * The fake writes `line` to `file` here — the rollout writer's stand-in,
   * never evidence of Codex's timing; without `line`, the rollout user row
   * of the latest turn/start input.
   */
  append(file: string, line?: string): this {
    this.lines.push({ fake: 'append', file, ...(line !== undefined ? { line } : {}) })
    return this
  }

  /** The fake holds the run here until `gatePath` exists. */
  gate(gatePath: string): this {
    this.lines.push({ fake: 'gate', path: gatePath })
    return this
  }

  /** Assert the native input of the preceding turn, before replying to it. */
  assertInput(input: unknown[]): this {
    this.lines.push({ fake: 'assertInput', input })
    return this
  }

  write(dir: string): string {
    const file = path.join(dir, `transcript-${Math.random().toString(36).slice(2)}.jsonl`)
    fs.writeFileSync(file, this.lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    return file
  }
}
