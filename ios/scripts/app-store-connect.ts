/** Small authenticated client for publishing checks; never prints signing material. */
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function appStoreToken(key: string, keyID: string, issuerID: string, now = Math.floor(Date.now() / 1000)) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const content = `${encode({ alg: 'ES256', kid: keyID, typ: 'JWT' })}.${encode({ iss: issuerID, iat: now, exp: now + 300, aud: 'appstoreconnect-v1' })}`
  return `${content}.${sign('sha256', Buffer.from(content), { key: createPrivateKey(key), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

export async function appStoreRequest(path: string, options: RequestInit = {}): Promise<any> {
  if (!path.startsWith('/v1/')) throw new Error('Expected an App Store Connect v1 resource')
  const { ASC_PRIVATE_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID } = process.env
  if (!ASC_PRIVATE_KEY_PATH || !ASC_KEY_ID || !ASC_ISSUER_ID) throw new Error('Missing App Store Connect credentials')
  const token = appStoreToken(readFileSync(ASC_PRIVATE_KEY_PATH, 'utf8'), ASC_KEY_ID, ASC_ISSUER_ID)
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${token}` },
  })
  if (response.status === 204) return undefined
  const body = await response.json()
  if (!response.ok) throw new Error(`App Store Connect ${response.status}: ${body.errors?.map((error: { code: string; title: string }) => `${error.code}: ${error.title}`).join('; ') ?? 'request failed'}`)
  return body
}
