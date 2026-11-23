// Only local raster links presented in this Codex conversation can supply a sidebar preview.
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { asRecord } from '../../shared/json'
import { mediaPayloadHeaders } from '../mediaPayloadHeaders'

export function codexImageLinks(raw: unknown, cwd: string): string[] {
  const record = asRecord(raw), payload = asRecord(record?.payload)
  if (record?.type !== 'response_item' || payload?.type !== 'message' ||
      payload.role !== 'assistant' || !Array.isArray(payload.content)) return []
  const paths: string[] = []
  for (const part of payload.content) {
    if (part?.type !== 'output_text' || typeof part.text !== 'string') continue
    const prose = part.text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g, '')
    for (const match of prose.matchAll(/\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))\)/g)) {
      let target: string = match[1] ?? match[2]
      try {
        if (target.startsWith('file://')) target = fileURLToPath(target)
        else if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) continue
        else target = decodeURIComponent(target)
      } catch { continue }
      if (/\p{Cc}/u.test(target) || !/\.(?:png|jpe?g|webp|gif)$/i.test(target)) continue
      if (path.isAbsolute(target) || cwd) paths.push(path.resolve(cwd, target))
    }
  }
  return paths
}

export async function sidebarImageResponse(file: string): Promise<Response | null> {
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.size < 12 || stat.size > 32 * 1024 * 1024) return null
    const bytes = await Bun.file(fd.fd).slice(0, stat.size).arrayBuffer()
    if (bytes.byteLength !== stat.size) return null
    const header = Buffer.from(bytes, 0, 12)
    const mime = header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
      : header.readUIntBE(0, 3) === 0xffd8ff ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6)) ? 'image/gif'
      : header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8) === 'WEBP' ? 'image/webp' : null
    if (!mime) return null
    return new Response(bytes, { headers: mediaPayloadHeaders(mime, false) })
  } finally { await fd.close() }
}
