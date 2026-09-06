import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import PasteDialog from '../components/PasteDialog'

const originalFetch = globalThis.fetch
const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount())
  globalThis.fetch = originalFetch
})

function setup(extra: Partial<Parameters<typeof PasteDialog>[0]> = {}) {
  const sent: string[] = []
  let closed = 0
  const props = { onPasteText: (text: string) => sent.push(text), onSendKey: (text: string) => sent.push(text), onClose: () => { closed++ }, ...extra }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<PasteDialog {...props} />) })
  renderers.push(renderer)
  const button = (name: string) => renderer.root.findAllByType('button').find((b) => b.props.children === name)!
  const choose = (files: File[]) => act(() => renderer.root.findByType('input').props.onChange({ target: { files, value: '' } }))
  const enter = (value: string) => act(() => renderer.root.findByType('textarea').props.onChange({ target: { value } }))
  const send = () => act(async () => { await button('Send').props.onClick() })
  return { renderer, props, sent, closed: () => closed, button, choose, enter, send }
}

function uploadResponse(name: string) {
  return new Response(JSON.stringify({ path: `/tmp/upload/${name}` }), { headers: { 'content-type': 'application/json' } })
}

describe('Paste draft', () => {
  test('waits for native clipboard confirmation before opening the dialog', async () => {
    let resolve!: (draft: { text: string; files: File[] }) => void
    const clipboard = new Promise<{ text: string; files: File[] }>((r) => { resolve = r })
    let shown = 0
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PasteDialog clipboard={clipboard} onPasteText={() => {}} onSendKey={() => {}} onClose={() => {}} />, {
        createNodeMock: (node) => node.type === 'dialog' ? { showModal: () => { shown++ } } : null,
      })
    })
    renderers.push(renderer)
    expect(shown).toBe(0)
    await act(async () => { resolve({ text: 'Clipboard text', files: [] }) })
    expect(shown).toBe(1)
    expect(renderer.root.findByType('textarea').props.value).toBe('Clipboard text')
  })

  test('sends multiline text and selected device files together only after Send', async () => {
    const uploaded: File[] = []
    globalThis.fetch = (async (_url, init) => {
      const file = (init!.body as FormData).get('file') as File
      uploaded.push(file)
      return uploadResponse(file.name)
    }) as typeof fetch
    const qa = setup()
    qa.enter('Read these\nand compare:')
    qa.choose([new File(['docx bytes'], 'report.docx'), new File(['csv bytes'], 'data with spaces.csv')])
    expect(qa.sent).toEqual([])
    expect(uploaded).toHaveLength(0)
    await qa.send()
    expect(await uploaded[0]!.text()).toBe('docx bytes')
    expect(await uploaded[1]!.text()).toBe('csv bytes')
    expect(qa.sent).toEqual(["Read these\nand compare:\n'/tmp/upload/report.docx'\n'/tmp/upload/data with spaces.csv'"])
    expect(qa.closed()).toBe(1)
  })

  test('keeps text, a document, and an image in delivery order', async () => {
    globalThis.fetch = (async (_url, init) => {
      const form = init!.body as FormData
      const file = (form.get('file') ?? form.get('image')) as File
      return uploadResponse(file.name)
    }) as typeof fetch
    const qa = setup({ initial: { text: 'Compare all three:', files: [
      new File(['document'], 'report.docx'),
      new File(['image'], 'photo.png', { type: 'image/png' }),
    ] } })
    await qa.send()
    expect(qa.sent).toEqual([
      "Compare all three:\n'/tmp/upload/report.docx'\n",
      '\x1b[200~/tmp/upload/photo.png\x1b[201~ ',
    ])
  })

  test('native file paste adds a file without replacing draft text', () => {
    const qa = setup({ initial: { text: 'Review this:', files: [] } })
    let prevented = false
    act(() => qa.renderer.root.findByType('dialog').props.onPaste({
      clipboardData: { files: [new File(['unknown'], 'custom.unknown')] },
      preventDefault: () => { prevented = true },
    }))
    expect(prevented).toBe(true)
    expect(qa.renderer.root.findByType('textarea').props.value).toBe('Review this:')
    expect(qa.renderer.root.findAllByType('li')).toHaveLength(1)
  })

  test('a failed multi-file upload sends nothing and retains the draft for retry', async () => {
    let fail = true
    globalThis.fetch = (async (_url, init) => {
      const file = (init!.body as FormData).get('file') as File
      if (file.name === 'second.txt' && fail) return new Response(JSON.stringify({ error: 'Try again' }), { status: 503 })
      return uploadResponse(file.name)
    }) as typeof fetch
    const qa = setup({ initial: { text: 'Compare', files: [new File(['1'], 'first.txt'), new File(['2'], 'second.txt')] } })
    await qa.send()
    expect(qa.sent).toEqual([])
    expect(qa.closed()).toBe(0)
    expect(qa.renderer.root.findByType('textarea').props.value).toBe('Compare')
    expect(qa.renderer.root.findAllByType('li')).toHaveLength(2)
    expect(qa.renderer.root.findAllByProps({ role: 'alert' })[0]!.props.children).toBe('Try again')
    fail = false
    await qa.send()
    expect(qa.sent).toHaveLength(1)
  })

  test.each(['cancel', 'unmount', 'disable'])('%s while uploading never inserts a late result', async (action) => {
    let finish!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    globalThis.fetch = (async (_url, init) => {
      signal = init?.signal
      return new Promise<Response>((resolve) => { finish = resolve })
    }) as typeof fetch
    const qa = setup({ initial: { text: 'Old session', files: [new File(['1'], 'file.txt')] } })
    let sending!: Promise<void>
    act(() => { sending = qa.button('Send').props.onClick() })
    act(() => {
      if (action === 'cancel') qa.button('Cancel').props.onClick()
      if (action === 'unmount') qa.renderer.unmount()
      if (action === 'disable') qa.renderer.update(<PasteDialog {...qa.props} disabled />)
    })
    expect(signal?.aborted).toBe(true)
    await act(async () => { finish(uploadResponse('file.txt')); await sending })
    expect(qa.sent).toEqual([])
  })

  test('late clipboard read cannot overwrite an edited draft', async () => {
    let resolve!: (draft: { text: string; files: File[] }) => void
    const clipboard = new Promise<{ text: string; files: File[] }>((r) => { resolve = r })
    const qa = setup({ clipboard })
    qa.enter('My edited text')
    await act(async () => { resolve({ text: 'Old clipboard', files: [] }) })
    expect(qa.renderer.root.findByType('textarea').props.value).toBe('My edited text')
  })

  test('rejects oversized files while retaining existing text', () => {
    const qa = setup({ initial: { text: 'Keep this', files: [] } })
    const file = new File([''], 'large.zip')
    Object.defineProperty(file, 'size', { value: 41 * 1024 * 1024 })
    qa.choose([file])
    expect(qa.renderer.root.findByType('textarea').props.value).toBe('Keep this')
    expect(qa.renderer.root.findAllByType('li')).toHaveLength(0)
    expect(qa.renderer.root.findAllByProps({ role: 'alert' })[0]!.props.children).toContain('40 MB')
  })

  test('does not insert a local upload path into an SSH session', async () => {
    const qa = setup({ fileUploadsAllowed: false, initial: { text: 'Review', files: [new File([''], 'file.txt')] } })
    expect(qa.button('Choose files').props.disabled).toBe(true)
    expect(qa.button('Send').props.disabled).toBe(true)
    await qa.send()
    expect(qa.sent).toEqual([])
  })
})
