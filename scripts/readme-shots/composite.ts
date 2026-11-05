// composite.ts - Turns raw captures into the published README images.
//
// Every image is laid out as HTML at its README display width (880 or 520 CSS
// px) and rendered by Chromium at 2x, so frames, crops and fades are code,
// never hand edits. Crops are chosen so the UI shows at roughly 1:1 or
// larger at display width. Stills are WebP (cwebp), the loop a GIF (ffmpeg).
// Frames use thin borders instead of large blurred shadows, so the images
// sit cleanly on both GitHub's white and #0d1117 backgrounds.

import { chromium, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname as dirnameOf, join } from 'node:path'
import { FEATURE, HERO, LOOP, PHONE, type Box, type Crops, type Metrics } from './capture'
import { LAUNCH } from './instance'

const WIDE = 880
const FEATURE_WIDTH = 520
const BG = '#fafafa'
const BORDER = '#d0d7de'

type Fade = 'left' | 'right' | 'bottom'

/** Images load from disk: the layout page itself is a file in the raw dir. */
const dataUrl = (file: string) => `file://${file}`
let pageCounter = 0
/** Loads layout HTML from a file next to the captures (data URLs of MB-sized PNGs stall setContent). */
async function load(p: Page, html: string, dir: string): Promise<void> {
  const file = join(dir, `layout-${pageCounter++}.html`)
  writeFileSync(file, html)
  await p.goto(`file://${file}`)
}

const page = (body: string, width: number) => `<!doctype html><html><head><style>
  html, body { margin: 0; background: transparent; }
  body { width: ${width}px; }
  .crop { position: relative; overflow: hidden; box-sizing: border-box; border: 1px solid ${BORDER}; border-radius: 10px; background: ${BG}; }
  .crop img { position: absolute; display: block; }
  .fade { position: absolute; pointer-events: none; }
  .fade.right { top: 0; bottom: 0; right: 0; width: 56px; background: linear-gradient(to right, rgba(250,250,250,0), ${BG}); }
  .fade.left { top: 0; bottom: 0; left: 0; width: 56px; background: linear-gradient(to left, rgba(250,250,250,0), ${BG}); }
  .fade.bottom { left: 0; right: 0; bottom: 0; height: 40px; background: linear-gradient(to bottom, rgba(250,250,250,0), ${BG}); }
</style></head><body>${body}</body></html>`

/** A region of a capture, scaled to `width` CSS px, with fades on cut edges. */
function cropHtml(src: string, viewport: { width: number }, box: Box, width: number, fades: Fade[], radius = 10): string {
  const scale = width / box.width
  const height = Math.round(box.height * scale)
  return `<div class="crop" style="width:${width}px;height:${height}px;border-radius:${radius}px">
    <img src="${src}" style="width:${viewport.width * scale}px;left:${-box.x * scale}px;top:${-box.y * scale}px">
    ${fades.map((f) => `<div class="fade ${f}"></div>`).join('')}
  </div>`
}

/** A plain dark bezel; a 1px lighter edge keeps it distinct on dark pages. */
function phoneHtml(src: string, width: number): string {
  const bezel = Math.round(width * 0.03)
  const inner = width - bezel * 2
  const radius = Math.round(width * 0.12)
  return `<div style="width:${width}px;padding:${bezel}px;box-sizing:border-box;background:#1f2328;border-radius:${radius}px;
      box-shadow:0 0 0 1px #4b5563, 0 2px 6px rgba(15,23,42,.12)">
    <img src="${src}" style="display:block;width:${inner}px;height:${Math.round(inner * PHONE.height / PHONE.width)}px;border-radius:${radius - bezel}px">
  </div>`
}

async function render(p: Page, html: string, width: number, file: string): Promise<void> {
  await p.setViewportSize({ width, height: 400 })
  await load(p, html, dirnameOf(file))
  await p.evaluate(() => Promise.all([...document.images].map((img) => img.decode())))
  const body = await p.locator('body').boundingBox()
  await p.setViewportSize({ width, height: Math.ceil(body!.height) })
  await p.screenshot({ path: file, omitBackground: true, fullPage: true })
}

function webp(png: string, out: string, quality: number): void {
  const result = spawnSync('cwebp', ['-quiet', '-q', String(quality), '-alpha_q', '100', '-m', '6', '-sharp_yuv', png, '-o', out])
  if (result.status !== 0) throw new Error(`cwebp failed: ${result.stderr}`)
  rmSync(png)
}

// Hero geometry: the window spans almost the full width so the sidebar shows
// at ~0.9x; the phone (31% of the width) overlaps its lower right corner.
const HERO_WINDOW = WIDE - 4
const HERO_PHONE = 272
const HERO_PHONE_TOP = 150
const heroScale = HERO_WINDOW / HERO.width

