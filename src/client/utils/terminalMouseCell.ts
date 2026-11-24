type TerminalDimensions = { cols: number; rows: number }
type PointerPosition = { clientX: number; clientY: number }

export function terminalMouseCell(container: HTMLElement, terminal: TerminalDimensions, point: PointerPosition) {
  const screen = container.querySelector('.xterm')?.querySelector('.xterm-screen')
  const rect = screen?.getBoundingClientRect()
  if (!rect || rect.width <= 0 || rect.height <= 0 || terminal.cols <= 0 || terminal.rows <= 0) return null
  return {
    col: Math.min(terminal.cols, Math.max(1, Math.floor((point.clientX - rect.left) * terminal.cols / rect.width) + 1)),
    row: Math.min(terminal.rows, Math.max(1, Math.floor((point.clientY - rect.top) * terminal.rows / rect.height) + 1)),
  }
}
