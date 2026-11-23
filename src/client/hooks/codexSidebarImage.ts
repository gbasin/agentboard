import type { IBufferLine, Terminal } from '@xterm/xterm'

const fallback = 'Image preview unavailable in this terminal'

function selectedTitle(line: IBufferLine | undefined, start: number) {
  if (!line) return null
  const tabs: { name: string; selected: boolean }[] = []
  let label = '', selected = false
  for (let col = start; col < line.length; col++) {
    const cell = line.getCell(col)
    const char = cell?.getChars() ?? ''
    if (char === '×') {
      tabs.push({ name: label.trim(), selected })
      label = ''
      selected = false
    } else {
      label += char || ' '
      if (char.trim() && cell?.isBold()) selected = true
    }
  }
  const candidates = tabs.length === 1 ? tabs : tabs.filter(tab => tab.selected)
  const name = candidates.length === 1 ? candidates[0].name : ''
  return !name.includes('…') && /\.(?:png|jpe?g|gif|webp)$/i.test(name) ? name : null
}

// Codex owns the pane, including tab selection, resize and Escape. Paint only
// its image body while the selected tab actually displays the graphics fallback.
function sidebar(terminal: Terminal) {
  const buffer = terminal.buffer.active
  const line = (row: number) => buffer.getLine(buffer.viewportY + row)
  for (let row = 1; row < Math.min(5, terminal.rows - 1); row++) {
    const metadata = line(row)
    if (!metadata?.translateToString(true).includes(' × ')) continue
    let start = 0
    for (let col = terminal.cols - 1; col >= 0; col--) {
      if (metadata.getCell(col)?.getChars() === '│') { start = col + 1; break }
    }
    const size = /^\s*(?:PNG|JPE?G|GIF|WEBP) · (\d+) × (\d+)\s*$/.exec(metadata.translateToString(true, start))
    const body = line(row + 1)?.translateToString(true, start).trim()
    if (!size || !body || body.length < 12 || !fallback.startsWith(body)) continue
    const name = selectedTitle(line(row - 1), start)
    if (name) return { name, width: Number(size[1]), height: Number(size[2]), start, top: row + 1 }
  }
  return null
}

export function installCodexSidebarImage(terminal: Terminal, conversation: () => string | null) {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) return () => {}
  let image: HTMLImageElement | undefined
  let key = ''
  const clear = () => { image?.remove(); image = undefined; key = '' }
  const update = () => {
    const id = conversation()
    const view = id && sidebar(terminal)
    if (!view) { clear(); return }
    const url = '/api/session-output/' + encodeURIComponent(id) + '/sidebar-image?name=' + encodeURIComponent(view.name)
    const identity = JSON.stringify([url, view.width, view.height])
    if (key !== identity) {
      clear()
      key = identity
      const img = document.createElement('img')
      image = img
      img.alt = view.name
      img.style.cssText = 'position:absolute;z-index:5;pointer-events:none;object-fit:contain;object-position:top left;visibility:hidden'
      img.onload = () => {
        if (image === img && img.naturalWidth === view.width && img.naturalHeight === view.height) img.style.visibility = 'visible'
      }
      img.src = url
      screen.appendChild(img)
    }
    if (!image) return
    image.style.backgroundColor = terminal.options.theme?.background || 'Canvas'
    image.style.left = (100 * view.start / terminal.cols) + '%'
    image.style.width = (100 * (terminal.cols - view.start) / terminal.cols) + '%'
    image.style.top = (100 * view.top / terminal.rows) + '%'
    image.style.height = (100 * Math.max(1, terminal.rows - view.top - 2) / terminal.rows) + '%'
  }
  const render = terminal.onRender(update)
  return () => { render.dispose(); clear() }
}
