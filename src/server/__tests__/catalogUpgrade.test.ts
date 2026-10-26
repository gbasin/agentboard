import { expect, test } from 'bun:test'
import { catalogVersionFromUrl, CATALOG_VERSION } from '../../shared/catalogProtocol'
import { startCatalogUpgradeNotice } from '../catalogUpgrade'

test('catalog negotiation requires an explicit supported version before snapshots', () => {
  expect(catalogVersionFromUrl(new URL('http://localhost/ws'))).toBeNull()
  expect(catalogVersionFromUrl(new URL('http://localhost/ws?catalog=1'))).toBeNull()
  expect(catalogVersionFromUrl(new URL('http://localhost/ws?catalog=2'))).toBe(CATALOG_VERSION)
  expect(catalogVersionFromUrl(new URL('http://localhost/ws?catalog=2extra'))).toBeNull()
})

test('legacy notice uses an existing small error frame and never sends catalog data', () => {
  const messages: string[] = []
  const stop = startCatalogUpgradeNotice({ send: data => messages.push(data) })
  stop()
  expect(messages).toHaveLength(1)
  expect(messages[0]!.length).toBeLessThan(256)
  expect(JSON.parse(messages[0]!)).toEqual({ type: 'error', message: expect.stringContaining('Reload this tab') })
})

test('legacy notices do not accumulate on a backpressured connection', () => {
  const messages: string[] = []
  const stop = startCatalogUpgradeNotice({ send: data => messages.push(data), getBufferedAmount: () => 8192 })
  stop()
  expect(messages).toHaveLength(0)
})
