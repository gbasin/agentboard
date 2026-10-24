/** Explicit review for text typed while terminal input was unavailable. */
interface Props {
  text: string
  sessionName: string
  ready: boolean
  atLimit: boolean
  truncated: boolean
  onDiscardOthers?: () => void
  onEdit(text: string): void
  onSend(): void
  onDiscard(): void
}

export default function RecoveryDraft({ text, sessionName, ready, atLimit, truncated, onDiscardOthers, onEdit, onSend, onDiscard }: Props) {
  return (
    <section aria-label="Unsent terminal text" className="absolute bottom-2 left-2 right-2 z-50 mx-auto max-w-xl rounded-lg border border-border bg-elevated p-3 shadow-lg">
      <label htmlFor="recovery-draft" className="mb-2 block text-sm text-primary">Unsent text for {sessionName}</label>
      <textarea id="recovery-draft" value={text} onChange={event => onEdit(event.target.value)} rows={3}
        spellCheck={false} className="w-full resize-y rounded border border-border bg-base p-2 font-mono text-base text-primary focus:outline-accent"
        aria-describedby="recovery-draft-hint" />
      <p id="recovery-draft-hint" className="mt-1 text-xs text-secondary">
        {truncated ? 'Some text could not be saved: the draft limit was reached. Review before sending.' : atLimit ? 'Draft limit reached. Edit or discard text to make room.' : 'Kept in this tab until reload. Nothing is sent until you choose Send text.'}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {atLimit && onDiscardOthers && <button type="button" onClick={onDiscardOthers} className="min-h-11 rounded px-3 text-sm text-secondary hover:bg-hover">Discard other terminal drafts</button>}
        <button type="button" onClick={onDiscard} className="min-h-11 rounded px-3 text-sm text-secondary hover:bg-hover">Discard text</button>
        <button type="button" onClick={onSend} disabled={!ready || !text}
          className="min-h-11 rounded bg-accent px-3 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50">Send text</button>
      </div>
    </section>
  )
}
