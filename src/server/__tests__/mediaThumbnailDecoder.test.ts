import { expect, test } from 'bun:test'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { exifTiff, pngChunk, withPngExif } from '../../../tests/fixtures/pngExif'
import { decodeThumbnail, THUMBNAIL_MAX_SOURCE_BYTES } from '../mediaThumbnailDecoder'

function png(width = 320, height = 160) {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < data.length; i += 4) { data[i] = 240; data[i + 1] = 60; data[i + 2] = 30; data[i + 3] = 128 }
  return PNG.sync.write(Object.assign(new PNG({ width, height }), { data }))
}
test('PNG preview preserves aspect ratio, colors and alpha at bounded size', () => {
  const result = PNG.sync.read(Buffer.from(decodeThumbnail(png())))
  expect([result.width, result.height]).toEqual([128, 64])
  expect([...result.data.subarray(0, 4)]).toEqual([240, 60, 30, 128])
})
test('small images are not upscaled', () => {
  const result = PNG.sync.read(Buffer.from(decodeThumbnail(png(3, 2))))
  expect([result.width, result.height]).toEqual([3, 2])
})
test('JPEG decodes to a portable PNG preview', () => {
  const image = PNG.sync.read(png())
  const result = PNG.sync.read(Buffer.from(decodeThumbnail(jpeg.encode(image, 80).data)))
  expect([result.width, result.height]).toEqual([128, 64])
  expect(result.data[3]).toBe(255)
})
test('EXIF rotation is applied before preview sizing', () => {
  const source = jpeg.encode(PNG.sync.read(png()), 80).data
  const tiff = Buffer.alloc(26)
  tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x112, 10); tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(6, 18)
  const app = Buffer.concat([Buffer.from('Exif\0\0'), tiff])
  const header = Buffer.from([255, 225, 0, 0]); header.writeUInt16BE(app.length + 2, 2)
  const result = PNG.sync.read(Buffer.from(decodeThumbnail(Buffer.concat([source.subarray(0, 2), header, app, source.subarray(2)]))))
  expect([result.width, result.height]).toEqual([64, 128])
})
test('input bytes and PNG dimensions are checked before decode', () => {
  expect(() => decodeThumbnail(Buffer.alloc(THUMBNAIL_MAX_SOURCE_BYTES + 1))).toThrow('byte limit')
  const huge = png(1, 1); huge.writeUInt32BE(16001, 16)
  expect(() => decodeThumbnail(huge)).toThrow('dimensions')
  huge.writeUInt32BE(5000, 16); huge.writeUInt32BE(5000, 20)
  expect(() => decodeThumbnail(huge)).toThrow('dimensions')
})
test('interlaced and 16-bit PNGs use explicit-open fallback', () => {
  const interlaced = png(1, 1); interlaced[28] = 1
  expect(() => decodeThumbnail(interlaced)).toThrow('Unsupported PNG')
  const deep = png(1, 1); deep[24] = 16
  expect(() => decodeThumbnail(deep)).toThrow('Unsupported PNG')
})
test('duplicate PNG headers and animation metadata cannot bypass preflight', () => {
  const source = png(1, 1)
  const duplicate = Buffer.concat([source.subarray(0, 33), source.subarray(8)])
  expect(() => decodeThumbnail(duplicate)).toThrow('metadata')
  const animated = Buffer.from(source); animated.write('acTL', 37)
  expect(() => decodeThumbnail(animated)).toThrow('metadata')
})
test('malformed and unsupported images fail rather than returning original payload', () => {
  for (const bytes of [Buffer.from('GIF89a'), Buffer.from('<svg/>'), png().subarray(0, 40), Buffer.from([255, 216, 255, 217])]) {
    expect(() => decodeThumbnail(bytes)).toThrow()
  }
  const corrupt = png(1, 1); corrupt[29] ^= 255
  expect(() => decodeThumbnail(corrupt)).toThrow()
})
test('incompressible preview stays below frontend byte budget', () => {
  const data = Buffer.alloc(128 * 128 * 4)
  for (let i = 0; i < data.length; i++) data[i] = (Math.imul(i, 1664525) + 1013904223) >>> 24
  expect(decodeThumbnail(PNG.sync.write(Object.assign(new PNG({ width: 128, height: 128 }), { data }))).byteLength).toBeLessThan(128 * 1024)
})

