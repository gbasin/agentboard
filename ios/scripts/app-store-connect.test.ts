import { expect, test } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { appStoreToken, appStoreRequest } from './app-store-connect'

test('creates a short-lived Apple JWT with a verifiable ES256 signature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const token = appStoreToken(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'key', 'issuer', 1000)
  const [header, payload, signature] = token.split('.')
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'key', typ: 'JWT' })
  expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iss: 'issuer', iat: 1000, exp: 1300, aud: 'appstoreconnect-v1' })
  expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
})

test('rejects unrelated endpoints before loading credentials', async () => {
  await expect(appStoreRequest('https://example.com')).rejects.toThrow('Expected an App Store Connect')
})
