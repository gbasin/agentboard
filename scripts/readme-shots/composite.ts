// composite.ts - Turns raw captures into the published README images.
//
// Every image is laid out as HTML at its README display size and rendered by
// Chromium at 2x, so frames, crops and fades are code, never hand edits.
// Stills are encoded as WebP (cwebp), the status loop as a GIF (ffmpeg with
// a generated palette).
//
//   hero.webp        desktop window frame + phone showing the same session
//   status-loop.gif  a session going to "needs permission" and back
//   pull-requests.webp, media-rail.webp, history.webp, hosts.webp
//   phone.webp       three phone screens at equal height

import { chromium, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP, PHONE, type Box, type Crops } from './capture'

const FEATURE_WIDTH = 520
const BG = '#fafafa'
const BORDER = '#d0d7de'

type Fade = 'left' | 'right' | 'bottom'

const dataUrl = (file: string) => `data:image/png;base64,${readFileSync(file).toString('base64')}`

const page = (body: string, width: number) => `<!doctype html><html><head><style>
  html, body { margin: 0; background: transparent; }
  body { width: ${width}px; }
  .crop { position: relative; overflow: hidden; border: 1px solid ${BORDER}; border-radius: 10px; background: ${BG}; }
  .crop img { position: absolute; display: block; }
  .fade { position: absolute; pointer-events: none; }
  .fade.right { top: 0; bottom: 0; right: 0; width: 64px; background: linear-gradient(to right, transparent, ${BG}); }
  .fade.left { top: 0; bottom: 0; left: 0; width: 64px; background: linear-gradient(to left, transparent, ${BG}); }
  .fade.bottom { left: 0; right: 0; bottom: 0; height: 48px; background: linear-gradient(to bottom, transparent, ${BG}); }
</style></head><body>${body}</body></html>`

/** A region of a full-viewport capture, scaled to `width` CSS px, with fades on cut edges. */
function cropHtml(src: string, viewport: { width: number }, box: Box, width: number, fades: Fade[], radius = 10): string {
  const scale = width / box.width
  const height = Math.round(box.height * scale)
  return `<div class="crop" style="width:${width}px;height:${height}px;border-radius:${radius}px">
    <img src="${src}" style="width:${viewport.width * scale}px;left:${-box.x * scale}px;top:${-box.y * scale}px">
    ${fades.map((f) => `<div class="fade ${f}"></div>`).join('')}
  </div>`
}

function phoneHtml(src: string, width: number): string {
  const bezel = Math.round(width * 0.035)
  const inner = width - bezel * 2
  const radius = Math.round(width * 0.13)
  return `<div style="width:${width}px;padding:${bezel}px;box-sizing:border-box;background:#16181d;border-radius:${radius}px;
      box-shadow:0 18px 40px rgba(15,23,42,.28),0 2px 6px rgba(15,23,42,.18)">
    <img src="${src}" style="display:block;width:${inner}px;height:${Math.round(inner * PHONE.height / PHONE.width)}px;border-radius:${radius - bezel}px">
  </div>`
}

async function render(p: Page, html: string, width: number, file: string, transparent = true): Promise<void> {
  await p.setViewportSize({ width, height: 400 })
  await p.setContent(html)
  await p.evaluate(() => Promise.all([...document.images].map((img) => img.decode())))
  const body = await p.locator('body').boundingBox()
  await p.setViewportSize({ width, height: Math.ceil(body!.height) })
  await p.screenshot({ path: file, omitBackground: transparent, fullPage: true })
}

function webp(png: string, out: string, quality: number): void {
  const result = spawnSync('cwebp', ['-quiet', '-q', String(quality), '-alpha_q', '100', '-m', '6', '-sharp_yuv', png, '-o', out])
  if (result.status !== 0) throw new Error(`cwebp failed: ${result.stderr}`)
  rmSync(png)
}

