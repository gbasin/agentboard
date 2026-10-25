# Visible media thumbnails

The media rail previously rendered small original payloads as images and showed generic chips for larger images. It had no distinct loading or failure state. This change gives local PNG/JPEG images actual resized previews without automatic original downloads.

## Request path

1. Open the media rail to request the oldest page of descriptors.
2. Observe tiles against the horizontal scroll container, with a 64 px margin.
3. Fetch at most three previews concurrently. Abort optional work when hidden, recovering, offscreen, or unmounted.
4. Authorize the session and transcript path on the HTTP server. Require the descriptor's SHA256 record digest.
5. Dispatch extraction and decoding to a separate worker. Admit at most 16 outstanding jobs and execute one at a time. A 10-second response deadline pauses admission until the occupied worker completes; it never spawns replacement decoding work.
6. Read/hash the bounded transcript record, extract the image, and generate a PNG with a maximum 128 px edge. The preview response is capped at 128 KiB.
7. Cache decoded previews in a 16 MiB / 1,024-entry LRU. Source-version checks detect changed logs; appends require revalidation but do not require decoding the same image again. Browsers can cache digest-addressed responses privately.
8. Show the original only after an explicit tap. Large or unknown-size originals open in a separate tab; small originals retain the lightbox.

The optional worker starts on the first preview request. It is separate from both the catalog metadata worker and the terminal workers. Cancellation removes queued work; already-running work retains its admission slot until completion. Shutdown uses a synchronous cooperative message handler.

## Scope and limits

Supported previews: JPEG and noninterlaced 8-bit PNG. Transparency and JPEG EXIF orientation are preserved. Animated/interlaced/16-bit PNG, other formats, malformed input, sources over 16 MiB, or images over 16 megapixels show an explicit-open fallback. Remote images are never fetched by the preview service. Original payload access remains available.

The server cache is in memory and becomes cold after restart. Existing browser HTTP caching still applies. Thumbnail generation does not change the oldest-first pagination contract or cause background media polling. Previously loaded previews may stay visible while recovery pauses new requests.

This does not move explicit original-image extraction off the HTTP thread. That existing path runs only after a user requests the original; it remains a separate optimization opportunity. The limits prevent unbounded optional work; they do not promise zero CPU, memory, or network contention.

## Validation

Decoder evidence and primary source references are in [decoder.md](decoder.md). Worker and compiled failure-path evidence is in [backend.md](backend.md), browser results in [browser-validation.md](browser-validation.md), and independent review decisions in [review.md](review.md). Lint, typecheck, the full test runner, and the compiled terminal-relay smoke passed locally. Browser visibility-event tests simulate lifecycle transitions; they do not prove physical iPhone cellular or native OS suspension behavior.

The live 4040 server was not changed for this work. It remains on the previous media-pagination candidate, with its existing rollback available.
