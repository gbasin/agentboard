/** Bounded PNG/JPEG preview decoding. Call only from the thumbnail worker. */
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { crc32 } from 'node:zlib'

export const THUMBNAIL_VERSION = 'png-jpeg-v1'
export const THUMBNAIL_MAX_SOURCE_BYTES = 16 * 1024 * 1024
export const THUMBNAIL_MAX_PIXELS = 16_000_000
export const THUMBNAIL_EDGE = 128
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function checkDimensions(width: number, height: number): void {
  if (!width || !height || width > 16_000 || height > 16_000 || width * height > THUMBNAIL_MAX_PIXELS) {
    throw new Error('Image exceeds thumbnail dimensions')
  }
}

function checkPng(bytes: Buffer): number {
  // pngjs bounds noninterlaced inflate using IHDR. Reject duplicate headers and
  // interlacing (whose pngjs inflate path has no output limit) before decoding.
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Invalid PNG header')
  }
  checkDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  if (bytes[24] !== 8 || bytes[28] !== 0) throw new Error('Unsupported PNG preview format')
  let ended = false
  let rotation = 1
  let seenExif = false
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk')
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw new Error('Truncated PNG data')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if ((type === 'IHDR' && offset !== 8) || type === 'acTL') {
      throw new Error('Unsupported PNG preview metadata')
    }
    if (type === 'eXIf') {
      if (seenExif) throw new Error('Duplicate PNG EXIF')
      seenExif = true
      // pngjs skips unknown ancillary chunks, including their CRC. Validate
      // metadata we interpret ourselves before reading the bounded TIFF IFD.
      if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
        throw new Error('Invalid PNG EXIF checksum')
      }
      rotation = exifOrientation(bytes.subarray(offset + 8, end - 4))
    }
    if (type === 'IEND') { ended = true; break }
    offset = end
  }
  if (!ended) throw new Error('Missing PNG end')
  return rotation
}

/** PNG eXIf is raw TIFF; JPEG APP1 strips its Exif prefix before reuse. */
function exifOrientation(tiff: Buffer): number {
  if (tiff.length < 8) throw new Error('Invalid EXIF')
  const little = tiff.toString('ascii', 0, 2) === 'II'
  if (!little && tiff.toString('ascii', 0, 2) !== 'MM') throw new Error('Invalid EXIF endian')
  const u16 = (at: number) => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at)
  const u32 = (at: number) => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at)
  if (u16(2) !== 42) throw new Error('Invalid EXIF header')
  const ifd = u32(4)
  if (ifd < 8 || ifd + 2 > tiff.length) throw new Error('Invalid EXIF directory')
  const count = u16(ifd)
  if (ifd + 2 + count * 12 > tiff.length) throw new Error('Invalid EXIF entries')
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12
    if (u16(at) === 0x112) {
      if (u16(at + 2) !== 3 || u32(at + 4) !== 1) throw new Error('Invalid EXIF orientation')
      const value = u16(at + 8)
      if (value < 1 || value > 8) throw new Error('Invalid EXIF orientation value')
      return value
    }
  }
  return 1
}

/** Read only EXIF orientation; metadata stays out of generated previews. */
function orientation(bytes: Buffer): number {
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset++] !== 0xff) break
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) throw new Error('Invalid JPEG segment')
    const segment = bytes.subarray(offset + 2, offset + length)
    if (marker === 0xe1 && segment.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) {
      const tiff = segment.subarray(6)
      return exifOrientation(tiff)
    }
    offset += length
  }
  return 1
}

export function decodeThumbnail(input: Uint8Array): Uint8Array {
  if (!input.byteLength || input.byteLength > THUMBNAIL_MAX_SOURCE_BYTES) throw new Error('Image exceeds thumbnail byte limit')
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  let decoded: { width: number; height: number; data: Uint8Array }
  let rotation = 1
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    rotation = checkPng(bytes)
    decoded = PNG.sync.read(bytes, { checkCRC: true })
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    rotation = orientation(bytes)
    decoded = jpeg.decode(bytes, { useTArray: true, tolerantDecoding: false, maxResolutionInMP: 16, maxMemoryUsageInMB: 128 })
  } else throw new Error('Unsupported thumbnail image format')
  checkDimensions(decoded.width, decoded.height)
  const swapped = rotation >= 5
  const sourceWidth = swapped ? decoded.height : decoded.width
  const sourceHeight = swapped ? decoded.width : decoded.height
  const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const data = Buffer.alloc(width * height * 4)
  // Bilinear sampling keeps resizing bounded by thumbnail size. Premultiplied
  // alpha avoids dark fringes around transparent screenshot pixels.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ox = (x + 0.5) * sourceWidth / width - 0.5
    const oy = (y + 0.5) * sourceHeight / height - 0.5
    const w = decoded.width - 1, h = decoded.height - 1
    const mapped = rotation === 2 ? [w - ox, oy] : rotation === 3 ? [w - ox, h - oy]
      : rotation === 4 ? [ox, h - oy] : rotation === 5 ? [oy, ox]
      : rotation === 6 ? [oy, h - ox] : rotation === 7 ? [w - oy, h - ox]
      : rotation === 8 ? [w - oy, ox] : [ox, oy]
    const sx = Math.max(0, Math.min(w, mapped[0])), sy = Math.max(0, Math.min(h, mapped[1]))
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0
    const accum = [0, 0, 0, 0]
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const pos = (Math.min(h, y0 + dy) * decoded.width + Math.min(w, x0 + dx)) * 4
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy)
      const alpha = decoded.data[pos + 3] * weight
      accum[3] += alpha
      for (let c = 0; c < 3; c++) accum[c] += decoded.data[pos + c] * alpha
    }
    const dest = (y * width + x) * 4
    for (let c = 0; c < 3; c++) data[dest + c] = accum[3] ? Math.round(accum[c] / accum[3]) : 0
    data[dest + 3] = Math.round(accum[3])
  }
  const preview = new PNG({ width, height })
  preview.data = data
  return PNG.sync.write(preview, { deflateLevel: 3 })
}
