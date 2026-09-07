import { afterEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { useBrowserPaste, type BrowserPaste } from '../hooks/useBrowserPaste'
import { validateFiles } from '../utils/browserFiles'
const originalFetch = globalThis.fetch
const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => { renderers.splice(0).forEach(r => act(() => r.unmount())); globalThis.fetch = originalFetch })
function setup() {
  const sent: string[] = []
  let api!: ReturnType<typeof useBrowserPaste>
  function Harness({ sessionId = 'one', disabled = false }) {
    api = useBrowserPaste({ sessionId, disabled, onPasteText: t => sent.push(t), onPasteImage: t => sent.push(t) })
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<Harness />) })
  renderers.push(renderer)
  return { sent, get api() { return api }, switch: () => act(() => renderer.update(<Harness sessionId="two" />)), disable: () => act(() => renderer.update(<Harness disabled />)), unmount: () => act(() => renderer.unmount()) }
}
const response = (name: string) => new Response(JSON.stringify({ path: `/tmp/upload/${name}` }))
const payload = (name = 'report.docx'): BrowserPaste => ({ text: '', files: [new File(['bytes'], name)] })
test('rejects empty image clipboard data while allowing empty ordinary files', () => {
  expect(validateFiles([new File([], 'photo.png', { type: 'image/png' })])).toContain('no image data')
  expect(validateFiles([new File([], 'LICENSE')])).toBeNull()
})
test('uploads text, documents, and images directly without a composer', async () => {
  globalThis.fetch = (async (_url, init) => {
    const form = init!.body as FormData
    return response(((form.get('file') ?? form.get('image')) as File).name)
  }) as typeof fetch
  const qa = setup()
  await act(async () => { await qa.api.paste({ text: 'Read these\ntogether', files: [...payload().files, new File(['png'], 'photo.png', { type: 'image/png' })] }) })
  expect(qa.sent).toEqual(["Read these\ntogether\n'/tmp/upload/report.docx' ", '\x1b[200~/tmp/upload/photo.png\x1b[201~ '])
  expect(qa.api.state.status).toBe('idle')
})
test.each(['cancel', 'switch', 'disable', 'unmount'])('%s prevents late upload insertion', async action => {
  let finish!: (r: Response) => void
  let signal: AbortSignal | null | undefined
  globalThis.fetch = (async (_url, init) => { signal = init?.signal; return new Promise<Response>(r => { finish = r }) }) as typeof fetch
  const qa = setup()
  let pending!: Promise<void>
  await act(async () => { pending = qa.api.paste(payload()); await Promise.resolve() })
  act(() => { if (action === 'cancel') qa.api.cancel(); else qa[action as 'switch' | 'disable' | 'unmount']() })
  expect(signal?.aborted).toBe(true)
  await act(async () => { finish(response('report.docx')); await pending })
  expect(qa.sent).toEqual([])
})
test('consecutive file pastes preserve order', async () => {
  const requests: string[] = []
  globalThis.fetch = (async (_url, init) => { const file = (init!.body as FormData).get('file') as File; requests.push(file.name); return response(file.name) }) as typeof fetch
  const qa = setup()
  await act(async () => { await Promise.all([qa.api.paste(payload('first.txt')), qa.api.paste(payload('second.txt'))]) })
  expect(requests).toEqual(['first.txt', 'second.txt'])
  expect(qa.sent).toEqual(["'/tmp/upload/first.txt' ", "'/tmp/upload/second.txt' "])
})
test('failed multi-file upload inserts nothing and can retry', async () => {
  let fail = true
  globalThis.fetch = (async (_url, init) => { const file = (init!.body as FormData).get('file') as File; return fail && file.name === 'second.txt' ? new Response('{}', { status: 500 }) : response(file.name) }) as typeof fetch
  const qa = setup()
  await act(async () => { await qa.api.paste({ text: 'Compare', files: [...payload().files, ...payload('second.txt').files] }) })
  expect(qa.sent).toEqual([])
  expect(qa.api.state.status).toBe('error')
  fail = false
  await act(async () => { await qa.api.retry() })
  expect(qa.sent).toHaveLength(1)
})
test('cancelled clipboard permission request never delivers late text', async () => {
  let finish!: (value: BrowserPaste) => void
  const qa = setup()
  let pending!: Promise<void>
  act(() => { pending = qa.api.paste(new Promise(r => { finish = r }), true) })
  act(() => qa.api.cancel())
  await act(async () => { finish({ text: 'stale', files: [] }); await pending })
  expect(qa.sent).toEqual([])
})
