import type { ITerminalProxy } from './terminal/types'

const COPY_MODE_FORMAT = '#{pane_in_mode},#{alternate_on},#{mouse_any_flag}'
const WHEEL_BOUNDS_FORMAT = '#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{window_offset_x},#{window_offset_y},#{client_width},#{client_height}'

export function resolveLocalCopyModeTarget(target: string, terminal: Pick<ITerminalProxy, 'getActiveGroupedSession'> | null): string {
  const group = terminal?.getActiveGroupedSession?.()
  if (!group) return target
  const prefix = `${group}:`
  if (target === group || (target.startsWith(prefix) && /^(?:@\d+|[A-Za-z0-9_-]+)$/.test(target.slice(prefix.length)))) {
    return `=${group}:`
  }
  // A pane-specific or external ungrouped target keeps its original scope.
  return target
}

export function copyModeCommand(target: string, clientTty?: string | null): string[] {
  // -c alone formats the most recently active client on tmux 3.7c.
  // Keep -t to supply the known group’s active pane.
  return clientTty
    ? ['display-message', '-p', '-c', clientTty, '-t', target, `${COPY_MODE_FORMAT},${WHEEL_BOUNDS_FORMAT}`]
    : ['display-message', '-p', '-t', target, COPY_MODE_FORMAT]
}

function visibleWheelBounds(fields: string[]) {
  if (fields.length !== 8) return
  const [left, top, width, height, offsetX, offsetY, cols, rows] = fields.map(Number)
  if (!fields.every((value, index) => /^\d+$/.test(value) || (value === '' && (index === 4 || index === 5)))) return
  if (!width || !height || !cols || !rows) return
  // tmux uses zero-based window coordinates; SGR uses one-based client cells.
  const firstCol = Math.max(0, left - offsetX) + 1
  const firstRow = Math.max(0, top - offsetY) + 1
  const lastCol = Math.min(cols, left + width - offsetX)
  const lastRow = Math.min(rows, top + height - offsetY)
  if (firstCol > lastCol || firstRow > lastRow) return null
  return { firstCol, firstRow, lastCol, lastRow }
}

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
    const [copy, alternate, mouse, ...geometry] = output.trim().split(',')
    const wheelBounds = visibleWheelBounds(geometry)
    return {
      inCopyMode: copy === '1',
      altScreen: alternate === '1',
      appMouse: mouse === '1',
      ...(wheelBounds !== undefined && { wheelBounds }),
    }
  }
}
