/**
 * terminalGeometry - measures the xterm grid so the "Select text" snapshot
 * layer can lay DOM text exactly over the terminal's rows and columns.
 */

import type { Terminal } from '@xterm/xterm'

export interface TerminalGeometry {
  left: number
  top: number
  width: number
  height: number
  cols: number
  cellWidth: number
  cellHeight: number
  fontSize: number
  fontFamily: string
}

/** Screen rect and cell metrics of the xterm grid, relative to its container. */
export function measureTerminalGeometry(container: HTMLElement, terminal: Terminal): TerminalGeometry | null {
  const screen = container.querySelector('.xterm-screen') as HTMLElement | null
  if (!screen || terminal.cols <= 0 || terminal.rows <= 0) return null
  const containerRect = container.getBoundingClientRect()
  const screenRect = screen.getBoundingClientRect()
  if (screenRect.width <= 0 || screenRect.height <= 0) return null
  return {
    left: screenRect.left - containerRect.left,
    top: screenRect.top - containerRect.top,
    width: screenRect.width,
    height: screenRect.height,
    cols: terminal.cols,
    cellWidth: screenRect.width / terminal.cols,
    cellHeight: screenRect.height / terminal.rows,
    fontSize: terminal.options.fontSize ?? 13,
    fontFamily: terminal.options.fontFamily ?? 'monospace',
  }
}

/** Letter-spacing that makes glyphs inside `element` advance one cell each. */
export function measureLetterSpacing(element: HTMLElement, cellWidth: number): number {
  const probe = document.createElement('span')
  probe.textContent = '0'.repeat(200)
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;letter-spacing:0px'
  element.appendChild(probe)
  const domCharWidth = probe.getBoundingClientRect().width / 200
  probe.remove()
  return domCharWidth > 0 ? Math.max(-2, Math.min(2, cellWidth - domCharWidth)) : 0
}
