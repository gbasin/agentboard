/** Discovery is partial until the index reports completion; existing rows remain usable. */
import type { MediaDiscovery } from '@shared/media'
export default function MediaDiscoveryStatus({ discovery, kind, hasItems }: {
  discovery: MediaDiscovery; kind: 'media' | 'links'; hasItems: boolean
}) {
  if (discovery.status !== 'pending' && discovery.status !== 'indexing') return null
  const percent = discovery.status === 'indexing' && discovery.bytesTotal > 0
    ? ` ${Math.min(99, Math.floor(discovery.bytesRead / discovery.bytesTotal * 100))}%` : ''
  return <p role="status" className="px-3 py-2 text-xs text-secondary">
    Finding {hasItems ? 'more ' : ''}{kind}…{percent}{hasItems ? ' Results are partial.' : ''}
  </p>
}
