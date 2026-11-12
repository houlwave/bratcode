// «Лаборатория изображений»: функция выполняется ВНУТРИ headless Chromium (page.evaluate), поэтому ей
// не нужны ни sharp, ни ImageMagick, ни Python — достаточно того, что уже есть для /look.
// ВАЖНО: labMain сериализуется целиком (toString), поэтому она обязана быть самодостаточной:
// никаких внешних замыканий и импортов внутри.
//
// job = { op: 'process' | 'compare' | 'sheet', imgs: [{ name, url(dataURL) }], o: {...} }
export async function labMain(job) {
  const { op, imgs = [], o = {} } = job
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c }
  const cx = (c) => c.getContext('2d', { willReadFrequently: true })
  const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('cannot decode image')); i.src = src })
  const toURL = (c, fmt, q) => c.toDataURL(fmt === 'jpeg' ? 'image/jpeg' : 'image/png', q || 0.85)
  const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  const white = (c) => { const x = cx(c); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); return x }
  const LET = 'ABCDEFGHIJKLMNOP'

  const loaded = []
  for (const im of imgs) {
    const el = await load(im.url)
    loaded.push({ el, w: el.naturalWidth || 800, h: el.naturalHeight || 600, name: im.name || '' })
  }

  // ---------- анализ картинки: палитра, фигуры, текстовая карта ----------
  function analyze(src, sw, sh, opt) {
    const W = Math.min(160, sw), H = Math.max(1, Math.round(W * sh / sw))
    const c = mk(W, H); const x = cx(c); x.imageSmoothingEnabled = true; x.drawImage(src, 0, 0, W, H)
    const d = x.getImageData(0, 0, W, H).data
    const hist = new Map()
    for (let i = 0; i < d.length; i += 4) { const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4); hist.set(k, (hist.get(k) || 0) + 1) }
    const bins = [...hist].sort((a, b) => b[1] - a[1])
    const K = clamp(opt.colors || 10, 2, 16)
    let pal = []
    for (const [k] of bins) {
      const r = ((k >> 8) & 15) * 17, g = ((k >> 4) & 15) * 17, b = (k & 15) * 17
      if (pal.every((p) => (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2 > 45 * 45)) pal.push([r, g, b])
      if (pal.length >= K) break
    }
    const nearest = (r, g, b) => { let bi = 0, bd = 1e9; for (let i = 0; i < pal.length; i++) { const p = pal[i]; const dd = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2; if (dd < bd) { bd = dd; bi = i } } return bi }
    // два прохода: назначить → уточнить цвет палитры средним по реальным пикселям
    let idx = new Uint8Array(W * H)
    for (let pass = 0; pass < 2; pass++) {
      const sum = pal.map(() => [0, 0, 0, 0])
      for (let p = 0; p < W * H; p++) { const i = p * 4; const n = nearest(d[i], d[i + 1], d[i + 2]); idx[p] = n; const s = sum[n]; s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; s[3]++ }
      pal = pal.map((p, n) => (sum[n][3] ? [sum[n][0] / sum[n][3], sum[n][1] / sum[n][3], sum[n][2] / sum[n][3]] : p))
    }
    const cnt = new Array(pal.length).fill(0); for (let p = 0; p < W * H; p++) cnt[idx[p]]++
    const order = pal.map((_, i) => i).filter((i) => cnt[i] > 0).sort((a, b) => cnt[b] - cnt[a])
    const letter = {}; order.forEach((n, k) => { letter[n] = LET[k] })
    const palette = order.map((n) => ({ ch: letter[n], hex: hex(...pal[n]), pct: +(cnt[n] * 100 / (W * H)).toFixed(1) }))
    // фигуры: связные области одного цвета
    const seen = new Uint8Array(W * H); const regions = []; const minArea = Math.max(6, W * H * 0.004)
    const stack = []
    for (let s0 = 0; s0 < W * H; s0++) {
      if (seen[s0]) continue
      const col = idx[s0]; let area = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, sx = 0, sy = 0
      stack.push(s0); seen[s0] = 1
      while (stack.length) {
        const p = stack.pop(); const px = p % W, py = (p / W) | 0
        area++; sx += px; sy += py
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py
        if (px > 0 && !seen[p - 1] && idx[p - 1] === col) { seen[p - 1] = 1; stack.push(p - 1) }
        if (px < W - 1 && !seen[p + 1] && idx[p + 1] === col) { seen[p + 1] = 1; stack.push(p + 1) }
        if (py > 0 && !seen[p - W] && idx[p - W] === col) { seen[p - W] = 1; stack.push(p - W) }
        if (py < H - 1 && !seen[p + W] && idx[p + W] === col) { seen[p + W] = 1; stack.push(p + W) }
      }
      if (area < minArea) continue
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1, fill = area / (bw * bh)
      const fx = (sx / area - x0 + 0.5) / bw, fy = (sy / area - y0 + 0.5) / bh
      let shape
      if (bw >= W * 0.97 && bh < H * 0.5) shape = 'full-width band'
      else if (bh >= H * 0.97 && bw < W * 0.5) shape = 'full-height band'
      else if (bw / bh > 6) shape = 'horizontal line/band'
      else if (bh / bw > 6) shape = 'vertical line/bar'
      else if (fill >= 0.88) shape = bw / bh > 0.9 && bw / bh < 1.1 ? 'square / solid block' : 'rectangle / solid block'
      else if (fill >= 0.72) shape = 'ellipse / rounded shape'
      else if (fill >= 0.4 && fill < 0.64) {
        if (Math.abs(fx - 0.5) < 0.14 && fy > 0.58) shape = 'triangle, apex UP'
        else if (Math.abs(fx - 0.5) < 0.14 && fy < 0.42) shape = 'triangle, apex DOWN'
        else shape = 'triangle / diagonal shape'
      } else if (fill < 0.3) shape = 'thin outline / ring / scattered'
      else shape = 'irregular shape'
      const edge = [x0 === 0 ? 'left' : '', x1 === W - 1 ? 'right' : '', y0 === 0 ? 'top' : '', y1 === H - 1 ? 'bottom' : ''].filter(Boolean).join('+')
      regions.push({
        ch: letter[col], hex: hex(...pal[col]), area, pct: +(area * 100 / (W * H)).toFixed(1),
        x: Math.round(x0 * sw / W), y: Math.round(y0 * sh / H), w: Math.round(bw * sw / W), h: Math.round(bh * sh / H),
        fill: +fill.toFixed(2), shape, edge,
      })
    }
    regions.sort((a, b) => b.area - a.area)
    // текстовая карта
    const cols = clamp(opt.cols || 96, 24, 200), rows = Math.max(4, Math.round(cols * sh / sw * 0.5))
    const mc = mk(cols, rows); const mx = cx(mc); mx.imageSmoothingEnabled = true; mx.drawImage(src, 0, 0, cols, rows)
    const md = mx.getImageData(0, 0, cols, rows).data; const lines = []
    for (let yy = 0; yy < rows; yy++) { let s = ''; for (let xx = 0; xx < cols; xx++) { const i = (yy * cols + xx) * 4; s += letter[nearest(md[i], md[i + 1], md[i + 2])] || '?' } lines.push(s) }
    return { palette, regions: regions.slice(0, 14).map(({ area, ...r }) => r), map: lines.join('\n'), cols, rows, cellW: Math.round(sw / cols), cellH: Math.round(sh / rows) }
  }

  function drawGrid(x, ow, oh, scale, sx, sy, step) {
    let g = Math.max(1, step)
    while ((ow / scale) / g > 40 || (oh / scale) / g > 40) g *= 2
    x.save(); x.lineWidth = 1; x.font = '11px sans-serif'; x.textBaseline = 'top'
    const label = (t, px, py) => { const w = x.measureText(t).width + 4; x.fillStyle = 'rgba(255,255,255,.85)'; x.fillRect(px, py, w, 13); x.fillStyle = '#a0007a'; x.fillText(t, px + 2, py + 1) }
    for (let X = Math.ceil(sx / g) * g; X < sx + ow / scale; X += g) { const px = Math.round((X - sx) * scale) + 0.5; x.strokeStyle = 'rgba(255,0,200,.55)'; x.beginPath(); x.moveTo(px, 0); x.lineTo(px, oh); x.stroke(); label(String(X), px + 1, 0) }
    for (let Y = Math.ceil(sy / g) * g; Y < sy + oh / scale; Y += g) { const py = Math.round((Y - sy) * scale) + 0.5; x.strokeStyle = 'rgba(255,0,200,.55)'; x.beginPath(); x.moveTo(0, py); x.lineTo(ow, py); x.stroke(); label(String(Y), 0, py + 1) }
    x.restore()
  }

  // ---------- process: одна картинка (crop / grid / уменьшение / формат) + анализ ----------
  if (op === 'process') {
    const I = loaded[0]; let sx = 0, sy = 0, sw = I.w, sh = I.h
    if (o.crop) { sx = clamp(Math.round(o.crop[0]), 0, I.w - 1); sy = clamp(Math.round(o.crop[1]), 0, I.h - 1); sw = clamp(Math.round(o.crop[2]), 1, I.w - sx); sh = clamp(Math.round(o.crop[3]), 1, I.h - sy) }
    const src = mk(sw, sh); white(src).drawImage(I.el, sx, sy, sw, sh, 0, 0, sw, sh)
    const an = o.analyze === false ? null : analyze(src, sw, sh, o)
    const maxw = o.maxw || 1400; let scale = 1
    if (sw > maxw) scale = maxw / sw; else if (o.crop && sw < 640) scale = Math.min(8, 640 / sw)
    const ow = Math.round(sw * scale), oh = Math.round(sh * scale)
    const out = mk(ow, oh); const x = white(out); x.imageSmoothingEnabled = scale < 1; x.drawImage(src, 0, 0, ow, oh)
    if (o.grid) drawGrid(x, ow, oh, scale, sx, sy, o.grid)
    return { images: [{ label: 'view', url: toURL(out, o.fmt, o.q), w: ow, h: oh }], srcW: I.w, srcH: I.h, crop: o.crop ? [sx, sy, sw, sh] : null, scale, an }
  }

  // ---------- compare: A | B | DIFF, overlay, метрики, где и чем отличаются ----------
  if (op === 'compare') {
    const A = loaded[0], B = loaded[1]
    const k = Math.min(1, (o.cap || 1400) / Math.max(A.w, A.h)); const ww = Math.round(A.w * k), hh = Math.round(A.h * k)
    const ca = mk(ww, hh), cb = mk(ww, hh)
    white(ca).drawImage(A.el, 0, 0, ww, hh); white(cb).drawImage(B.el, 0, 0, ww, hh)
    const da = cx(ca).getImageData(0, 0, ww, hh).data, db = cx(cb).getImageData(0, 0, ww, hh).data
    const N = ww * hh, thr = o.thr || 24, GX = 12, GY = 8
    const dc = mk(ww, hh); const dctx = cx(dc); const dimg = dctx.createImageData(ww, hh); const dd = dimg.data
    const cellN = new Float64Array(GX * GY), cellD = new Float64Array(GX * GY)
    const cA = new Float64Array(GX * GY * 3), cB = new Float64Array(GX * GY * 3)
    let cnt = 0, sumAbs = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0
    for (let p = 0; p < N; p++) {
      const i = p * 4
      const dr = Math.abs(da[i] - db[i]), dg = Math.abs(da[i + 1] - db[i + 1]), dbl = Math.abs(da[i + 2] - db[i + 2])
      const m = Math.max(dr, dg, dbl); sumAbs += (dr + dg + dbl) / 3
      const la = 0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2], lb = 0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2]
      sa += la; sb += lb; saa += la * la; sbb += lb * lb; sab += la * lb
      const px = p % ww, py = (p / ww) | 0
      const ci = Math.min(GY - 1, (py * GY / hh) | 0) * GX + Math.min(GX - 1, (px * GX / ww) | 0)
      cellN[ci]++
      if (m > thr) {
        cnt++; cellD[ci]++
        cA[ci * 3] += da[i]; cA[ci * 3 + 1] += da[i + 1]; cA[ci * 3 + 2] += da[i + 2]
        cB[ci * 3] += db[i]; cB[ci * 3 + 1] += db[i + 1]; cB[ci * 3 + 2] += db[i + 2]
        dd[i] = 230; dd[i + 1] = 20; dd[i + 2] = 20
      } else { const v = 255 - (255 - la) * 0.3; dd[i] = v; dd[i + 1] = v; dd[i + 2] = v }
      dd[i + 3] = 255
    }
    dctx.putImageData(dimg, 0, 0)
    const den = Math.sqrt((N * saa - sa * sa) * (N * sbb - sb * sb))
    const corr = den > 1e-9 ? (N * sab - sa * sb) / den : (Math.abs(sa - sb) < 1 ? 1 : 0)
    const pctDiff = cnt * 100 / N, mae = sumAbs / N / 255 * 100
    // сетка отличий и кластеры
    const grid = []; for (let gy = 0; gy < GY; gy++) { let s = ''; for (let gx = 0; gx < GX; gx++) { const v = cellD[gy * GX + gx] * 100 / Math.max(1, cellN[gy * GX + gx]); s += v < 0.5 ? '.' : String(Math.min(9, Math.floor(v / 10))) } grid.push(s) }
    const lab = new Int16Array(GX * GY).fill(-1); const clusters = []
    for (let s0 = 0; s0 < GX * GY; s0++) {
      const pc = (q) => cellD[q] * 100 / Math.max(1, cellN[q])
      if (lab[s0] >= 0 || pc(s0) < 4) continue
      const st = [s0]; lab[s0] = clusters.length; let gx0 = GX, gy0 = GY, gx1 = 0, gy1 = 0, dn = 0, tn = 0; const rgbA = [0, 0, 0], rgbB = [0, 0, 0]
      while (st.length) {
        const q = st.pop(); const qx = q % GX, qy = (q / GX) | 0
        gx0 = Math.min(gx0, qx); gx1 = Math.max(gx1, qx); gy0 = Math.min(gy0, qy); gy1 = Math.max(gy1, qy)
        dn += cellD[q]; tn += cellN[q]; for (let c = 0; c < 3; c++) { rgbA[c] += cA[q * 3 + c]; rgbB[c] += cB[q * 3 + c] }
        for (let ay = -1; ay <= 1; ay++) for (let ax = -1; ax <= 1; ax++) {
          const nx = qx + ax, ny = qy + ay; if (nx < 0 || ny < 0 || nx >= GX || ny >= GY) continue
          const nq = ny * GX + nx; if (lab[nq] < 0 && pc(nq) >= 4) { lab[nq] = clusters.length; st.push(nq) }
        }
      }
      clusters.push({
        x: Math.round(gx0 * A.w / GX), y: Math.round(gy0 * A.h / GY), w: Math.round((gx1 - gx0 + 1) * A.w / GX), h: Math.round((gy1 - gy0 + 1) * A.h / GY),
        pct: +(dn * 100 / Math.max(1, tn)).toFixed(0), n: dn,
        a: dn ? hex(rgbA[0] / dn, rgbA[1] / dn, rgbA[2] / dn) : '', b: dn ? hex(rgbB[0] / dn, rgbB[1] / dn, rgbB[2] / dn) : '',
      })
    }
    clusters.sort((p, q) => q.n - p.n)
    // картинки
    const mode = o.mode || 'all'; const showDiff = mode === 'all' || mode === 'diff'
    const nP = showDiff ? 3 : 2; const gap = 10, head = 26
    const pw = Math.min(ww, Math.floor((1800 - (nP + 1) * gap) / nP)), ph = Math.round(hh * pw / ww)
    const sheet = mk(nP * pw + (nP + 1) * gap, head + ph + gap); const sx2 = cx(sheet)
    sx2.fillStyle = '#2b2b2b'; sx2.fillRect(0, 0, sheet.width, sheet.height); sx2.font = 'bold 13px sans-serif'; sx2.textBaseline = 'middle'
    const panels = [[ca, `A  ${A.name}  ${A.w}x${A.h}`], [cb, `B  ${B.name}  ${B.w}x${B.h}${A.w !== B.w || A.h !== B.h ? ' (stretched to A)' : ''}`]]
    if (showDiff) panels.push([dc, `DIFF  ${pctDiff.toFixed(1)}% of pixels differ`])
    panels.forEach(([c, t], i) => { const px = gap + i * (pw + gap); sx2.fillStyle = '#fff'; sx2.fillText(t.slice(0, Math.floor(pw / 7.5)), px, head / 2); sx2.drawImage(c, px, head, pw, ph) })
    const images = [{ label: mode === 'diff' ? 'diff' : mode === 'side' ? 'side-by-side' : 'sheet (A | B | DIFF)', url: toURL(sheet, o.fmt, o.q), w: sheet.width, h: sheet.height }]
    if (mode === 'all' || mode === 'overlay') {
      const ov = mk(ww, hh); const ox = white(ov); ox.drawImage(ca, 0, 0); ox.globalAlpha = o.alpha || 0.5; ox.drawImage(cb, 0, 0)
      images.push({ label: `overlay (A and B blended ${(o.alpha || 0.5) * 100}%)`, url: toURL(ov, o.fmt, o.q), w: ww, h: hh })
    }
    if (mode === 'all') images.push({ label: 'diff only (red = differs)', url: toURL(dc, o.fmt, o.q), w: ww, h: hh })
    return {
      images, A: { w: A.w, h: A.h }, B: { w: B.w, h: B.h }, pctDiff: +pctDiff.toFixed(2), mae: +mae.toFixed(2), corr: +corr.toFixed(3),
      avgA: hex(sa / N, sa / N, sa / N), grid, clusters: clusters.slice(0, 6),
      anA: analyze(ca, A.w, A.h, { colors: 8, cols: 0 || 48 }), anB: analyze(cb, A.w, A.h, { colors: 8, cols: 48 }),
    }
  }

  // ---------- sheet: контактный лист из N картинок с подписями и статистикой ----------
  if (op === 'sheet') {
    const n = loaded.length; const cols = clamp(o.cols || Math.ceil(Math.sqrt(n)), 1, 8)
    const cw = Math.min(640, Math.floor((1800 - (cols + 1) * 8) / cols)); const lh = 18, gap = 8
    const tiles = loaded.map((I) => ({ I, w: cw, h: Math.max(8, Math.round(I.h * cw / I.w)) }))
    const rowsN = Math.ceil(n / cols); const rowH = []
    for (let r = 0; r < rowsN; r++) rowH.push(Math.max(...tiles.slice(r * cols, r * cols + cols).map((t) => t.h)) + lh)
    const W = cols * cw + (cols + 1) * gap, H = rowH.reduce((a, b) => a + b, 0) + (rowsN + 1) * gap
    const sh = mk(W, H); const x = cx(sh); x.fillStyle = '#2b2b2b'; x.fillRect(0, 0, W, H); x.font = 'bold 12px sans-serif'; x.textBaseline = 'middle'
    let yy = gap; const thumbs = []
    for (let r = 0; r < rowsN; r++) {
      for (let c = 0; c < cols && r * cols + c < n; c++) {
        const i = r * cols + c, t = tiles[i], px = gap + c * (cw + gap)
        x.fillStyle = '#fff'; x.fillText(`${i + 1}. ${(o.labels && o.labels[i]) || t.I.name}`.slice(0, Math.floor(cw / 7)), px, yy + lh / 2)
        x.drawImage(t.I.el, px, yy + lh, t.w, t.h)
        const tc = mk(32, 18); const tx = white(tc); tx.drawImage(t.I.el, 0, 0, 32, 18); thumbs.push(tx.getImageData(0, 0, 32, 18).data)
      }
      yy += rowH[r] + gap
    }
    const stats = loaded.map((I, i) => {
      const tc = mk(I.w, I.h); white(tc).drawImage(I.el, 0, 0)
      const an = analyze(tc, I.w, I.h, { colors: 4, cols: 24 })
      let change = null
      if (i > 0) { let s = 0; const a = thumbs[i - 1], b = thumbs[i]; for (let p = 0; p < a.length; p += 4) s += (Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2])) / 3; change = +(s / (a.length / 4) / 255 * 100).toFixed(1) }
      return { dom: an.palette.slice(0, 3).map((p) => `${p.hex} ${p.pct}%`).join(', '), change, w: I.w, h: I.h }
    })
    return { images: [{ label: 'contact sheet', url: toURL(sh, o.fmt, o.q), w: W, h: H }], stats }
  }
  // ---------- tiles: нарезка на куски в родном разрешении (+ обзорная картинка с разметкой) ----------
  if (op === 'tiles') {
    const I = loaded[0]
    const cols = clamp(Math.round(o.cols || 2), 1, 4), rows = clamp(Math.round(o.rows || 2), 1, 3)
    const ov = clamp(o.overlap === undefined ? 0.06 : o.overlap, 0, 0.3), maxw = o.maxw || 1000
    const tw0 = I.w / cols, th0 = I.h / rows, tiles = []
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x0 = Math.round(Math.max(0, c * tw0 - ov * tw0)), x1 = Math.round(Math.min(I.w, (c + 1) * tw0 + ov * tw0))
      const y0 = Math.round(Math.max(0, r * th0 - ov * th0)), y1 = Math.round(Math.min(I.h, (r + 1) * th0 + ov * th0))
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0)
      let sc = 1; if (w > maxw) sc = maxw / w; else if (w < 400) sc = Math.min(3, 400 / w)
      const ow = Math.round(w * sc), oh = Math.round(h * sc)
      const tc = mk(ow, oh); const tx = white(tc); tx.imageSmoothingEnabled = sc < 1; tx.drawImage(I.el, x0, y0, w, h, 0, 0, ow, oh)
      const an = analyze(tc, ow, oh, { colors: 4, cols: 24 })
      tiles.push({ label: 'r' + (r + 1) + 'c' + (c + 1), row: r + 1, col: c + 1, box: [x0, y0, w, h], scale: +sc.toFixed(2), dom: an.palette.slice(0, 3).map((q) => q.hex + ' ' + q.pct + '%').join(', '), url: toURL(tc, o.fmt || 'jpeg', 0.9), w: ow, h: oh })
    }
    const k = Math.min(1, 1000 / I.w), vw = Math.round(I.w * k), vh = Math.round(I.h * k)
    const vc = mk(vw, vh); const vx = white(vc); vx.drawImage(I.el, 0, 0, vw, vh)
    vx.lineWidth = 2; vx.font = 'bold 14px sans-serif'; vx.textBaseline = 'top'
    for (const t of tiles) {
      const bx = t.box[0] * k, by = t.box[1] * k, bw = t.box[2] * k, bh = t.box[3] * k
      vx.strokeStyle = 'rgba(255,0,200,.8)'; vx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2)
      vx.fillStyle = 'rgba(255,255,255,.85)'; vx.fillRect(bx + 3, by + 3, 44, 18); vx.fillStyle = '#a0007a'; vx.fillText(t.label, bx + 6, by + 5)
    }
    return { images: [{ label: 'overview', url: toURL(vc, 'jpeg', 0.85), w: vw, h: vh }], tiles, srcW: I.w, srcH: I.h }
  }

  // ---------- style: сравнение БЕЗ выравнивания (разный ракурс/кадр/размер) ----------
  if (op === 'style') {
    const GX = 6, GY = 4, HB = 12
    const feats = [], edgeCanvases = []
    for (const I of loaded) {
      const w = Math.min(480, I.w), h = Math.max(1, Math.round(w * I.h / I.w))
      const c = mk(w, h); const x = white(c); x.imageSmoothingEnabled = true; x.drawImage(I.el, 0, 0, w, h)
      const d = x.getImageData(0, 0, w, h).data, N = w * h
      const lum = new Float32Array(N)
      let sr = 0, sg = 0, sb = 0, sl = 0, sll = 0, ssat = 0, dark = 0, bright = 0
      const hue = new Float64Array(HB), cellL = new Float64Array(GX * GY), cellN = new Float64Array(GX * GY), cellE = new Float64Array(GX * GY), cellS = new Float64Array(GX * GY)
      for (let p = 0; p < N; p++) {
        const i = p * 4, r = d[i], g = d[i + 1], b = d[i + 2]
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = 0.2126 * r + 0.7152 * g + 0.0722 * b, sat = mx ? (mx - mn) / mx : 0
        lum[p] = l; sr += r; sg += g; sb += b; sl += l; sll += l * l; ssat += sat
        if (l < 40) dark++; if (l > 200) bright++
        if (mx - mn > 20) {
          let hh; const dd = mx - mn
          if (mx === r) hh = ((g - b) / dd) % 6; else if (mx === g) hh = (b - r) / dd + 2; else hh = (r - g) / dd + 4
          hh = ((hh * 60) + 360) % 360; hue[Math.floor(hh / 30) % HB] += dd / 255
        }
        const cc = Math.min(GX - 1, Math.floor((p % w) * GX / w)) + Math.min(GY - 1, Math.floor(Math.floor(p / w) * GY / h)) * GX
        cellL[cc] += l; cellS[cc] += sat; cellN[cc]++
      }
      const ec = mk(w, h); const ex = cx(ec); const eimg = ex.createImageData(w, h); const ed = eimg.data
      let se = 0, strong = 0
      for (let p = 0; p < N; p++) { ed[p * 4] = ed[p * 4 + 1] = ed[p * 4 + 2] = 255; ed[p * 4 + 3] = 255 }
      for (let y = 1; y < h - 1; y++) for (let X = 1; X < w - 1; X++) {
        const p = y * w + X
        const gx = -lum[p - w - 1] - 2 * lum[p - 1] - lum[p + w - 1] + lum[p - w + 1] + 2 * lum[p + 1] + lum[p + w + 1]
        const gy = -lum[p - w - 1] - 2 * lum[p - w] - lum[p - w + 1] + lum[p + w - 1] + 2 * lum[p + w] + lum[p + w + 1]
        const e = Math.min(255, Math.sqrt(gx * gx + gy * gy) / 4)
        se += e; if (e > 28) strong++
        const v = 255 - Math.min(255, e * 3); ed[p * 4] = ed[p * 4 + 1] = ed[p * 4 + 2] = v
        const cc = Math.min(GX - 1, Math.floor(X * GX / w)) + Math.min(GY - 1, Math.floor(y * GY / h)) * GX
        cellE[cc] += e
      }
      ex.putImageData(eimg, 0, 0); edgeCanvases.push(ec)
      const mean = sl / N, hs = hue.reduce((a, b) => a + b, 0) || 1
      feats.push({
        w: I.w, h: I.h, name: I.name, aspect: +(I.w / I.h).toFixed(3),
        rgb: [Math.round(sr / N), Math.round(sg / N), Math.round(sb / N)], lum: +mean.toFixed(1), lumStd: +Math.sqrt(Math.max(0, sll / N - mean * mean)).toFixed(1),
        darkPct: +(dark * 100 / N).toFixed(1), brightPct: +(bright * 100 / N).toFixed(1), sat: +(ssat * 100 / N).toFixed(1),
        hue: Array.from(hue, (v) => +(v * 100 / hs).toFixed(1)), edge: +(se / N).toFixed(1), strongPct: +(strong * 100 / N).toFixed(1),
        gx: GX, gy: GY, cellL: Array.from(cellL, (v, i) => +(v / Math.max(1, cellN[i])).toFixed(0)), cellE: Array.from(cellE, (v, i) => +(v / Math.max(1, cellN[i])).toFixed(1)), cellS: Array.from(cellS, (v, i) => +(v * 100 / Math.max(1, cellN[i])).toFixed(0)),
        palette: analyze(c, w, h, { colors: 6, cols: 24 }).palette,
      })
    }
    const side = (items, label, fmt) => {
      const H = Math.min(520, Math.max(...items.map((it) => it.h))), gap = 12
      const sc = items.map((it) => H / it.h), ws = items.map((it, i) => Math.round(it.w * sc[i]))
      const W = ws.reduce((a, b) => a + b, 0) + gap * (items.length - 1)
      const c = mk(W, H); const x = white(c); let px = 0
      items.forEach((it, i) => { x.drawImage(it.el, px, 0, ws[i], H); x.fillStyle = 'rgba(255,255,255,.85)'; x.fillRect(px, 0, 22, 20); x.fillStyle = '#a0007a'; x.font = 'bold 15px sans-serif'; x.textBaseline = 'top'; x.fillText('AB'[i] || String(i + 1), px + 5, 2); px += ws[i] + gap })
      return { label, url: toURL(c, fmt || 'jpeg', 0.88), w: W, h: H }
    }
    const pics = loaded.map((I) => ({ el: I.el, w: I.w, h: I.h }))
    const edgePics = edgeCanvases.map((ec) => ({ el: ec, w: ec.width, h: ec.height }))
    return { images: [side(pics, 'A | B (same height, not stretched)', 'jpeg'), side(edgePics, 'EDGE MAPS A | B (dark lines = contours/detail)', 'png')], feats }
  }
  throw new Error('unknown lab op ' + op)
}
