/** Order asynchronous pane-mode reads without starving slower polling cycles. */
export class CopyModeQuery {
  private next = 0
  private published = 0

  async read(query: () => Promise<string>, isCurrent: () => boolean) {
    const sequence = ++this.next
    let output = ''
    try {
      output = await query()
    } catch {
      // Preserve the existing unavailable-pane fallback.
    }
    // A pending newer poll does not invalidate this result, but a completed
    // newer poll does. Otherwise latency above the polling interval starves UI.
    if (!isCurrent() || sequence < this.published) return null
    this.published = sequence
    const [copy, alternate, mouse] = output.trim().split(',')
    return { inCopyMode: copy === '1', altScreen: alternate === '1', appMouse: mouse === '1' }
  }
}
