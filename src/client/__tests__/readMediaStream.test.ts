import { describe, expect, test } from 'bun:test'
import { readMediaResponse } from '../hooks/readMediaStream'
import { MEDIA_PAGE_BYTES, MEDIA_STREAM_BYTES } from '@shared/media'

function stream(parts: Uint8Array[]) {
  return new Response(new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(part)
    controller.close()
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } })
}
const bytes = (value: string) => new TextEncoder().encode(value)

describe('bounded media frames', () => {
  test('publishes frames before EOF and decodes split UTF8', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(new ReadableStream({ start(c) { controller = c } }), { headers: { 'Content-Type': 'application/x-ndjson' } })
    const events: unknown[] = []
    const result = readMediaResponse(response, event => events.push(event))
    const frame = bytes(JSON.stringify({ type: 'error', message: '圖' }) + '\n')
    const split = frame.indexOf(0xe5) + 1
    controller.enqueue(frame.slice(0, split)); controller.enqueue(frame.slice(split))
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(events).toEqual([{ type: 'error', message: '圖' }])
    controller.enqueue(bytes('{"type":"done"}\n')); controller.close()
    await result
    expect(events).toHaveLength(2)
  })
  test('supports bounded legacy JSON', async () => {
    const events: unknown[] = []
    await readMediaResponse(Response.json({ identity: 'x', items: [] }), event => events.push(event))
    expect(events).toEqual([{ type: 'snapshot', page: { identity: 'x', items: [], discovery: { status: 'ready' } } }, { type: 'done' }])
  })
  test('rejects an oversized frame across chunks', async () => {
    await expect(readMediaResponse(stream([bytes(' '.repeat(MEDIA_PAGE_BYTES)), bytes(' ')]), () => {})).rejects.toThrow('frame exceeded')
  })
  test('rejects an oversized total even when every frame is small', async () => {
    const frame = bytes(JSON.stringify({ type: 'progress', padding: 'a'.repeat(1024) }) + '\n')
    await expect(readMediaResponse(stream(Array(Math.ceil(MEDIA_STREAM_BYTES / frame.length) + 1).fill(frame)), () => {})).rejects.toThrow('response exceeded')
  })
  test('requires explicit done and rejects trailing frames', async () => {
    await expect(readMediaResponse(stream([bytes('{"type":"progress"}\n')]), () => {})).rejects.toThrow('interrupted')
    await expect(readMediaResponse(stream([bytes('{"type":"done"}\n{"type":"progress"}\n')]), () => {})).rejects.toThrow('after media completion')
  })
  test('cancels reader when consumer rejects a malformed frame', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(bytes('{"type":"snapshot"}\n')) }, cancel() { cancelled = true } }), { headers: { 'Content-Type': 'application/x-ndjson' } })
    await expect(readMediaResponse(response, () => { throw new Error('bad page') })).rejects.toThrow('bad page')
    expect(cancelled).toBe(true)
  })
})
