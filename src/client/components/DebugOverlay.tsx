import { useEffect, useMemo, useState } from 'react'

type ViewportMetrics = {
  innerWidth: number
  innerHeight: number
  visualWidth: number | null
  visualHeight: number | null
  offsetTop: number | null
  offsetLeft: number | null
  scale: number | null
  keyboardVisibleClass: boolean
  activeElement: string
  cssVars: Record<string, string>
}

type HitInfo = {
  x: number
  y: number
  target: string
  rect: DOMRect | null
} | null

function readCssVars(): Record<string, string> {
  const root = document.documentElement
  const computed = window.getComputedStyle(root)
  const names = [
    '--keyboard-inset',
    '--viewport-offset-top',
    '--viewport-offset-left',
    '--visual-viewport-height',
    '--visual-viewport-width',
  ]
  const vars: Record<string, string> = {}
  for (const name of names) {
    vars[name] = computed.getPropertyValue(name).trim()
  }
  return vars
}

function getActiveElementLabel(): string {
  const active = document.activeElement
  if (!active) return 'none'
  const el = active as HTMLElement
  const name = el.tagName.toLowerCase()
  const id = el.id ? `#${el.id}` : ''
  const classes = el.className ? `.${String(el.className).trim().replace(/\s+/g, '.')}` : ''
  return `${name}${id}${classes}`
}

function getViewportMetrics(): ViewportMetrics {
  const vv = window.visualViewport
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visualWidth: vv ? vv.width : null,
    visualHeight: vv ? vv.height : null,
    offsetTop: vv ? vv.offsetTop : null,
    offsetLeft: vv ? vv.offsetLeft : null,
    scale: vv ? vv.scale : null,
    keyboardVisibleClass: document.documentElement.classList.contains('keyboard-visible'),
    activeElement: getActiveElementLabel(),
    cssVars: readCssVars(),
  }
}

function formatTarget(el: Element | null): string {
  if (!el) return 'none'
  const htmlEl = el as HTMLElement
  const name = htmlEl.tagName.toLowerCase()
  const id = htmlEl.id ? `#${htmlEl.id}` : ''
  const classes = htmlEl.className ? `.${String(htmlEl.className).trim().replace(/\s+/g, '.')}` : ''
  return `${name}${id}${classes}`
}

export default function DebugOverlay() {
  const [metrics, setMetrics] = useState<ViewportMetrics>(() => getViewportMetrics())
  const [hitInfo, setHitInfo] = useState<HitInfo>(null)

  useEffect(() => {
    const update = () => {
      setMetrics(getViewportMetrics())
    }

    const handleTouch = (event: TouchEvent) => {
      const touch = event.touches[0] ?? event.changedTouches[0]
      if (!touch) return
      const x = touch.clientX
      const y = touch.clientY
      const target = document.elementFromPoint(x, y)
      const rect = target ? target.getBoundingClientRect() : null
      setHitInfo({ x, y, target: formatTarget(target), rect })
    }

    const handlePointer = (event: PointerEvent) => {
      const x = event.clientX
      const y = event.clientY
      const target = document.elementFromPoint(x, y)
      const rect = target ? target.getBoundingClientRect() : null
      setHitInfo({ x, y, target: formatTarget(target), rect })
    }

    update()
    const vv = window.visualViewport
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.addEventListener('touchstart', handleTouch, { passive: true })
    window.addEventListener('pointerdown', handlePointer, { passive: true })

    return () => {
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.removeEventListener('touchstart', handleTouch)
      window.removeEventListener('pointerdown', handlePointer)
    }
  }, [])

  const hitStyle = useMemo(() => {
    if (!hitInfo) return { display: 'none' }
    return {
      position: 'fixed' as const,
      left: `${hitInfo.x}px`,
      top: `${hitInfo.y}px`,
      width: '12px',
      height: '12px',
      marginLeft: '-6px',
      marginTop: '-6px',
      borderRadius: '999px',
      background: 'rgba(255, 0, 0, 0.7)',
      zIndex: 9999,
      pointerEvents: 'none' as const,
    }
  }, [hitInfo])

  const rectStyle = useMemo(() => {
    if (!hitInfo?.rect) return { display: 'none' }
    const { rect } = hitInfo
    return {
      position: 'fixed' as const,
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      border: '1px solid rgba(0, 255, 255, 0.7)',
      zIndex: 9998,
      pointerEvents: 'none' as const,
    }
  }, [hitInfo])

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999, pointerEvents: 'none' }}>
      <div style={{ background: 'rgba(0, 0, 0, 0.7)', color: '#fff', fontSize: '11px', padding: '6px', lineHeight: 1.3 }}>
        <div>inner: {metrics.innerWidth}x{metrics.innerHeight}</div>
        <div>visual: {metrics.visualWidth ?? 'n/a'}x{metrics.visualHeight ?? 'n/a'} offset {metrics.offsetLeft ?? 'n/a'},{metrics.offsetTop ?? 'n/a'} scale {metrics.scale ?? 'n/a'}</div>
        <div>keyboard-visible: {String(metrics.keyboardVisibleClass)} active: {metrics.activeElement}</div>
        <div>vars: {Object.entries(metrics.cssVars).map(([k, v]) => `${k}=${v || 'unset'}`).join(' ')}</div>
        <div>hit: {hitInfo ? `${hitInfo.x},${hitInfo.y} -> ${hitInfo.target}` : 'none'}</div>
      </div>
      <div style={hitStyle} />
      <div style={rectStyle} />
    </div>
  )
}
