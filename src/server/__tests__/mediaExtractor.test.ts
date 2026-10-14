import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  extractMediaItems,
  extractSessionMedia,
  getSessionMedia,
  clearMediaScanCache,
} from '../mediaExtractor'

// A 1x1 red PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhHGAfKmMIwAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_B64, 'base64').length

function claudeUserImage(data: string, mediaType = 'image/png') {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
      ],
    },
  })
}

function claudeToolUse(id: string, name: string, filePath: string) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name, input: { file_path: filePath } },
      ],
    },
  })
}

function claudeToolResultImage(toolUseId: string, data: string) {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data },
            },
          ],
        },
      ],
    },
    toolUseResult: {
      type: 'image',
      file: {
        type: 'image/png',
        originalSize: PNG_BYTES,
        dimensions: { originalWidth: 400, originalHeight: 300 },
      },
    },
  })
}

function codexInputImage(dataUrl: string) {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: dataUrl }],
    },
  })
}

function codexGeneratedImage(result: string, prompt: string) {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'image_generation_call',
      id: 'ig_1',
      result,
      revised_prompt: prompt,
    },
  })
}

describe('mediaExtractor', () => {
  test('extracts a pasted Claude image with media type and size', () => {
    const media = extractSessionMedia(claudeUserImage(PNG_B64) + '\n')
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      bytes: PNG_BYTES,
      offset: 0,
      index: 0,
    })
  })

  test('captions tool_result images from the paired tool call', () => {
    const media = extractSessionMedia(
      [
        claudeToolUse('toolu_1', 'Read', '/tmp/shots/closeup-hero.png'),
        claudeToolResultImage('toolu_1', PNG_B64),
      ].join('\n') + '\n'
    )
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({
      kind: 'image',
      label: 'Read · closeup-hero.png',
      width: 400,
      height: 300,
      bytes: PNG_BYTES,
    })
    expect(media[0].offset).toBeGreaterThan(0)
  })

  test('extracts pasted documents', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'JVBERi0xLjYK',
            },
          },
        ],
      },
    })
    const media = extractSessionMedia(line + '\n')
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ kind: 'document', mediaType: 'application/pdf' })
  })

  test('extracts frame-link artifact records as links', () => {
    const line = JSON.stringify({
      type: 'frame-link',
      frameUrl: 'https://claude.ai/artifact/abc123',
      title: 'Audit walkthrough',
      path: '/tmp/x/index.html',
    })
    const media = extractSessionMedia(line + '\n')
    expect(media).toEqual([
      expect.objectContaining({
        kind: 'link',
        url: 'https://claude.ai/artifact/abc123',
        label: 'Audit walkthrough',
      }),
    ])
  })

  test('extracts codex input_image data urls', () => {
    const media = extractSessionMedia(
      codexInputImage(`data:image/png;base64,${PNG_B64}`) + '\n'
    )
    expect(media).toEqual([
      expect.objectContaining({
        kind: 'image',
        mediaType: 'image/png',
        bytes: PNG_BYTES,
      }),
    ])
  })

  test('extracts codex generated images with the revised prompt as label', () => {
    const media = extractSessionMedia(
      codexGeneratedImage(PNG_B64, 'a tiled texture') + '\n'
    )
    expect(media).toEqual([
      expect.objectContaining({
        kind: 'image',
        mediaType: 'image/png',
        label: 'a tiled texture',
        bytes: PNG_BYTES,
      }),
    ])
  })

  test('external image urls become images without bytes', () => {
    const media = extractSessionMedia(
      codexInputImage('https://example.com/pic.png') + '\n'
    )
    expect(media).toEqual([
      expect.objectContaining({
        kind: 'image',
        url: 'https://example.com/pic.png',
      }),
    ])
    expect(media[0].bytes).toBeUndefined()
  })

  test('dedupes identical payloads across duplicated codex turns', () => {
    const line = codexInputImage(`data:image/png;base64,${PNG_B64}`)
    const media = extractSessionMedia(line + '\n' + line + '\n')
    expect(media).toHaveLength(1)
  })

  test('non-base64 data urls and missing payloads are handled', () => {
    // data: without ;base64 cannot be served by the endpoint — stays a url ref.
    const raw = extractSessionMedia(
      codexInputImage('data:image/png,notbase64stuff') + '\n'
    )
    expect(raw).toEqual([
      expect.objectContaining({
        kind: 'image',
        url: 'data:image/png,notbase64stuff',
      }),
    ])
    expect(raw[0].bytes).toBeUndefined()

    // Image block with no source data produces nothing.
    const empty = extractSessionMedia(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'image', source: {} }] },
      }) + '\n'
    )
    expect(empty).toHaveLength(0)
  })

  test('malformed lines and non-media lines produce nothing', () => {
    expect(
      extractSessionMedia('{broken json "image\n' + claudeUserImage('') + '\n')
    ).toHaveLength(0)
  })

  test('caps media per file, dropping the oldest', () => {
    // 2001 unique payloads spread over 9 lines (≤256 indexable per line).
    let n = 0
    const lines = Array.from({ length: 9 }, () =>
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: Array.from({ length: 255 }, () => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: Buffer.from(`pad-${n++}`).toString('base64'),
            },
          })),
        },
      })
    )
    const media = extractSessionMedia(lines.join('\n') + '\n')
    expect(media).toHaveLength(2000)
    // The first line's payloads are evicted first.
    expect(media[0].offset).toBeGreaterThan(0)
  })

  test('never emits indexes the endpoint cannot address', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: Array.from({ length: 300 }, (_, i) => ({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from(`p${i}`).toString('base64'),
          },
        })),
      },
    })
    const media = extractSessionMedia(line + '\n')
    expect(Math.max(...media.map((m) => m.index))).toBe(256)
  })

  test('item index matches the endpoint extraction order', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: PNG_B64 },
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
          },
        ],
      },
    })
    const media = extractSessionMedia(line + '\n')
    expect(media.map((m) => m.index)).toEqual([0, 1])
    // The endpoint resolves index against the same walk.
    expect(extractMediaItems(line)[1].data).toBe('QUJD')
  })

  describe('getSessionMedia', () => {
    let dir: string
    let logPath: string

    beforeEach(() => {
      clearMediaScanCache()
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-extract-'))
      logPath = path.join(dir, 'session.jsonl')
    })
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test('scans appended bytes incrementally', () => {
      fs.writeFileSync(logPath, claudeUserImage(PNG_B64) + '\n')
      const first = getSessionMedia(logPath)
      expect(first).toHaveLength(1)
      const firstOffset = first[0].offset

      fs.appendFileSync(
        logPath,
        claudeToolUse('toolu_2', 'Read', '/tmp/b.png') +
          '\n' +
          claudeToolResultImage('toolu_2', 'QUJDRA==') +
          '\n'
      )
      const second = getSessionMedia(logPath)
      expect(second).toHaveLength(2)
      // Earlier descriptors keep their byte offsets after an append.
      expect(second[0].offset).toBe(firstOffset)
      expect(second[1].label).toBe('Read · b.png')
    })

    test('survives lines split across chunk reads', () => {
      // Chunks are 128KB; pad past a boundary mid-image-line.
      const pad = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(200 * 1024) } })
      fs.writeFileSync(
        logPath,
        pad + '\n' + claudeUserImage(PNG_B64) + '\n'
      )
      const media = getSessionMedia(logPath)
      expect(media).toHaveLength(1)
      expect(media[0].bytes).toBe(PNG_BYTES)
    })

    test('rescans after a same-size rewrite', () => {
      fs.writeFileSync(logPath, claudeUserImage(PNG_B64) + '\n')
      expect(getSessionMedia(logPath)).toHaveLength(1)

      // Same-size rewrite drops the payload entirely.
      const replacement = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'no media here' },
      })
      const current = fs.readFileSync(logPath)
      fs.writeFileSync(
        logPath,
        Buffer.concat([Buffer.from(replacement), current.subarray(replacement.length)])
      )
      // force an mtime bump
      const future = new Date(Date.now() + 5000)
      fs.utimesSync(logPath, future, future)
      const media = getSessionMedia(logPath)
      expect(media).toHaveLength(0)
    })

    test('extractMediaItems returns payload data for the endpoint', () => {
      const items = extractMediaItems(claudeUserImage(PNG_B64))
      expect(items).toHaveLength(1)
      expect(items[0].data).toBe(PNG_B64)
      expect(items[0].mediaType).toBe('image/png')
    })
  })
})
