import { expect, test } from 'bun:test'
import { isBoardOrigin } from '../outputs/requestOrigin'

test('board accepts its viewer and CLI clients but refuses other origins and opaque documents', () => {
  const req = (origin?: string) => new Request('http://board.test:4040/api/settings/synced', { headers: origin ? { Origin: origin } : {} })
  expect(isBoardOrigin(req())).toBe(true)
  expect(isBoardOrigin(req('http://board.test:4040'))).toBe(true)
  expect(isBoardOrigin(req('https://board.test:4040'))).toBe(true) // TLS termination
  for (const origin of ['http://board.test:45000', 'https://other.test', 'null', 'invalid']) expect(isBoardOrigin(req(origin))).toBe(false)
})
