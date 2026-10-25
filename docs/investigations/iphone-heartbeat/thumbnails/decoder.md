# Thumbnail decoder validation

Date: 2026-10-25. Runtime: Bun 1.3.14 (0d9b296a), macOS ARM64.

## Decision and limits

The decoder uses pure JavaScript `jpeg-js@0.4.4` and `pngjs@7.0.0`. Both libraries bundled into a standalone executable and ran. This avoids adding native codec libraries to the four-platform release package.

Production accepts PNG/JPEG payloads up to 16 MiB and 16 million pixels, with individual dimensions at most 16,000. JPEG additionally sets `maxMemoryUsageInMB: 128` and disables tolerant decoding. This is approximate library allocation accounting, not an OS memory ceiling. Some images below the pixel limit can still be rejected. Decoding runs in the dedicated thumbnail worker; the service controls request admission and timeouts.

PNG preflight requires 8-bit noninterlaced images, checks chunk bounds, disallows duplicate IHDR headers, and rejects animation (`acTL`) and EXIF (`eXIf`) chunks. CRC checking remains enabled. Inspection of pngjs 7.0.0 `lib/parser-sync.js` showed bounded inflation based on IHDR for noninterlaced PNG, but unrestricted `zlib.inflateSync` for interlaced PNG. Rejecting interlacing avoids that path. Unsupported inputs use explicit-open fallback.

Output is PNG, at most 128 pixels on its longest edge, without upscaling. Bilinear sampling preserves alpha; JPEG EXIF orientation is applied. Original metadata is omitted. A 128-by-128 RGBA output contains only 65,536 raw pixel bytes, fitting the frontend's 128 KiB encoded-payload budget.

## Compiled worker experiment

`decoder-poc-main.ts.txt` and `decoder-poc-worker.ts.txt` retain the exact initial library experiment. The POC uses nearest-neighbor resizing to 112 pixels wide; production uses bilinear resizing and a 128-pixel longest-edge limit.

Fixture: 1,600-by-1,200 RGBA image (1.92 MP). Red is the linear pixel index modulo 255, green is 123, blue is 210, alpha is 255. JPEG quality is 70; PNG uses defaults. A five-millisecond main-thread interval measures delay during each worker request. Fixture encoding precedes resetting the delay measurement.

| Format | Original bytes | Output | Output bytes | Worker decode/resize/encode | Maximum main-thread delay above 5 ms |
| --- | ---: | --- | ---: | ---: | ---: |
| PNG | 1,212,952 | 112 × 84 PNG | 6,796 | 73.796 ms | 0.670 ms |
| JPEG | 780,385 | 112 × 84 PNG | 22,575 | 114.609 ms | 0.864 ms |

These are single observations, not distributional benchmarks or terminal/network stress tests. They demonstrate compiled worker execution without a corresponding main-thread stall for this fixture, not production latency under contention.

Reproduce from the repository root after `bun install`:

```sh
mkdir -p .poc-stress-test/decoder
cp docs/investigations/iphone-heartbeat/thumbnails/decoder-poc-main.ts.txt .poc-stress-test/decoder/main.ts
cp docs/investigations/iphone-heartbeat/thumbnails/decoder-poc-worker.ts.txt .poc-stress-test/decoder/worker.ts
cd .poc-stress-test/decoder
bun build main.ts worker.ts --compile --outfile decoder-probe
./decoder-probe
```

## Compiled production decoder experiment

`decoder-production-poc.ts.txt` imports the production decoder. Its fixture is a solid opaque white 1,600-by-1,200 RGBA image. JPEG quality is 80. Time includes thumbnail generation and decoding the result for verification.

| Source | Output | Output bytes | Elapsed |
| --- | --- | ---: | ---: |
| PNG | 128 × 96 PNG | 273 | 33.447 ms |
| JPEG | 128 × 96 PNG | 273 | 105.965 ms |

Reproduce from the repository root:

```sh
mkdir -p .poc-stress-test
cp docs/investigations/iphone-heartbeat/thumbnails/decoder-production-poc.ts.txt .poc-stress-test/production.ts
bun build .poc-stress-test/production.ts --compile --outfile .poc-stress-test/production-probe
.poc-stress-test/production-probe
```

The initial decoder suite passed 10 tests and 21 assertions: PNG alpha/aspect ratio, no upscaling, JPEG output, EXIF rotation, byte/pixel caps, unsupported PNG variants, duplicate headers, malformed data, output size, and oversized JPEG SOF rejection. Targeted lint and repository typecheck passed at this stage. Integrated worker/route validation is separate.

## Portability limits and sources

Only macOS ARM64 execution was tested here. Linux and macOS x64 runtime behavior remains unverified by this experiment. Pure JavaScript and Bun's standalone support provide a packaging rationale, not execution proof for every target. Release builds target Darwin ARM64/x64 and Linux ARM64/x64; the thumbnail worker must be among compile entrypoints.

Primary sources:

- [jpeg-js README](https://github.com/jpeg-js/jpeg-js): implementation and resolution/approximate-memory options.
- [pngjs README](https://github.com/pngjs/pngjs): encode/decode API and CRC behavior.
- [pngjs synchronous parser source](https://github.com/pngjs/pngjs/blob/v7.0.0/lib/parser-sync.js): inflate paths.
- [Bun standalone executables](https://bun.sh/docs/bundler/executables): bundling and cross-compilation.
