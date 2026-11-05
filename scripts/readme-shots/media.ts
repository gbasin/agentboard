// media.ts - Draws the attachments shown in the media rail.
//
// The latency-report session "reads" charts and a PDF report. All of them are
// drawn here as SVG/HTML and rendered with Chromium, so no external image is
// ever embedded. Output: { name -> base64 } for the transcript writer.

import type { Browser } from '@playwright/test'

const W = 1200
const H = 720
const FONT = `font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;`

function frame(title: string, subtitle: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#fff;${FONT}">
  <div style="width:${W}px;height:${H}px;box-sizing:border-box;padding:48px 56px;">
    <div style="font-size:30px;font-weight:650;color:#111827">${title}</div>
    <div style="font-size:18px;color:#6b7280;margin-top:6px">${subtitle}</div>
    <svg width="${W - 112}" height="${H - 190}" style="margin-top:28px">${body}</svg>
  </div></body></html>`
}

function barChart(): string {
  const rows: [string, number, number][] = [
    ['GET /search', 410, 180], ['POST /checkout', 236, 228], ['GET /orders/:id', 148, 151],
    ['GET /users/:id', 92, 95], ['POST /auth/token', 71, 70], ['GET /health', 9, 9],
  ]
  const max = 450, x0 = 230, w = W - 112 - x0 - 40
  const bars = rows.map(([label, now, before], i) => {
    const y = 20 + i * 76
    const hot = now > before * 1.5
    return `<text x="${x0 - 16}" y="${y + 30}" text-anchor="end" font-size="19" fill="#374151">${label}</text>
      <rect x="${x0}" y="${y + 6}" width="${(before / max) * w}" height="16" rx="3" fill="#d1d5db"/>
      <rect x="${x0}" y="${y + 26}" width="${(now / max) * w}" height="22" rx="3" fill="${hot ? '#dc2626' : '#2563eb'}"/>
      <text x="${x0 + (now / max) * w + 10}" y="${y + 43}" font-size="17" fill="${hot ? '#dc2626' : '#374151'}" font-weight="${hot ? 700 : 400}">${now} ms</text>`
  }).join('')
  return frame('p95 latency by endpoint', 'Week 44 (blue/red) against week 43 (gray)', bars)
}

function trendChart(): string {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const search = [182, 176, 402, 415, 398, 380, 410]
  const checkout = [221, 230, 236, 229, 240, 226, 236]
  const w = W - 112, h = H - 190, left = 70, bottom = h - 50, top = 20
  const x = (i: number) => left + (i * (w - left - 30)) / 6
  const y = (v: number) => bottom - ((v - 100) / 350) * (bottom - top)
  const line = (vals: number[], color: string) =>
    `<polyline fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" points="${vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>` +
    vals.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="6" fill="${color}"/>`).join('')
  const grid = [150, 250, 350, 450].map((v) =>
    `<line x1="${left}" x2="${w - 20}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/><text x="${left - 12}" y="${y(v) + 6}" text-anchor="end" font-size="16" fill="#9ca3af">${v}</text>`).join('')
  const labels = days.map((d, i) => `<text x="${x(i)}" y="${bottom + 34}" text-anchor="middle" font-size="17" fill="#6b7280">${d}</text>`).join('')
  const marker = `<line x1="${x(1.5)}" x2="${x(1.5)}" y1="${top}" y2="${bottom}" stroke="#f59e0b" stroke-dasharray="6 6" stroke-width="2"/>
    <text x="${x(1.5) + 10}" y="${top + 18}" font-size="16" fill="#b45309">ranking v3 deployed</text>`
  const legend = `<rect x="${w - 330}" y="${bottom - 80}" width="14" height="14" fill="#dc2626"/><text x="${w - 308}" y="${bottom - 68}" font-size="16" fill="#374151">GET /search</text>
    <rect x="${w - 190}" y="${bottom - 80}" width="14" height="14" fill="#2563eb"/><text x="${w - 168}" y="${bottom - 68}" font-size="16" fill="#374151">POST /checkout</text>`
  return frame('p95 latency, last 7 days', 'Milliseconds, 5-minute buckets', grid + labels + marker + line(checkout, '#2563eb') + line(search, '#dc2626') + legend)
}

