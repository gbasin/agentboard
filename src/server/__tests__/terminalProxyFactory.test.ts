import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import type { TerminalProxyOptions } from '../terminal/types'

const configMock = {
  port: 4040,
  hostname: '0.0.0.0',
  tmuxSession: 'agentboard',
  refreshIntervalMs: 2000,
  discoverPrefixes: [] as string[],
  pruneWsSessions: true,
  terminalMode: 'auto' as 'auto' | 'pty' | 'pipe-pane',
  terminalMonitorTargets: true,
  allowKillExternal: false,
  tlsCert: '',
  tlsKey: '',
  logPollIntervalMs: 5000,
  logPollMax: 25,
  rgThreads: 1,
  logMatchWorker: false,
  logMatchProfile: false,
  claudeConfigDir: '/tmp/claude',
  codexHomeDir: '/tmp/codex',
  claudeResumeCmd: 'claude --resume {sessionId}',
  codexResumeCmd: 'codex resume {sessionId}',
  enterRefreshDelayMs: 50,
}

const HOSTNAME_REGEX = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])(\.([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]))*$/

function isValidHostname(hostname: string): boolean {
  return hostname.length > 0 && hostname.length <= 253 && HOSTNAME_REGEX.test(hostname)
}

const originalIsTTY = process.stdin.isTTY

let importCounter = 0

function setupModuleMocks(): void {
  mock.module('../config', () => ({
    config: configMock,
    isValidHostname,
  }))
}

async function loadFactory() {
  importCounter += 1
  return import(`../terminal/TerminalProxyFactory?terminal-proxy-factory=${importCounter}`)
}

beforeEach(() => {
  setupModuleMocks()
})

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalIsTTY,
    configurable: true,
  })
  mock.restore()
})

describe('TerminalProxyFactory', () => {
  test('resolveTerminalMode respects config overrides', async () => {
    const { resolveTerminalMode } = await loadFactory()

    configMock.terminalMode = 'pipe-pane'
    expect(resolveTerminalMode()).toBe('pipe-pane')

    configMock.terminalMode = 'pty'
    expect(resolveTerminalMode()).toBe('pty')
  })

  test('resolveTerminalMode falls back to stdin tty', async () => {
    const { resolveTerminalMode } = await loadFactory()

    configMock.terminalMode = 'auto'
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    })
    expect(resolveTerminalMode()).toBe('pty')

    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    })
    expect(resolveTerminalMode()).toBe('pipe-pane')
  })

  test('createTerminalProxy instantiates correct proxy', async () => {
    const { createTerminalProxy } = await loadFactory()

    const options: TerminalProxyOptions = {
      connectionId: 'conn-1',
      sessionName: 'agentboard-ws-conn-1',
      baseSession: 'agentboard',
      onData: () => {},
    }

    configMock.terminalMode = 'pty'
    expect(createTerminalProxy(options).getMode()).toBe('pty')

    configMock.terminalMode = 'pipe-pane'
    expect(createTerminalProxy(options).getMode()).toBe('pipe-pane')
  })
})
