// media.ts - Draws the attachments shown in the media rail.
//
// Sessions "read" charts, diagrams, a UI mock and a PDF report. All of them
// are drawn here as SVG/HTML and rendered with Chromium, so no external image
// is ever embedded. Images are square with bold shapes: the rail shows them
// as small square thumbnails and they must stay recognisable there.

import type { Browser } from '@playwright/test'

const S = 900
const FONT = `font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;`

function frame(title: string, body: string, bg = '#ffffff'): string {
  return `<!doctype html><html><body style="margin:0;background:${bg};${FONT}">
  <div style="width:${S}px;height:${S}px;box-sizing:border-box;padding:56px;">
    <div style="font-size:40px;font-weight:700;color:#111827">${title}</div>
    <svg width="${S - 112}" height="${S - 180}" style="margin-top:28px">${body}</svg>
  </div></body></html>`
}

const AREA_W = S - 112
const AREA_H = S - 180

function barChart(): string {
  const rows: [string, number][] = [['/search', 410], ['/checkout', 236], ['/orders', 148], ['/users', 92], ['/auth', 71]]
  const x0 = 170, w = AREA_W - x0 - 100, h = 92
  return frame('p95 by endpoint', rows.map(([label, v], i) => {
    const y = 20 + i * (h + 44)
    const color = i === 0 ? '#dc2626' : '#2563eb'
    return `<text x="${x0 - 18}" y="${y + 58}" text-anchor="end" font-size="30" fill="#374151">${label}</text>
      <rect x="${x0}" y="${y}" width="${(v / 420) * w}" height="${h}" rx="8" fill="${color}"/>
      <text x="${x0 + (v / 420) * w + 14}" y="${y + 58}" font-size="28" font-weight="700" fill="${color}">${v}</text>`
  }).join(''))
}

function trendChart(): string {
  const search = [182, 176, 402, 415, 398, 380, 410]
  const checkout = [221, 230, 236, 229, 240, 226, 236]
  const x = (i: number) => 30 + (i * (AREA_W - 60)) / 6
  const y = (v: number) => AREA_H - 40 - ((v - 120) / 330) * (AREA_H - 80)
  const pts = (vals: number[]) => vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const area = `<polygon fill="#fee2e2" points="${x(0)},${AREA_H - 40} ${pts(search)} ${x(6)},${AREA_H - 40}"/>`
  const grid = [0, 1, 2, 3].map((i) => `<line x1="20" x2="${AREA_W - 20}" y1="${40 + i * (AREA_H - 80) / 3}" y2="${40 + i * (AREA_H - 80) / 3}" stroke="#e5e7eb" stroke-width="2"/>`).join('')
  return frame('p95 latency, 7 days', grid + area +
    `<polyline fill="none" stroke="#2563eb" stroke-width="12" stroke-linejoin="round" stroke-linecap="round" points="${pts(checkout)}"/>
     <polyline fill="none" stroke="#dc2626" stroke-width="14" stroke-linejoin="round" stroke-linecap="round" points="${pts(search)}"/>`)
}

function flameGraph(): string {
  const levels: [string, number, number, string][][] = [
    [['handleSearch', 0, 1, '#f97316']],
    [['rankResults', 0, 0.84, '#f59e0b'], ['serialize', 0.84, 1, '#fbbf24']],
    [['scoreCandidates', 0, 0.76, '#fbbf24'], ['dedupe', 0.76, 0.84, '#fb923c']],
    [['cosineAll', 0.06, 0.72, '#ef4444']],
    [['loadVectors', 0.06, 0.62, '#dc2626']],
    [['JSON.parse', 0.06, 0.56, '#f87171']],
  ]
  const rowH = 100
  return frame('CPU: GET /search', levels.flatMap((row, depth) => row.map(([name, a, b, color]) => {
    const x = a * AREA_W, w = (b - a) * AREA_W - 6, y = AREA_H - (depth + 1) * (rowH + 6)
    return `<rect x="${x}" y="${y}" width="${w}" height="${rowH}" rx="8" fill="${color}"/>` +
      (w > 200 ? `<text x="${x + 18}" y="${y + 62}" font-size="32" fill="#1f2937">${name}</text>` : '')
  })).join(''))
}

function searchMock(): string {
  const results = [0, 1, 2, 3].map((i) => `
    <rect x="0" y="${150 + i * 140}" width="${AREA_W}" height="116" rx="14" fill="#ffffff" stroke="#e5e7eb" stroke-width="3"/>
    <rect x="28" y="${178 + i * 140}" width="60" height="60" rx="10" fill="${['#bfdbfe', '#bbf7d0', '#fde68a', '#fbcfe8'][i]}"/>
    <rect x="112" y="${182 + i * 140}" width="${380 - i * 40}" height="22" rx="6" fill="#374151"/>
    <rect x="112" y="${220 + i * 140}" width="${520 - i * 30}" height="16" rx="6" fill="#d1d5db"/>`).join('')
  return frame('Search results', `
    <rect x="0" y="10" width="${AREA_W}" height="96" rx="48" fill="#ffffff" stroke="#2563eb" stroke-width="5"/>
    <circle cx="60" cy="58" r="18" fill="none" stroke="#2563eb" stroke-width="6"/>
    <rect x="100" y="46" width="300" height="24" rx="8" fill="#9ca3af"/>
    <rect x="${AREA_W - 190}" y="30" width="160" height="56" rx="28" fill="#dc2626"/>
    <text x="${AREA_W - 110}" y="68" text-anchor="middle" font-size="28" font-weight="700" fill="#fff">410 ms</text>` + results, '#f3f4f6')
}