function flameGraph(): string {
  const palette = ['#f97316', '#fb923c', '#f59e0b', '#fbbf24', '#ef4444', '#f87171']
  const levels: [string, number, number][][] = [
    [['handleSearch', 0, 1]],
    [['parseQuery', 0, 0.08], ['rankResults', 0.08, 0.86], ['serialize', 0.86, 1]],
    [['tokenize', 0, 0.06], ['scoreCandidates', 0.08, 0.78], ['dedupe', 0.78, 0.86], ['toJSON', 0.86, 0.99]],
    [['embedQuery', 0.08, 0.2], ['cosineAll', 0.2, 0.74], ['sort', 0.74, 0.78]],
    [['loadVectors', 0.2, 0.62], ['dot', 0.62, 0.74]],
    [['JSON.parse', 0.2, 0.58]],
  ]
  const w = W - 112, rowH = 78, base = H - 190 - 10
  const rects = levels.flatMap((row, depth) => row.map(([name, a, b], i) => {
    const x = a * w, width = (b - a) * w - 3, y = base - (depth + 1) * rowH
    const color = palette[(depth + i) % palette.length]
    return `<rect x="${x}" y="${y}" width="${width}" height="${rowH - 4}" rx="3" fill="${color}"/>` +
      (width > 90 ? `<text x="${x + 12}" y="${y + 46}" font-size="22" fill="#1f2937">${name}</text>` : '')
  })).join('')
  return frame('CPU profile: GET /search', '72% of samples in rankResults → loadVectors', rects)
}

function reportHtml(chart: string): string {
  return `<!doctype html><html><body style="margin:0;${FONT};color:#111827">
  <div style="padding:56px 64px">
    <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">Platform team · Week 44</div>
    <h1 style="font-size:34px;margin:10px 0 18px">API latency report</h1>
    <p style="font-size:16px;line-height:1.6;color:#374151">p95 latency for <b>GET /search</b> rose from 180 ms to 410 ms after
    ranking v3 shipped on Tuesday. Every other endpoint stayed within 5% of the previous week.</p>
    <img src="data:image/png;base64,${chart}" style="width:100%;border:1px solid #e5e7eb;border-radius:8px;margin:12px 0 20px"/>
    <h2 style="font-size:20px;margin:0 0 8px">Cause</h2>
    <p style="font-size:16px;line-height:1.6;color:#374151">The new ranker loads all candidate vectors from JSON on each request.
    72% of CPU time is spent in <code>loadVectors</code>.</p>
    <h2 style="font-size:20px;margin:18px 0 8px">Recommendation</h2>
    <ul style="font-size:16px;line-height:1.7;color:#374151"><li>Cache decoded vectors per index version.</li>
    <li>Add a p95 budget alert for /search at 250 ms.</li></ul>
  </div></body></html>`
}

export interface MediaSet {
  images: { name: string; data: string; width: number; height: number }[]
  pdf: { name: string; data: string }
}

export async function drawMedia(browser: Browser): Promise<MediaSet> {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  const shot = async (html: string) => {
    await page.setContent(html)
    return (await page.screenshot({ type: 'png' })).toString('base64')
  }
  const images = [
    { name: 'p95-by-endpoint.png', data: await shot(barChart()), width: W, height: H },
    { name: 'p95-trend.png', data: await shot(trendChart()), width: W, height: H },
    { name: 'search-profile.png', data: await shot(flameGraph()), width: W, height: H },
  ]
  await page.setContent(reportHtml(images[1]!.data))
  const pdf = (await page.pdf({ format: 'A4', printBackground: true })).toString('base64')
  await page.close()
  return { images, pdf: { name: 'latency-week-44.pdf', data: pdf } }
}
