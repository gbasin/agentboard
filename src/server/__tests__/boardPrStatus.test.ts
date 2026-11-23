import { expect, mock, test } from 'bun:test'
import { BoardPrStatus } from '../boardPrStatus'
import { parsePrUrl } from '../prInfo'

test('public reads and pushes are scoped to locally discovered PRs, including on a shared authority', async () => {
  const original = 'https://github.com/Acme/Widgets/pull/1'
  const canonical = original.toLowerCase()
  const privateUrl = 'https://github.com/other/private/pull/2'
  const records = [canonical, privateUrl].map(url => ({ url, state: 'OPEN', title: url }))
  const register = mock((_urls: string[]) => {})
  const check = mock(async (url: string) => ({ url, checks: [] }))
  const board = new BoardPrStatus({ register, read: urls => records.filter(pr => urls.includes(pr.url)), check })
  const app = board.routes()
  board.discover([parsePrUrl(original)!, parsePrUrl(canonical)!])
  board.discover([parsePrUrl(original)!])
  expect(register.mock.calls).toEqual([[[canonical]]])
  expect(board.changes(records)).toEqual([records[0]])
  const response = await app.request('/pr-info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [original, privateUrl] }),
  })
  expect(await response.json()).toEqual([{ ...records[0], url: original }, { url: privateUrl, error: 'unavailable' }])
  expect(await (await app.request('/pr-checks?url=' + privateUrl)).json()).toEqual({ url: privateUrl, error: 'unavailable' })
  expect(await (await app.request('/pr-checks?url=' + original)).json()).toEqual({ url: original, checks: [] })
  expect(check.mock.calls).toEqual([[canonical]])
})
