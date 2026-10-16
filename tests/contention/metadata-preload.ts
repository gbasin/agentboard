import { installMetadataGate } from './metadata-gate'
installMetadataGate()
const Original = globalThis.Worker
// All application logic remains real; replace only the worker entry wrapper.
globalThis.Worker = class extends Original {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(String(url).endsWith('/sessionMetadataWorker.ts')
      ? new URL('./metadata-worker.ts', import.meta.url).href : url, options)
  }
}
