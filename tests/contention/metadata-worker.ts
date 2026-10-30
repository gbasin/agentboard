import { installMetadataGate } from './metadata-gate'
installMetadataGate()
await import('../../src/server/sessionMetadataWorker')