function routeMap(): string {
  const box = (x: number, y: number, w: number, label: string, color: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="96" rx="14" fill="${color}"/>
     <text x="${x + w / 2}" y="${y + 60}" text-anchor="middle" font-size="32" font-weight="600" fill="#0f172a">${label}</text>`
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    `<path d="M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}" fill="none" stroke="#94a3b8" stroke-width="8"/>`
  const mid = AREA_W / 2
  return frame('Route tree', [
    line(mid, 116, 130, 300), line(mid, 116, mid, 300), line(mid, 116, AREA_W - 130, 300),
    line(130, 396, 130, 560), line(mid, 396, mid, 560), line(AREA_W - 130, 396, AREA_W - 130, 560),
    box(mid - 160, 20, 320, 'createRouter', '#c7d2fe'),
    box(10, 300, 240, '/users', '#bbf7d0'), box(mid - 120, 300, 240, '/orgs', '#fde68a'), box(AREA_W - 250, 300, 240, '/invoices', '#fde68a'),
    box(10, 560, 240, ':id', '#dcfce7'), box(mid - 120, 560, 240, 'members', '#fef3c7'), box(AREA_W - 250, 560, 240, ':id/pdf', '#fef3c7'),
  ].join(''))
}

function callers(): string {
  const nodes: [number, number, string, string][] = [
    [AREA_W / 2, AREA_H / 2, 'legacyChain', '#fca5a5'],
    [140, 140, 'users', '#bbf7d0'], [AREA_W - 140, 140, 'orgs', '#fde68a'],
    [140, AREA_H - 140, 'invoices', '#fde68a'], [AREA_W - 140, AREA_H - 140, 'auth', '#bfdbfe'],
  ]
  const [cx, cy] = nodes[0]!
  const edges = nodes.slice(1).map(([x, y]) => `<line x1="${x}" y1="${y}" x2="${cx}" y2="${cy}" stroke="#94a3b8" stroke-width="8"/>`).join('')
  const circles = nodes.map(([x, y, label, color], i) =>
    `<circle cx="${x}" cy="${y}" r="${i === 0 ? 150 : 105}" fill="${color}"/>
     <text x="${x}" y="${y + 12}" text-anchor="middle" font-size="${i === 0 ? 38 : 32}" font-weight="600" fill="#0f172a">${label}</text>`).join('')
  return frame('Who calls legacyChain', edges + circles)
}

function reportHtml(chart: string): string {
  return `<!doctype html><html><body style="margin:0;${FONT};color:#111827">
  <div style="padding:56px 64px">
    <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">Platform team · Week 44</div>
    <h1 style="font-size:34px;margin:10px 0 18px">API latency report</h1>
    <p style="font-size:16px;line-height:1.6;color:#374151">p95 latency for <b>GET /search</b> rose from 180 ms to 410 ms after
    ranking v3 shipped on Tuesday. Every other endpoint stayed within 5% of the previous week.</p>
    <img src="data:image/png;base64,${chart}" style="width:60%;border:1px solid #e5e7eb;border-radius:8px;margin:12px 0 20px"/>
    <h2 style="font-size:20px;margin:0 0 8px">Cause</h2>
    <p style="font-size:16px;line-height:1.6;color:#374151">The new ranker loads all candidate vectors from JSON on each request.
    72% of CPU time is spent in <code>loadVectors</code>.</p>
  </div></body></html>`
}

export interface MediaImage { name: string; data: string; width: number; height: number }
export interface MediaSet {
  images: MediaImage[]
  pdf: { name: string; data: string }
}

export async function drawMedia(browser: Browser): Promise<MediaSet> {
  const page = await browser.newPage({ viewport: { width: S, height: S }, deviceScaleFactor: 1 })
  const draw = async (name: string, html: string): Promise<MediaImage> => {
    await page.setContent(html)
    return { name, data: (await page.screenshot({ type: 'png' })).toString('base64'), width: S, height: S }
  }
  const images = [
    await draw('p95-by-endpoint.png', barChart()),
    await draw('p95-trend.png', trendChart()),
    await draw('search-profile.png', flameGraph()),
    await draw('search-results.png', searchMock()),
    await draw('route-map.png', routeMap()),
    await draw('legacy-callers.png', callers()),
  ]
  await page.setContent(reportHtml(images[1]!.data))
  const pdf = (await page.pdf({ format: 'A4', printBackground: true })).toString('base64')
  await page.close()
  return { images, pdf: { name: 'latency-week-44.pdf', data: pdf } }
}