const hero = (raw: string) => {
  const width = 880
  const winWidth = 760
  const winHeight = Math.round(winWidth * DESKTOP.height / DESKTOP.width)
  const phoneWidth = 176
  return page(`<div style="position:relative;width:${width}px;height:${winHeight + 28 + 24 + 64}px">
    <div style="position:absolute;left:8px;top:8px;width:${winWidth}px;border-radius:12px;overflow:hidden;background:#fff;
        border:1px solid rgba(15,23,42,.14);box-shadow:0 22px 48px rgba(15,23,42,.18),0 3px 10px rgba(15,23,42,.10)">
      <div style="height:28px;display:flex;align-items:center;gap:7px;padding-left:12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb">
        <span style="width:11px;height:11px;border-radius:50%;background:#d4d4d8"></span>
        <span style="width:11px;height:11px;border-radius:50%;background:#d4d4d8"></span>
        <span style="width:11px;height:11px;border-radius:50%;background:#d4d4d8"></span>
      </div>
      <img src="${dataUrl(join(raw, 'desktop-hero.png'))}" style="display:block;width:${winWidth}px;height:${winHeight}px">
    </div>
    <div style="position:absolute;right:16px;bottom:8px">${phoneHtml(dataUrl(join(raw, 'phone-hero.png')), phoneWidth)}</div>
  </div>`, width)
}

const phones = (raw: string) => {
  const width = 880
  const phone = 262
  const shots = ['phone-drawer', 'phone-keys', 'phone-paste']
  return page(`<div style="display:flex;justify-content:space-between;padding:4px 18px 40px">
    ${shots.map((s) => phoneHtml(dataUrl(join(raw, `${s}.png`)), phone)).join('')}
  </div>`, width)
}

function padBox(b: Box, pad: number): Box {
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
}

async function gif(p: Page, frames: { file: string; ms: number }[], viewport: { width: number }, out: string, tmp: string): Promise<void> {
  // Frame each capture like the stills, then let ffmpeg build one palette.
  const list: string[] = []
  const box = { x: 0, y: 0, width: viewport.width, height: Math.round(viewport.width * 540 / 860) }
  for (const [i, frame] of frames.entries()) {
    const png = join(tmp, `gif-${String(i).padStart(3, '0')}.png`)
    await p.setViewportSize({ width: FEATURE_WIDTH, height: 400 })
    await p.setContent(page(cropHtml(dataUrl(frame.file), viewport, box, FEATURE_WIDTH, [], 0), FEATURE_WIDTH))
    await p.evaluate(() => Promise.all([...document.images].map((img) => img.decode())))
    const body = await p.locator('body').boundingBox()
    await p.setViewportSize({ width: FEATURE_WIDTH, height: Math.ceil(body!.height) })
    await p.screenshot({ path: png })
    const next = frames[i + 1]?.ms ?? frame.ms + 120
    list.push(`file '${png}'`, `duration ${((next - frame.ms) / 1000).toFixed(3)}`)
  }
  list.push(list[list.length - 2]!)
  const concat = join(tmp, 'frames.txt')
  writeFileSync(concat, list.join('\n') + '\n')
  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
    '-vf', 'fps=8,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    '-loop', '0', out])
  if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.stderr}`)
}

export async function compose(opts: { raw: string; out: string; crops: Crops; frames: { file: string; ms: number }[] }): Promise<void> {
  const { raw, out } = opts
  const browser = await chromium.launch()
  const p = await browser.newPage({ deviceScaleFactor: 2 })
  const still = async (name: string, html: string, width: number, quality = 88) => {
    const png = join(raw, `${name}.composite.png`)
    await render(p, html, width, png)
    webp(png, join(out, `${name}.webp`), quality)
  }
  const shot = (name: string) => dataUrl(join(raw, `${name}.png`))
  const feature = (name: string, box: Box, fades: Fade[], source = `desktop-${name}`) =>
    still(name, page(cropHtml(shot(source), DESKTOP, box, FEATURE_WIDTH, fades), FEATURE_WIDTH), FEATURE_WIDTH)

  await still('hero', hero(raw), 880)
  await still('phone', phones(raw), 880)
  await feature('pull-requests', { x: 0, y: 0, width: 600, height: 540 }, ['right'])
  await feature('media-rail', opts.crops.lightbox!, [], 'desktop-lightbox')
  await feature('history', padBox(opts.crops.preview!, 28), [])
  await feature('hosts', { x: 0, y: 0, width: 640, height: 440 }, ['right', 'bottom'])

  const gifPage = await browser.newPage({ deviceScaleFactor: 2 })
  await gif(gifPage, opts.frames, { width: 860 }, join(out, 'status-loop.gif'), raw)
  await browser.close()

  for (const name of ['hero.webp', 'phone.webp', 'pull-requests.webp', 'media-rail.webp', 'history.webp', 'hosts.webp', 'status-loop.gif']) {
    console.log(`  ${name.padEnd(20)} ${(statSync(join(out, name)).size / 1024).toFixed(0)} KB`)
  }
}
