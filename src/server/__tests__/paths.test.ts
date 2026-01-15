import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { resolveProjectPath } from '../paths'

describe('resolveProjectPath', () => {
  test('returns empty for blank values', () => {
    expect(resolveProjectPath('')).toBe('')
    expect(resolveProjectPath('   ')).toBe('')
  })

  test('expands ~ to home directory', () => {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    const expectedHome = homeDir ? path.resolve(homeDir) : path.resolve('~')
    const expectedProject = homeDir
      ? path.resolve(path.join(homeDir, 'project'))
      : path.resolve('~/project')
    expect(resolveProjectPath('~')).toBe(expectedHome)
    expect(resolveProjectPath('~/project')).toBe(expectedProject)
  })

  test('resolves relative paths', () => {
    const resolved = resolveProjectPath('tmp/project')
    expect(resolved.endsWith(path.join('tmp', 'project'))).toBe(true)
  })
})
