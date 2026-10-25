# PNG screenshot preview regression

The live thumbnail trial returned HTTP 422 for ordinary screenshots containing a PNG `eXIf` chunk. The client correctly displayed its terminal failure state, `No preview`, so waiting longer could not resolve it. The decoder's preflight rejected every such chunk to avoid mishandling orientation. That blanket exclusion was too restrictive. Initial synthetic PNG fixtures had no EXIF metadata and did not exercise this common input shape.

Six representative failing payloads from the reported session were all 8-bit, noninterlaced PNGs under the existing size and pixel limits. Each contained `eXIf`; several also contained `sRGB` or `iCCP`. All six decoded after the fix, producing 75×128, 59×128, or 128×72 previews in local observations of 7–81 ms. Personal payloads remain outside the repository; committed fixtures contain synthetic pixels and metadata.

The fix reads the bounded TIFF orientation directory shared with the JPEG path, supports both byte orders and orientations 1–8, validates the PNG EXIF chunk checksum, and rejects duplicate or malformed EXIF. It does not follow nested TIFF directories or copy metadata into the output. Byte/pixel limits, interlaced/16-bit PNG restrictions, worker isolation, and admission limits remain unchanged. PNG EXIF can occur after IDAT and is handled there too.

The [PNG specification's eXIf section](https://www.w3.org/TR/png-3/#eXIf) defines the raw TIFF profile without JPEG's APP1 prefix. The [W3C implementation report](https://w3c.github.io/png/Implementation_Report_3e/index.html) records browser handling of PNG EXIF orientation. Installed pngjs source skips unknown ancillary chunks without CRC validation; the explicit CRC check covers metadata this decoder now interprets.

Regression coverage includes all eight orientations in both byte orders with pixel-placement assertions, normal screenshots, absent orientation, post-IDAT EXIF, CRC corruption, duplicate chunks, invalid TIFF offsets/counts, and invalid orientation values. The compiled worker regression now uses an EXIF-bearing PNG. The browser test checks orientation 1 and 6 through real transcript extraction, HTTP thumbnail generation, and rendered Chromium/WebKit images without original downloads.

Existing HTTP URLs can be retained: previously supported image output is unchanged, and the newly supported PNGs previously returned errors without immutable caching. Close and reopen Media (or reload the page) to discard the mounted client's previous failed-preview state after installing the fix.
