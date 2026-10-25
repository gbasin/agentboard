# Independent review

Claude reviewed the implementation read-only through the consult-claude skill, job `20261025-142240-claude-12212585`, using the CLI's default model and effort. The root agent checked the findings against the code and owned all changes and validation.

## Findings and decisions

- **Worker termination:** Claude identified existing repository warnings that `Worker.terminate()` can crash compiled Bun binaries. The initial source-mode blocked-worker test did not establish release safety. The revised design uses a response deadline without terminating or replacing an occupied worker: optional previews become unavailable until that worker completes. Shutdown is cooperative. A compiled probe found that forced termination left a blocked worker alive, while an async shutdown callback crashed with SIGTRAP. The synchronous shutdown dispatcher passed compiled recovery and active-disposal tests and now has a permanent CI regression. This preserves bounded work and protects the server. Abandon-and-respawn was rejected because repeated deadlines could accumulate decoding workers.
- **Original image opening:** Verified a behavior regression: large originals had moved from a separate tab into the terminal's lightbox. Restored the original byte/pixel gate for the tap action while retaining thumbnails. This limits new image-decoding pressure inside the iOS terminal tab.
- **Compilation:** Added the thumbnail worker to the CI compilation list as well as the release workflow.
- **Cancellation:** A Playwright-intercepted request proves browser cancellation, not server disconnect propagation. A separate Bun HTTP check confirmed disconnect propagation and that the cancelled queued job never reached the worker; see backend evidence.
- **Memory:** Pixel and input caps bound work but are not an OS RSS limit. A large PNG can require several hundred MiB of transient worker memory. One decode is admitted at a time, and oversized images fall back to explicit-open. This is a documented limitation, not a claim of a 128 MiB process-memory cap.
- **Cache and source changes:** Verified that transcript appends revalidate the source digest without re-decoding cached pixels. The hook's source-change race was fixed and covered by regression tests.
- **Temporary failure:** A 503 shows an unavailable tile for that mount. Closing/reopening Media retries; there is no automatic retry loop or polling. Original access remains available.
- **Browser cache version:** `thumbnail=1` is the current representation version. A future incompatible decoder change must bump that query value (and client/server contract) so immutable browser caches do not hide the change.

The review supports the architecture but does not replace runtime testing. Compiled worker checks, browser evidence, and remaining platform limits are recorded in the adjacent reports.