function hero(raw: string): string {
  const winHeight = Math.round(HERO_WINDOW * HERO.height / HERO.width)
  const phoneHeight = Math.round((HERO_PHONE - 2 * Math.round(HERO_PHONE * 0.03)) * PHONE.height / PHONE.width) + 2 * Math.round(HERO_PHONE * 0.03)
  return page(`<div style="position:relative;width:${WIDE}px;height:${HERO_PHONE_TOP + phoneHeight + 4}px">
    <div style="position:absolute;left:2px;top:2px;width:${HERO_WINDOW}px;border-radius:10px;overflow:hidden;background:#fff;
        box-shadow:0 0 0 1px rgba(15,23,42,.18), 0 1px 3px rgba(15,23,42,.08)">
      <div style="height:24px;display:flex;align-items:center;gap:6px;padding-left:11px;background:#f3f4f6;border-bottom:1px solid #e5e7eb">
        <span style="width:10px;height:10px;border-radius:50%;background:#d4d4d8"></span>
        <span style="width:10px;height:10px;border-radius:50%;background:#d4d4d8"></span>
        <span style="width:10px;height:10px;border-radius:50%;background:#d4d4d8"></span>
      </div>
      <img src="${dataUrl(join(raw, 'desktop-hero.png'))}" style="display:block;width:${HERO_WINDOW}px;height:${winHeight}px">
    </div>
    <div style="position:absolute;right:3px;top:${HERO_PHONE_TOP}px">${phoneHtml(dataUrl(join(raw, 'phone-hero.png')), HERO_PHONE)}</div>
  </div>`, WIDE)
}

const PHONES_ROW = 262

function phones(raw: string): string {
  const shots = ['phone-drawer', 'phone-keys', 'phone-paste']
  return page(`<div style="display:flex;justify-content:space-between;padding:2px 22px 4px">
    ${shots.map((s) => phoneHtml(dataUrl(join(raw, `${s}.png`)), PHONES_ROW)).join('')}
  </div>`, WIDE)
}

async function gif(p: Page, frames: { file: string; ms: number }[], crop: Box, out: string, tmp: string): Promise<void> {
  // Frame each capture like the stills, then let ffmpeg build one palette.
  const list: string[] = []
  for (const [i, frame] of frames.entries()) {
    const png = join(tmp, `gif-${String(i).padStart(3, '0')}.png`)
    await p.setViewportSize({ width: FEATURE_WIDTH, height: 400 })
    await load(p, page(cropHtml(dataUrl(frame.file), LOOP, crop, FEATURE_WIDTH, ['right'], 0), FEATURE_WIDTH), tmp)
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

export interface ComposeInput {
  raw: string
  out: string
  crops: Crops
  metrics: Metrics
  frames: { file: string; ms: number }[]
  loopCrop: Box
}

export async function compose(opts: ComposeInput): Promise<void> {
  const { raw, out, crops } = opts
  const browser = await chromium.launch(LAUNCH)
  const still = async (name: string, html: string, width: number, quality = 90) => {
    const png = join(raw, `${name}.composite.png`)
    // A fresh page per image, and one retry: an occasional headless page
    // never fires its load event right after the capture browsers exit.
    for (let attempt = 1; ; attempt++) {
      const p = await browser.newPage({ deviceScaleFactor: 2 })
      p.setDefaultTimeout(20_000)
      try {
        await render(p, html, width, png)
        break
      } catch (error) {
        if (attempt >= 3) throw error
        console.warn(`  ${name}: render attempt ${attempt} failed, retrying`)
      } finally {
        await p.close().catch(() => {})
      }
    }
    webp(png, join(out, `${name}.webp`), quality)
  }
  const scales: Record<string, number> = {}
  const feature = async (name: string, box: Box, fades: Fade[] = [], source = `desktop-${name}`, viewport = FEATURE) => {
    scales[name] = FEATURE_WIDTH / box.width
    await still(name, page(cropHtml(dataUrl(join(raw, `${source}.png`)), viewport, box, FEATURE_WIDTH, fades), FEATURE_WIDTH), FEATURE_WIDTH)
  }

  await still('hero', hero(raw), WIDE)
  await still('phone', phones(raw), WIDE)
  await feature('pull-requests', crops['pull-requests']!)
  await feature('hosts', crops.hosts!)
  await feature('subagents', crops.subagents!, [], 'phone-subagents', PHONE)
  await feature('media-rail', crops['media-rail']!, ['bottom'], 'phone-media', PHONE)
  await feature('history', crops.history!)

  const gifPage = await browser.newPage({ deviceScaleFactor: 2 })
  await gif(gifPage, opts.frames, opts.loopCrop, join(out, 'status-loop.gif'), raw)
  scales['status-loop'] = FEATURE_WIDTH / opts.loopCrop.width
  await browser.close()

  // Effective displayed sizes (CSS font size x display scale), for review.
  const m = opts.metrics
  const phoneScale = (HERO_PHONE - 2 * Math.round(HERO_PHONE * 0.03)) / PHONE.width
  console.log(`  hero window ${heroScale.toFixed(2)}x: session name ${(m.sessionName * heroScale).toFixed(1)}px, prompt ${(m.lastPrompt * heroScale).toFixed(1)}px, terminal ${(m.terminal * heroScale).toFixed(1)}px; phone ${phoneScale.toFixed(2)}x: terminal ${(15 * phoneScale).toFixed(1)}px`)
  for (const [name, s] of Object.entries(scales)) {
    console.log(`  ${name} ${s.toFixed(2)}x: session name ${(m.sessionName * s).toFixed(1)}px, prompt ${(m.lastPrompt * s).toFixed(1)}px, terminal ${(m.terminal * s).toFixed(1)}px`)
  }
  for (const name of ['hero.webp', 'phone.webp', 'subagents.webp', 'pull-requests.webp', 'media-rail.webp', 'history.webp', 'hosts.webp', 'status-loop.gif']) {
    console.log(`  ${name.padEnd(20)} ${(statSync(join(out, name)).size / 1024).toFixed(0)} KB`)
  }
}
