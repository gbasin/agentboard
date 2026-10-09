import { describe, expect, test } from 'bun:test'
import { SessionManager } from '../SessionManager'
import { isLeakedLaunchEnvVar, sanitizedTmuxEnv } from '../tmuxEnv'

describe('isLeakedLaunchEnvVar', () => {
  test('flags the launch-chain vars', () => {
    expect(isLeakedLaunchEnvVar('NODE_ENV')).toBe(true)
    expect(isLeakedLaunchEnvVar('AGENTBOARD_STATIC_DIR')).toBe(true)
    expect(isLeakedLaunchEnvVar('npm_config_cache')).toBe(true)
    expect(isLeakedLaunchEnvVar('npm_lifecycle_script')).toBe(true)
    expect(isLeakedLaunchEnvVar('npm_execpath')).toBe(true)
  })

  test('leaves ordinary env vars alone', () => {
    expect(isLeakedLaunchEnvVar('PATH')).toBe(false)
    expect(isLeakedLaunchEnvVar('HOME')).toBe(false)
    expect(isLeakedLaunchEnvVar('SSH_AUTH_SOCK')).toBe(false)
    expect(isLeakedLaunchEnvVar('TERM')).toBe(false)
    // Other AGENTBOARD_* config vars are deliberately not stripped.
    expect(isLeakedLaunchEnvVar('AGENTBOARD_DB_PATH')).toBe(false)
    expect(isLeakedLaunchEnvVar('NODE_OPTIONS')).toBe(false)
    expect(isLeakedLaunchEnvVar('NPM_TOKEN')).toBe(false)
  })
})

describe('sanitizedTmuxEnv', () => {
  test('strips leaked vars and keeps the rest', () => {
    const env = sanitizedTmuxEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NODE_ENV: 'production',
      AGENTBOARD_STATIC_DIR: '/npx/dist/client',
      npm_config_cache: '/Users/x/.npm',
      npm_execpath: '/opt/npm-cli.js',
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    })
  })

  test('drops undefined values', () => {
    expect(sanitizedTmuxEnv({ FOO: undefined, BAR: 'x' })).toEqual({ BAR: 'x' })
  })

  test('strips TMUX/TMUX_PANE when TMUX_TMPDIR marks the instance as isolated', () => {
    // tmux ignores TMUX_TMPDIR while $TMUX is set, so the pair is
    // contradictory — and the pair is exactly what Bun Workers and env-less
    // spawns see: they keep the process-start environ where the main
    // thread's `delete process.env.TMUX` never took effect.
    const env = sanitizedTmuxEnv({
      TMUX: '/private/tmp/tmux-501/default,1234,0',
      TMUX_PANE: '%42',
      TMUX_TMPDIR: '/tmp/ab-dev',
      PATH: '/usr/bin',
    })
    expect(env.TMUX).toBeUndefined()
    expect(env.TMUX_PANE).toBeUndefined()
    expect(env.TMUX_TMPDIR).toBe('/tmp/ab-dev')
    expect(env.PATH).toBe('/usr/bin')
  })

  test('keeps TMUX/TMUX_PANE when TMUX_TMPDIR is absent', () => {
    // The nested opt-in (AGENTBOARD_ALLOW_NESTED_TMUX) and "user's own tmux"
    // paths deliberately share the inherited server — nothing marks them for
    // isolation, so the inherited socket pointer must survive.
    const env = sanitizedTmuxEnv({
      TMUX: '/private/tmp/tmux-501/default,1234,0',
      TMUX_PANE: '%7',
      PATH: '/usr/bin',
    })
    expect(env.TMUX).toBe('/private/tmp/tmux-501/default,1234,0')
    expect(env.TMUX_PANE).toBe('%7')
  })

  test('strips a stray TMUX even when TMUX_TMPDIR alone is set', () => {
    expect(sanitizedTmuxEnv({ TMUX: 'x,1,0', TMUX_TMPDIR: '/tmp/y' }).TMUX).toBeUndefined()
  })

  test('defaults to process.env', () => {
    const env = sanitizedTmuxEnv()
    expect(env.NODE_ENV).toBeUndefined()
    expect(env.AGENTBOARD_STATIC_DIR).toBeUndefined()
    expect(Object.keys(env).some((k) => k.startsWith('npm_'))).toBe(false)
  })
})

