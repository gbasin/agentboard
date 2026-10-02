// devinMirrorWriter.test.ts - Failure paths of the streamed mirror rewrite:
// the temp file never survives and the first error is the one surfaced.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeMirrorAtomic } from '../devinMirrorWriter'

let dir = ''
let filePath = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-mirror-writer-'))
  filePath = path.join(dir, 's.jsonl')
  fs.writeFileSync(filePath, 'old\n')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const rows = [{ row_id: 1 }, { row_id: 2 }]
const toLine = (row: { row_id: number }) => `line-${row.row_id}`
const tempFiles = () => fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))

describe('writeMirrorAtomic', () => {
  test('writes and renames into place', () => {
    const result = writeMirrorAtomic(filePath, 'meta', rows, toLine)
    expect(fs.readFileSync(filePath, 'utf8')).toBe('meta\nline-1\nline-2\n')
    expect(result).toEqual({ lastRowId: 2, rowCount: 2, fileSize: 19 })
    expect(tempFiles()).toEqual([])
  })

  test('a row error removes the temp file and keeps the old mirror', () => {
    function* failing() {
      yield { row_id: 1 }
      throw new Error('row read failed')
    }
    expect(() => writeMirrorAtomic(filePath, 'meta', failing(), toLine)).toThrow(
      'row read failed'
    )
    expect(fs.readFileSync(filePath, 'utf8')).toBe('old\n')
    expect(tempFiles()).toEqual([])
  })

  test('a close failure after a write failure surfaces the write error', () => {
    const writeSpy = spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const realCloseSync = fs.closeSync
    const closeSpy = spyOn(fs, 'closeSync').mockImplementationOnce((fd) => {
      realCloseSync(fd)
      throw new Error('close failed')
    })
    try {
      expect(() => writeMirrorAtomic(filePath, 'meta', rows, toLine)).toThrow('disk full')
    } finally {
      writeSpy.mockRestore()
      closeSpy.mockRestore()
    }
    expect(fs.readFileSync(filePath, 'utf8')).toBe('old\n')
    expect(tempFiles()).toEqual([])
  })

  test('a rename failure removes the temp file', () => {
    const renameSpy = spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed')
    })
    try {
      expect(() => writeMirrorAtomic(filePath, 'meta', rows, toLine)).toThrow('rename failed')
    } finally {
      renameSpy.mockRestore()
    }
    expect(fs.readFileSync(filePath, 'utf8')).toBe('old\n')
    expect(tempFiles()).toEqual([])
  })
})
