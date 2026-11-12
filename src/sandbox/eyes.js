// «Глаза» агента: /selftest, /view, /compare, /frames, /sheet.
// Агент, который умеет только читать текст по GET, получает здесь ДВА канала:
//   1) URL готовой картинки (склейка/наложение/diff) — для ИИ, умеющих открывать изображения;
//   2) подробный ТЕКСТОВЫЙ разбор той же картинки (палитра, фигуры с пропорциями, карта, где и чем отличаются).
// Тяжёлая работа с пикселями идёт внутри headless-Chromium (canvas) -> ни sharp, ни ImageMagick не нужны.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { sniffImage, fmtBytes, fmtAnalysis, verdict } from './vision.js'

const MIME = { PNG: 'image/png', JPEG: 'image/jpeg', GIF: 'image/gif', WEBP: 'image/webp', SVG: 'image/svg+xml' }
const VIDEO_RE = /\.(mp4|mov|webm|mkv|avi|m4v|gif|apng)$/i
export const isVideoName = (n) => VIDEO_RE.test(String(n || ''))

const run = (cmd, args, ms = 60000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: ms, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, code: err && err.code, stdout: String(stdout || ''), stderr: String(stderr || ''), err }))
})

export function createEyes({ SHOTS, safe, relOf, getBrowser, PORT, token }) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const uid = (() => { let n = 0; return () => `${Date.now()}${String(++n % 100).padStart(2, '0')}` })()

  // ---------- источники картинок ----------
  // spec: "/путь/в/workspace.png" | "http(s)://..." | "s123.png" / "shot:s123.png" (скриншот из /shots) | "port:8000/path" не поддерживается
  async function loadSrc(spec) {
    spec = String(spec || '').trim()
    if (!spec) throw new Error('image source is empty (pass file=/path/to/img.png or url=https://...)')
    let buf, name
    if (/^https?:\/\//i.test(spec)) {
      // свои же URL (…/agent/<token>/shots/x.png, …/files/x.png) читаем напрямую с диска
      const u = new URL(spec)
      const mm = u.pathname.match(/\/agent\/[^/]+\/(shots|files)\/(.+)$/)
      if (mm && /^(127\.0\.0\.1|localhost)$/.test(u.hostname) === false && mm[1] === 'shots') { buf = await fsp.readFile(path.join(SHOTS, path.basename(decodeURIComponent(mm[2])))); name = path.basename(mm[2]) }
      else {
        const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000)
        const r = await fetch(spec, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 sandbox-agent' } }).catch((e) => { throw new Error('cannot download ' + spec + ': ' + e.message) })
        clearTimeout(to)
        if (!r.ok) throw new Error(`cannot download ${spec}: HTTP ${r.status}`)
        buf = Buffer.from(await r.arrayBuffer()); name = decodeURIComponent(path.basename(u.pathname)) || 'image'
      }
    } else if (/^(shot:)?s\d+\.png$/i.test(spec) || /^[vcfgm]\d+[\w.-]*\.(png|jpg)$/i.test(spec.replace(/^shot:/, ''))) {
      const n = path.basename(spec.replace(/^shot:/, ''))
      buf = await fsp.readFile(path.join(SHOTS, n)); name = n
    } else {
      const abs = safe(spec)
      buf = await fsp.readFile(abs); name = path.basename(abs)
    }
    const info = sniffImage(buf)
    if (!info) throw new Error(`"${name}" is not a PNG/JPEG/GIF/WEBP/SVG image (${buf.length} B). If it is a video use /frames; if a PDF - render it first: exec?cmd=pdftoppm -png -r 80 file.pdf out`)
    return { buf, name, info, mime: MIME[info.type], url: `data:${MIME[info.type]};base64,${buf.toString('base64')}` }
  }

  // сохранить dataURL из лаборатории в SHOTS, вернуть имя файла
  async function saveImage(dataUrl, prefix) {
    const m = String(dataUrl).match(/^data:image\/(png|jpeg);base64,(.+)$/)
    if (!m) throw new Error('lab returned a bad image')
    const name = `${prefix}${uid()}.${m[1] === 'jpeg' ? 'jpg' : 'png'}`
    await fsp.writeFile(path.join(SHOTS, name), Buffer.from(m[2], 'base64'))
    return name
  }
  function prune() {
    try {
      const files = fs.readdirSync(SHOTS).filter((f) => /\.(png|jpg)$/i.test(f)).map((f) => ({ f, t: fs.statSync(path.join(SHOTS, f)).mtimeMs })).sort((a, b) => a.t - b.t)
      for (const x of files.slice(0, Math.max(0, files.length - 200))) fs.rmSync(path.join(SHOTS, x.f), { force: true })
    } catch {}
  }

  async function lab(job) {
    const B = await getBrowser()
    const r = await B.locked(() => B.lab(job), 90000, 'image lab')
    return r
  }

  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== undefined && v !== '' ? n : d }
  // crop="x,y,w,h" (px или %), либо x=&y=&w=&h= не используем: w/h уже заняты viewport-ом
  function parseCrop(s, dims) {
    if (!s) return null
    const parts = String(s).split(/[,\s;x]+/).filter(Boolean)
    if (parts.length !== 4) throw new Error('crop must be x,y,w,h (pixels of the SOURCE image, or percents like 10%,20%,50%,40%)')
    return parts.map((v, i) => {
      if (/%$/.test(v)) { if (!dims || !dims.w) throw new Error('percent crop needs known image size'); return (parseFloat(v) / 100) * (i % 2 === 0 ? dims.w : dims.h) }
      return parseFloat(v)
    })
  }

  const urlOf = (base, n) => `${base}/shots/${n}`
  const diskOf = (n) => path.join(SHOTS, n)
  // одна короткая строка: КАК реально увидеть картинку (URL + файл на диске для инструмента чтения изображений)
  const seeLine = (base, n) => `SEE IT: open ${urlOf(base, n)}  or read the file ${diskOf(n)} with your image-viewing tool`
  const READ_HINT = (base) => `HOW TO USE: if you can open images, open the IMAGE URL(s) above. If you can only read text, the sections above (PALETTE / SHAPES / TEXT MAP / DIFF GRID) ARE the picture:\n  - zoom: ${base}/view?file=<same>&crop=x,y,w,h   (coordinates are source pixels; add &grid=50 to draw labeled coordinate lines)`

  // ---------- /view ----------
  async function view(p, base) {
    const src = await loadSrc(p.file || p.url || p.src || p.img)
    const crop = parseCrop(p.crop, src.info)
    const o = { crop, grid: num(p.grid, 0) || 0, maxw: num(p.maxw, 1400), fmt: p.fmt === 'jpeg' || p.fmt === 'jpg' ? 'jpeg' : 'png', colors: num(p.colors, 10), cols: num(p.cols, 0) || undefined, analyze: p.analyze !== '0' }
    const r = await lab({ op: 'process', imgs: [{ name: src.name, url: src.url }], o })
    const name = await saveImage(r.images[0].url, 'v'); prune()
    const L = []
    L.push(`IMAGE: ${src.name}  ${r.srcW}x${r.srcH}  ${src.info.type}  ${fmtBytes(src.buf.length)}`)
    if (r.crop) L.push(`CROP: x=${r.crop[0]} y=${r.crop[1]} w=${r.crop[2]} h=${r.crop[3]}  (shown at x${r.scale.toFixed(2)}${o.grid ? `, grid every ${o.grid}px - labels are SOURCE pixel coordinates` : ''})`)
    else if (o.grid) L.push(`GRID: lines labeled with SOURCE pixel coordinates`)
    L.push(`IMAGE URL (png, ${r.images[0].w}x${r.images[0].h}): ${urlOf(base, name)}`)
    L.push(seeLine(base, name))
    if (r.an) L.push(fmtAnalysis(r.an, { ox: r.crop ? r.crop[0] : 0, oy: r.crop ? r.crop[1] : 0 }))
    if (p.ocr === '1') L.push(await ocr(path.join(SHOTS, name)))
    L.push(READ_HINT(base))
    return { text: L.join('\n'), names: [name], extra: { w: r.srcW, h: r.srcH } }
  }

  async function ocr(file) {
    const t = await run('tesseract', [file, 'stdout', '-l', 'eng+rus', '--psm', '6'], 40000)
    if (!t.ok && /ENOENT/.test(String(t.err && t.err.code))) return 'OCR: tesseract is not installed (sudo apt-get install -y tesseract-ocr tesseract-ocr-rus)'
    const r2 = t.ok ? t : await run('tesseract', [file, 'stdout', '--psm', '6'], 40000)
    return 'OCR TEXT (tesseract):\n' + (r2.stdout.trim().split('\n').map((l) => '  ' + l).join('\n') || '  (no text found)')
  }

  // ---------- /compare ----------
  async function compare(p, base) {
    if (p.mode === 'style') return style(p, base)
    const aS = p.a || p.file || p.file1 || p.img1, bS = p.b || p.file2 || p.url2 || p.img2 || p.url
    if (!aS || !bS) throw new Error('need two images: compare?a=/ref.png&b=/mine.png   (a,b = workspace path | https URL | screenshot name like s123.png)')
    const [A, B] = await Promise.all([loadSrc(aS), loadSrc(bS)])
    const crop = parseCrop(p.crop, A.info)
    const o = { mode: ['all', 'side', 'overlay', 'diff'].includes(p.mode) ? p.mode : 'all', thr: num(p.thr, 24), alpha: num(p.alpha, 0.5), cap: num(p.cap, 1400), fmt: p.fmt === 'jpeg' ? 'jpeg' : 'png' }
    let imgs = [{ name: A.name, url: A.url }, { name: B.name, url: B.url }]
    if (crop) {
      // сравнение области: вырезаем одинаковую область из обеих (B растягивается под A, поэтому масштабируем координаты)
      const cut = async (S, c) => { const rr = await lab({ op: 'process', imgs: [{ name: S.name, url: S.url }], o: { crop: c, maxw: 4000, analyze: false } }); return rr.images[0].url }
      const kx = B.info.w && A.info.w ? B.info.w / A.info.w : 1, ky = B.info.h && A.info.h ? B.info.h / A.info.h : 1
      const [ua, ub] = [await cut(A, crop), await cut(B, [crop[0] * kx, crop[1] * ky, crop[2] * kx, crop[3] * ky])]
      imgs = [{ name: A.name + ' [crop]', url: ua }, { name: B.name + ' [crop]', url: ub }]
    }
    const r = await lab({ op: 'compare', imgs, o })
    const names = []
    for (const im of r.images) { names.push({ label: im.label, name: await saveImage(im.url, 'c') }) }
    prune()
    const L = []
    L.push(`COMPARE  A = ${A.name} (${A.info.w || '?'}x${A.info.h || '?'})   B = ${B.name} (${B.info.w || '?'}x${B.info.h || '?'})${crop ? `   region x=${crop.map(Math.round).join(',')}` : ''}`)
    if (A.info.w && B.info.w && (A.info.w !== B.info.w || A.info.h !== B.info.h)) {
      const ra = A.info.w / A.info.h, rb = B.info.w / B.info.h
      L.push(`NOTE: sizes differ - B is stretched to A for comparison.${Math.abs(ra - rb) / ra > 0.02 ? ` ASPECT RATIOS DIFFER (A ${ra.toFixed(3)} vs B ${rb.toFixed(3)}) - proportions are wrong, fix this first.` : ' Aspect ratios match.'}`)
    }
    L.push(`VERDICT: ${verdict(r.pctDiff)}`)
    L.push(`  different pixels: ${r.pctDiff}%   mean abs error: ${r.mae}%   brightness correlation: ${r.corr} (1.0 = same structure)   (threshold ${o.thr}/255 per channel)`)
    L.push('DIFF GRID 12x8 (each char = one cell of the picture; "." = same, digit = share of changed pixels: 1 => 10%, 9 => 90%+; row 1 = top):')
    L.push(r.grid.map((g, i) => `  ${i + 1}|${g}|`).join('\n'))
    if (r.clusters.length) {
      L.push('WHERE THEY DIFFER (biggest regions first; coordinates in A pixels; "A color -> B color" = average color of changed pixels):')
      r.clusters.forEach((c, i) => L.push(`  ${i + 1}. x=${c.x} y=${c.y} w=${c.w} h=${c.h}  ${c.pct}% of the area changed   A ${c.a} -> B ${c.b}`))
      L.push(`  zoom into one: ${base}/compare?a=${encodeURIComponent(aS)}&b=${encodeURIComponent(bS)}&crop=${r.clusters[0].x},${r.clusters[0].y},${r.clusters[0].w},${r.clusters[0].h}`)
    } else L.push('WHERE THEY DIFFER: nowhere above the threshold')
    L.push('IMAGES:')
    names.forEach((n) => L.push(`  ${n.label}: ${urlOf(base, n.name)}`))
    if (names[0]) L.push(seeLine(base, names[0].name))
    L.push('--- A (reference) ---'); L.push(fmtAnalysis(r.anA, { mapTitle: false }))
    L.push('--- B (candidate) ---'); L.push(fmtAnalysis(r.anB, { mapTitle: false }))
    L.push('TIP: compare SHAPES lists - same shape count, same fill/shape type and similar x/y/w/h means the structure matches; color differences show in PALETTE and in the clusters above.')
    return { text: L.join('\n'), names: names.map((n) => n.name), extra: { pctDiff: r.pctDiff, mae: r.mae, corr: r.corr, clusters: r.clusters } }
  }


  // ---------- /tiles: нарезка в родном разрешении ----------
  async function tiles(p, base) {
    const src = await loadSrc(p.file || p.url || p.src || p.img)
    const cols = Math.min(4, Math.max(1, Math.round(num(p.cols, 2)))), rows = Math.min(3, Math.max(1, Math.round(num(p.rows, 2))))
    const r = await lab({ op: 'tiles', imgs: [{ name: src.name, url: src.url }], o: { cols, rows, overlap: num(p.overlap, 0.06), maxw: num(p.maxw, 1000), fmt: p.fmt === 'png' ? 'png' : 'jpeg' } })
    const ov = await saveImage(r.images[0].url, 'm')
    const L = [`TILES of ${src.name} ${r.srcW}x${r.srcH}: ${cols}x${rows} pieces, each shown at (or above) native resolution - small details (windows, signs, HUD, text) become readable.`]
    L.push(`OVERVIEW with tile frames: ${urlOf(base, ov)}`)
    const names = [ov]
    const only = p.tile ? String(p.tile).toLowerCase() : ''
    for (const t of r.tiles) {
      if (only && t.label !== only) continue
      const n = await saveImage(t.url, 'm'); names.push(n)
      L.push(`  ${t.label}  region x=${t.box[0]} y=${t.box[1]} w=${t.box[2]} h=${t.box[3]} (shown x${t.scale})  colors: ${t.dom}`)
      L.push(`      ${urlOf(base, n)}   file: ${diskOf(n)}`)
    }
    prune()
    L.push(seeLine(base, names[1] || ov))
    L.push(`next: zoom exactly: ${base}/view?file=${encodeURIComponent(p.file || p.url || p.src || '')}&crop=x,y,w,h&grid=20  |  finer split: &cols=4&rows=3  |  one piece: &tile=r1c2`)
    return { text: L.join('\n'), names, extra: { tiles: r.tiles.map((t) => ({ label: t.label, box: t.box })) } }
  }

  // ---------- /style (compare mode=style): сравнение без выравнивания ----------
  const HUE = ['red', 'orange', 'yellow', 'yellow-green', 'green', 'teal', 'cyan', 'azure', 'blue', 'violet', 'magenta', 'pink']
  const pearson = (a, b) => { const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2 } return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0 }
  async function style(p, base) {
    const aS = p.a || p.file || p.file1 || p.img1, bS = p.b || p.file2 || p.url2 || p.img2 || p.url
    if (!aS || !bS) throw new Error('need two images: style?a=/ref.png&b=/mine.png   (works for DIFFERENT camera angle / size / scene: nothing is stretched or aligned)')
    const [A, B] = await Promise.all([loadSrc(aS), loadSrc(bS)])
    const r = await lab({ op: 'style', imgs: [{ name: A.name, url: A.url }, { name: B.name, url: B.url }], o: {} })
    const [fa, fb] = r.feats
    const nSide = await saveImage(r.images[0].url, 'c'), nEdge = await saveImage(r.images[1].url, 'c'); prune()
    const rel = (x, y) => (Math.abs(x - y) / Math.max(1e-9, Math.max(Math.abs(x), Math.abs(y))) * 100)
    const cmp = (name, x, y, unit = '', lowHigh = ['lower', 'higher']) => {
      const d = rel(x, y); const mark = d < 8 ? 'same' : d < 25 ? 'a bit different' : 'DIFFERENT'
      return `  ${name.padEnd(22)} A ${String(x).padEnd(8)} B ${String(y).padEnd(8)} ${mark}${d >= 8 ? ` (B is ${y > x ? lowHigh[1] : lowHigh[0]} by ${d.toFixed(0)}%)` : ''}${unit}`
    }
    const topHue = (f) => { const i = f.hue.indexOf(Math.max(...f.hue)); return `${HUE[i]} ${f.hue[i]}%` }
    const L = []
    L.push(`STYLE COMPARE (no alignment, nothing stretched)  A = ${A.name} ${fa.w}x${fa.h}   B = ${B.name} ${fb.w}x${fb.h}`)
    L.push(`Use this when the two pictures show the same thing from another angle / another frame / another size, where pixel diff is meaningless.`)
    L.push(`ASPECT RATIO: A ${fa.aspect}  B ${fb.aspect}  ${rel(fa.aspect, fb.aspect) < 2 ? '- same framing' : '- DIFFERENT framing/crop: the viewport or camera FOV is not the same'}`)
    L.push('METRICS (0-255 scale unless %):')
    L.push(cmp('brightness', fa.lum, fb.lum)); L.push(cmp('contrast (std)', fa.lumStd, fb.lumStd))
    L.push(cmp('dark area % (<40)', fa.darkPct, fb.darkPct)); L.push(cmp('bright area % (>200)', fa.brightPct, fb.brightPct))
    L.push(cmp('saturation %', fa.sat, fb.sat)); L.push(cmp('detail density (edges)', fa.edge, fb.edge)); L.push(cmp('sharp-edge area %', fa.strongPct, fb.strongPct))
    L.push(`  average color          A rgb(${fa.rgb}) B rgb(${fb.rgb})   dominant hue A ${topHue(fa)}  B ${topHue(fb)}`)
    L.push(`  palette A: ${fa.palette.map((q) => q.hex + ' ' + q.pct + '%').join('  ')}`)
    L.push(`  palette B: ${fb.palette.map((q) => q.hex + ' ' + q.pct + '%').join('  ')}`)
    const grid = (name, ga, gb, f) => {
      L.push(`${name} GRID ${fa.gx}x${fa.gy} (left = A, right = B; ${f.hint}):`)
      for (let y = 0; y < fa.gy; y++) { const row = (g) => g.slice(y * fa.gx, (y + 1) * fa.gx).map((v) => f.ch(v)).join(''); L.push(`  |${row(ga)}|   |${row(gb)}|`) }
    }
    grid('BRIGHTNESS', fa.cellL, fb.cellL, { hint: '0 = black ... 9 = white', ch: (v) => String(Math.min(9, Math.floor(v / 25.6))) })
    const emax = Math.max(...fa.cellE, ...fb.cellE, 1)
    grid('DETAIL', fa.cellE, fb.cellE, { hint: '0 = flat ... 9 = busiest cell of either picture', ch: (v) => String(Math.min(9, Math.floor(v / emax * 9.99))) })
    const rl = pearson(fa.cellL, fb.cellL), re = pearson(fa.cellE, fb.cellE)
    L.push(`LAYOUT SIMILARITY of light/dark: ${rl.toFixed(2)}   of detail placement: ${re.toFixed(2)}   (1.0 = same arrangement, 0 = unrelated, <0 = inverted)`)
    L.push('SUMMARY (what to fix first):')
    const sm = []
    if (rel(fa.lum, fb.lum) >= 15) sm.push(`LIGHTING: B is ${fb.lum > fa.lum ? 'brighter' : 'darker'} than A (${fa.lum} vs ${fb.lum}); dark area ${fa.darkPct}% vs ${fb.darkPct}%`)
    const hd = Math.abs(fa.hue.indexOf(Math.max(...fa.hue)) - fb.hue.indexOf(Math.max(...fb.hue))); if (Math.min(hd, 12 - hd) >= 2 || rel(fa.sat, fb.sat) >= 25) sm.push(`COLOR: dominant hue A ${topHue(fa)} vs B ${topHue(fb)}, saturation ${fa.sat}% vs ${fb.sat}%`)
    if (rel(fa.edge, fb.edge) >= 20) sm.push(`DETAIL: ${fb.edge > fa.edge ? 'B is busier/noisier' : 'B is smoother/flatter'} than A (edges ${fa.edge} vs ${fb.edge}) - texture/material scale differs`)
    if (rel(fa.aspect, fb.aspect) >= 2) sm.push(`FRAMING: aspect ratio differs (${fa.aspect} vs ${fb.aspect})`)
    if (rl < 0.6 || re < 0.5) sm.push(`COMPOSITION: where the light and the detail sit differs (similarity ${rl.toFixed(2)} / ${re.toFixed(2)}) - objects are placed/scaled differently or the camera is different`)
    L.push(sm.length ? sm.map((x) => '  - ' + x).join('\n') : '  - style metrics are close: remaining differences are in content/shapes - use /compare (same framing) or /tiles + /view')
    L.push(`IMAGES: A | B side by side (not stretched): ${urlOf(base, nSide)}`)
    L.push(`        EDGE MAPS A | B (contours): ${urlOf(base, nEdge)}`)
    L.push(seeLine(base, nSide))
    L.push(`NOTE: numbers say HOW MUCH and WHERE; WHAT exactly differs (camera angle, roof shape, materials, HUD) you must read by looking at the pictures. Zoom with ${base}/tiles?file=... and /view?crop=...`)
    return { text: L.join('\n'), names: [nSide, nEdge], extra: { layoutLight: +rl.toFixed(2), layoutDetail: +re.toFixed(2), a: fa, b: fb } }
  }

  // ---------- /sheet ----------
  async function sheet(p, base) {
    let list = String(p.files || p.list || '').split(/[|\n]/).map((s) => s.trim()).filter(Boolean)
    if (p.dir) {
      const abs = safe(p.dir)
      const ents = (await fsp.readdir(abs)).filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f)).sort().slice(0, 36)
      list = ents.map((f) => path.posix.join(relOf(abs), f))
    }
    if (list.length < 1) throw new Error('need files=/a.png|/b.png|/c.png  or  dir=/folder')
    list = list.slice(0, 36)
    const S = []; for (const s of list) S.push(await loadSrc(s))
    const r = await lab({ op: 'sheet', imgs: S.map((s) => ({ name: s.name, url: s.url })), o: { cols: num(p.cols, 0) || undefined, fmt: p.fmt === 'png' ? 'png' : 'jpeg', q: 0.85 } })
    const name = await saveImage(r.images[0].url, 'm'); prune()
    const L = [`CONTACT SHEET of ${S.length} image(s): ${urlOf(base, name)}  (${r.images[0].w}x${r.images[0].h})`, seeLine(base, name), 'Index | file | size | dominant colors | change vs previous (0% = identical, 100% = inverted)']
    S.forEach((s, i) => L.push(`  ${i + 1}. ${s.name}  ${r.stats[i].w}x${r.stats[i].h}  ${r.stats[i].dom}${r.stats[i].change !== null ? `  change ${r.stats[i].change}%` : ''}`))
    L.push(`zoom into one: ${base}/view?file=<path>   |   compare two: ${base}/compare?a=<path>&b=<path>`)
    return { text: L.join('\n'), names: [name] }
  }

  // ---------- /frames: кадры из видео/GIF ----------
  async function frames(p, base) {
    const spec = p.file || p.src || p.url
    if (!spec) throw new Error('need file=/path/to/video.mp4 (mp4/mov/webm/gif)')
    let abs
    if (/^https?:\/\//i.test(spec)) {
      const r = await fetch(spec, { redirect: 'follow' }); if (!r.ok) throw new Error('cannot download video: HTTP ' + r.status)
      abs = path.join(SHOTS, `dl${uid()}${path.extname(new URL(spec).pathname) || '.mp4'}`); await fsp.writeFile(abs, Buffer.from(await r.arrayBuffer()))
    } else abs = safe(spec)
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,r_frame_rate,codec_name,codec_type', '-of', 'json', abs], 20000)
    if (!probe.ok) {
      if (/ENOENT/.test(String(probe.code))) throw new Error('ffmpeg/ffprobe is not installed: sudo apt-get install -y ffmpeg')
      throw new Error('ffprobe cannot read the file (not a video?): ' + probe.stderr.split('\n')[0])
    }
    const info = JSON.parse(probe.stdout || '{}'); const vs = (info.streams || []).find((s) => s.codec_type === 'video') || {}
    const dur = parseFloat(info.format && info.format.duration) || 0
    const from = Math.max(0, num(p.from, 0)), to = Math.min(dur || 1e9, num(p.to, dur || 5))
    const n = Math.max(1, Math.min(24, Math.round(num(p.n, 8))))
    const span = Math.max(0.04, to - from)
    const times = n === 1 ? [from + span / 2] : Array.from({ length: n }, (_, i) => from + (span * i) / (n - 1) - (i === n - 1 ? Math.min(0.05, span / 10) : 0))
    const fw = Math.min(960, num(p.maxw, 640)); const stamp = uid(); const files = []
    for (let i = 0; i < times.length; i++) {
      const out = path.join(SHOTS, `f${stamp}_${String(i + 1).padStart(2, '0')}.jpg`)
      const e = await run('ffmpeg', ['-v', 'error', '-y', '-ss', Math.max(0, times[i]).toFixed(3), '-i', abs, '-frames:v', '1', '-vf', `scale='min(${fw},iw)':-2`, '-q:v', '3', out], 30000)
      if (e.ok && fs.existsSync(out)) files.push({ t: times[i], file: out, name: path.basename(out) })
    }
    if (!files.length) throw new Error('could not extract frames: ' + 'check the file is a valid video')
    const imgs = []; for (const f of files) { const b = await fsp.readFile(f.file); imgs.push({ name: f.name, url: `data:image/jpeg;base64,${b.toString('base64')}` }) }
    const r = await lab({ op: 'sheet', imgs, o: { cols: num(p.cols, 0) || (files.length <= 4 ? files.length : Math.min(4, Math.ceil(files.length / 2))), fmt: 'jpeg', q: 0.85, labels: files.map((f) => `t=${f.t.toFixed(2)}s`) } })
    const sname = await saveImage(r.images[0].url, 'm'); prune()
    const L = [`VIDEO: ${path.basename(abs)}  ${vs.width || '?'}x${vs.height || '?'}  ${dur ? dur.toFixed(2) + ' s' : ''}  ${vs.codec_name || ''}  fps ${vs.r_frame_rate || '?'}`]
    L.push(`FRAMES: ${files.length} between ${from.toFixed(2)}s and ${to.toFixed(2)}s`)
    L.push(`CONTACT SHEET (all frames in one image): ${urlOf(base, sname)}`)
    L.push('Frame | time | image | dominant colors | change vs previous frame (high % = a cut / fast motion)')
    files.forEach((f, i) => L.push(`  ${i + 1}. t=${f.t.toFixed(2)}s  ${urlOf(base, f.name)}  ${r.stats[i].dom}${r.stats[i].change !== null ? `  change ${r.stats[i].change}%` : ''}`))
    L.push(`zoom into a frame: ${base}/view?file=${files[0].name}   |   compare two frames: ${base}/compare?a=${files[0].name}&b=${files[files.length - 1].name}   |   more detail around a moment: ${base}/frames?file=${encodeURIComponent(spec)}&from=1&to=2&n=8`)
    return { text: L.join('\n'), names: [sname, ...files.map((f) => f.name)] }
  }

  // ---------- /selftest: проверка всех «органов чувств» с понятной диагностикой ----------
  async function selftest(base) {
    const L = []; let bad = 0
    const ok = (s) => L.push('  OK    ' + s)
    const no = (s, fix) => { bad++; L.push('  FAIL  ' + s); if (fix) L.push('        FIX: ' + fix) }
    let B
    try { B = await getBrowser() } catch (e) { no('browser module: ' + e.message, 'cd ~/.bratcode && npm install'); }
    if (B) {
      const t0 = Date.now()
      try {
        await B.locked(async () => {
          const pr = await B.probe()
          if (pr.text !== 'Hello/120') throw new Error('unexpected eval result ' + pr.text)
          const buf = await fsp.readFile(pr.file); const inf = sniffImage(buf)
          fs.rmSync(pr.file, { force: true })
          if (!inf || !inf.w) throw new Error('screenshot is not a valid PNG')
          ok(`Chromium starts, renders, screenshots (${inf.w}x${inf.h}, ${Date.now() - t0} ms)`)
        }, 40000, 'selftest browser')
      } catch (e) { no('Chromium: ' + e.message) }
      try {
        // красный квадрат на белом -> лаборатория должна найти красную фигуру-прямоугольник
        const png = await makeTestPng(B)
        const r = await lab({ op: 'process', imgs: [{ name: 'test.png', url: png }], o: {} })
        const red = r.an.regions.find((x) => /^#[ef]/i.test(x.hex) && x.fill > 0.9)
        if (!red) throw new Error('shape analysis did not find the red rectangle: ' + JSON.stringify(r.an.palette.slice(0, 3)))
        const r2 = await lab({ op: 'compare', imgs: [{ name: 'a', url: png }, { name: 'a2', url: png }], o: { mode: 'side' } })
        if (r2.pctDiff !== 0) throw new Error('compare of identical images gave ' + r2.pctDiff + '%')
        ok('image lab (view / compare / shapes) works inside Chromium')
      } catch (e) { no('image lab: ' + e.message) }
    }
    const ff = await run('ffmpeg', ['-version'], 8000)
    if (ff.ok) ok('ffmpeg present (/frames for video works)'); else no('ffmpeg missing - /frames cannot read video', 'sudo apt-get install -y ffmpeg')
    const ts = await run('tesseract', ['--version'], 8000)
    if (ts.ok || /tesseract/.test(ts.stderr)) ok('tesseract present (/view?ocr=1 reads text from pictures)'); else L.push('  info  tesseract not installed - optional OCR (&ocr=1) is off. sudo apt-get install -y tesseract-ocr tesseract-ocr-rus')
    const fl = await run('fc-list', [':lang=ru', 'family'], 8000)
    if (fl.ok && fl.stdout.trim()) ok('fonts: Cyrillic available'); else L.push('  info  no Cyrillic fonts found: Russian text in screenshots may show as squares. sudo apt-get install -y fonts-dejavu-core fonts-liberation fonts-noto-core')
    return { text: `SELFTEST: ${bad ? bad + ' PROBLEM(S) - fix them, then call /selftest again' : 'ALL GOOD - you can see'}\n` + L.join('\n') + (bad ? '' : `\nNext: ${base}/look?file=<page.html>   |   ${base}/view?file=<image>   |   ${base}/compare?a=<ref>&b=<mine>`), bad }
  }
  async function makeTestPng(B) {
    // тестовая картинка рисуется без участия страницы агента: PNG 200x120, красный прямоугольник 100x60 на белом
    const { deflateSync } = await import('node:zlib')
    const W = 200, H = 120, raw = Buffer.alloc((W * 3 + 1) * H)
    for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; for (let x = 0; x < W; x++) { const red = x >= 40 && x < 140 && y >= 30 && y < 90; const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = red ? 232 : 255; raw[o + 1] = red ? 32 : 255; raw[o + 2] = red ? 32 : 255 } }
    const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
    const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
    const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
    return 'data:image/png;base64,' + png.toString('base64')
  }

  return { view, compare, sheet, frames, selftest, loadSrc, tiles, style }
}