test('JPEG resolution cap rejects oversized SOF before pixel allocation', () => {
  const source = jpeg.encode(PNG.sync.read(png(1, 1)), 80).data
  const sof = source.indexOf(Buffer.from([255, 192]))
  expect(sof).toBeGreaterThan(0)
  source.writeUInt16BE(5000, sof + 5)
  source.writeUInt16BE(5000, sof + 7)
  expect(() => decodeThumbnail(source)).toThrow('maxResolutionInMP')
})

// Metadata-bearing screenshots were missing from the initial thumbnail fixtures.
// Use synthetic pixels and TIFF data rather than committing personal screenshots.
test('PNG EXIF normal, rotated and mirrored orientations preserve pixel placement in both byte orders', () => {
  const source = new PNG({ width: 3, height: 2 })
  for (let i = 0; i < 6; i++) source.data.set([i + 1, 0, 0, 255], i * 4)
  const pixels = PNG.sync.write(source)
  const expected = [
    [1, 2, 3, 4, 5, 6], [3, 2, 1, 6, 5, 4], [6, 5, 4, 3, 2, 1], [4, 5, 6, 1, 2, 3],
    [1, 4, 2, 5, 3, 6], [4, 1, 5, 2, 6, 3], [6, 3, 5, 2, 4, 1], [3, 6, 2, 5, 1, 4],
  ]
  for (const littleEndian of [true, false]) for (let value = 1; value <= 8; value++) {
    const encoded = decodeThumbnail(withPngExif(pixels, exifTiff(value, littleEndian)))
    const result = PNG.sync.read(Buffer.from(encoded))
    expect([result.width, result.height]).toEqual(value >= 5 ? [2, 3] : [3, 2])
    expect([...result.data].filter((_, i) => i % 4 === 0)).toEqual(expected[value - 1])
    expect(Buffer.from(encoded).includes(Buffer.from('eXIf'))).toBe(false)
  }
})

test('PNG EXIF with no orientation leaves screenshot pixels unchanged, even after IDAT', () => {
  const source = png(3, 2)
  const metadata = exifTiff(); metadata.writeUInt16LE(0, 8)
  const late = Buffer.concat([source.subarray(0, -12), pngChunk('eXIf', metadata), source.subarray(-12)])
  const result = PNG.sync.read(Buffer.from(decodeThumbnail(late)))
  expect([result.width, result.height]).toEqual([3, 2])
  expect(result.data).toEqual(PNG.sync.read(source).data)
})

test('PNG EXIF validates CRC, duplicate chunks, TIFF bounds and orientation values', () => {
  const source = png(1, 1)
  const badCrc = withPngExif(source); badCrc[45] ^= 1
  expect(() => decodeThumbnail(badCrc)).toThrow('checksum')
  expect(() => decodeThumbnail(withPngExif(withPngExif(source)))).toThrow('Duplicate')
  for (const metadata of [Buffer.alloc(0), exifTiff(0), exifTiff(9), exifTiff().subarray(0, 15)]) {
    expect(() => decodeThumbnail(withPngExif(source, metadata))).toThrow('EXIF')
  }
  const outside = exifTiff(); outside.writeUInt32LE(0xffffffff, 4)
  expect(() => decodeThumbnail(withPngExif(source, outside))).toThrow('directory')
  const insideHeader = exifTiff(); insideHeader.writeUInt32LE(0, 4)
  expect(() => decodeThumbnail(withPngExif(source, insideHeader))).toThrow('directory')
  const badCount = exifTiff(); badCount.writeUInt32LE(0xffffffff, 14)
  expect(() => decodeThumbnail(withPngExif(source, badCount))).toThrow('orientation')
})