describe('SessionManager.scrubLeakedGlobalEnvironment', () => {
  function managerWithGlobalEnv(
    lines: string[],
    calls: string[][]
  ): SessionManager {
    return new SessionManager('agentboard', {
      runTmux: (args: string[]) => {
        calls.push(args)
        if (args[0] === 'show-environment') {
          return lines.join('\n')
        }
        return ''
      },
    })
  }

  test('scrubs leaked vars when the agentboard fingerprint is present', () => {
    const calls: string[][] = []
    const manager = managerWithGlobalEnv(
      [
        'AGENTBOARD_STATIC_DIR=/npx/dist/client',
        'NODE_ENV=production',
        'npm_config_cache=/Users/x/.npm',
        'npm_execpath=/opt/npm-cli.js',
        'PATH=/usr/bin',
        'SSH_AUTH_SOCK=/tmp/agent.sock',
      ],
      calls
    )
    const scrubbed = manager.scrubLeakedGlobalEnvironment()
    expect(scrubbed.sort()).toEqual([
      'AGENTBOARD_STATIC_DIR',
      'NODE_ENV',
      'npm_config_cache',
      'npm_execpath',
    ])
    const unsets = calls.filter((args) => args[0] === 'set-environment')
    expect(unsets).toEqual(
      scrubbed.map((name) => ['set-environment', '-g', '-u', name])
    )
    // PATH and SSH_AUTH_SOCK must never be touched.
    expect(unsets.some((args) => args.includes('PATH'))).toBe(false)
    expect(unsets.some((args) => args.includes('SSH_AUTH_SOCK'))).toBe(false)
  })

  test('does nothing without the fingerprint, even if NODE_ENV is set', () => {
    // The daemon may be the user's own shared tmux server; a NODE_ENV they
    // exported deliberately must survive.
    const calls: string[][] = []
    const manager = managerWithGlobalEnv(
      ['NODE_ENV=staging', 'PATH=/usr/bin'],
      calls
    )
    expect(manager.scrubLeakedGlobalEnvironment()).toEqual([])
    expect(calls.filter((args) => args[0] === 'set-environment')).toEqual([])
  })

  test('ignores removed-var markers', () => {
    const calls: string[][] = []
    const manager = managerWithGlobalEnv(
      ['AGENTBOARD_STATIC_DIR=/x', '-NODE_ENV', 'npm_config_yes=true'],
      calls
    )
    expect(manager.scrubLeakedGlobalEnvironment().sort()).toEqual([
      'AGENTBOARD_STATIC_DIR',
      'npm_config_yes',
    ])
  })

  test('returns empty when show-environment fails (no tmux server)', () => {
    const manager = new SessionManager('agentboard', {
      runTmux: () => {
        throw new Error('no server running')
      },
    })
    expect(manager.scrubLeakedGlobalEnvironment()).toEqual([])
  })

  test('a failed unset skips that var but continues', () => {
    const calls: string[][] = []
    const manager = new SessionManager('agentboard', {
      runTmux: (args: string[]) => {
        calls.push(args)
        if (args[0] === 'show-environment') {
          return ['AGENTBOARD_STATIC_DIR=/x', 'NODE_ENV=production'].join('\n')
        }
        if (args[0] === 'set-environment' && args[3] === 'AGENTBOARD_STATIC_DIR') {
          throw new Error('boom')
        }
        return ''
      },
    })
    expect(manager.scrubLeakedGlobalEnvironment()).toEqual(['NODE_ENV'])
  })
})
