/** One shared discovery panel; preview state never owns or remounts xterm. */
import { useCallback, useState, type ReactNode } from 'react'
import type { Session, SessionMedia } from '@shared/types'
import MediaRail from '../MediaRail'
import { useIsMobileLayout } from '../../hooks/useMobileLayout'
import { OutputPreview } from './OutputPreview'

export default function SessionOutputs({ session, ready, children }: { session: Session | null; ready: boolean; children: ReactNode }) {
  const mobile = useIsMobileLayout()
  const identity = JSON.stringify([session?.id, session?.agentSessionId, session?.logFilePath])
  const [selection, setSelection] = useState<{ identity: string; item: SessionMedia; open: boolean } | null>(null)
  const [choose, setChoose] = useState(0)
  const selected = selection?.identity === identity ? selection : null
  const close = useCallback(() => setSelection(previous => previous ? { ...previous, open: false } : null), [])
  return <div className="relative flex min-h-0 min-w-0 flex-1" data-testid="session-outputs">
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {children}
      {session && <MediaRail session={session} ready={ready} choosePreview={choose} chooseTab={selected?.item.kind === 'link' ? 'links' : 'previews'}
        onPreview={item => setSelection({ identity, item, open: true })} />}
    </div>
    {selected && <OutputPreview key={selected.item.url} item={selected.item} mobile={mobile} open={selected.open} onClose={close}
      onChoose={() => setChoose(value => value + 1)} status={session?.status} />}
  </div>
}
