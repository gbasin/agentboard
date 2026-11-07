/** Compiled-only regression fixture: delay the real worker's first request. */
import '../../src/server/mediaThumbnailWorker'
const handle = self.onmessage!
let first = true
self.onmessage = (event) => {
  if (event.data.kind !== 'shutdown' && first) {
    first = false
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  // Keep shutdown dispatch synchronous, exactly like the production worker.
  handle.call(self, event)
}
