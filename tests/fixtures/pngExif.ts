/** Synthetic metadata fixtures; never include personal screenshot pixels or EXIF. */
export function exifTiff(orientation = 1, littleEndian = true): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write(littleEndian ? 'II' : 'MM')
  const u16 = (value: number, at: number) => littleEndian ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at)
  const u32 = (value: number, at: number) => littleEndian ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at)
  u16(42, 2); u32(8, 4); u16(1, 8)
  u16(0x112, 10); u16(3, 12); u32(1, 14); u16(orientation, 18)
  return tiff
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4, 4, 'ascii'); data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

export function withPngExif(image: Buffer, tiff = exifTiff()): Buffer {
  return Buffer.concat([image.subarray(0, 33), pngChunk('eXIf', tiff), image.subarray(33)])
}
