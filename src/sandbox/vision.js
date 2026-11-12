// Чистые функции «зрения» (без браузера): размеры картинок по заголовку и текстовое описание
// анализа картинки (палитра, фигуры, текстовая карта). Используется agent.js / eyes.js / browser.js.

export function sniffImage(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { type: 'PNG', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue }
        const m = buf[i + 1]
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue }
        const len = buf.readUInt16BE(i + 2)
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'JPEG', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
        i += 2 + len
      }
      return { type: 'JPEG' }
    }
    if (buf.slice(0, 3).toString() === 'GIF') return { type: 'GIF', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
    if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
      const f = buf.slice(12, 16).toString()
      if (f === 'VP8 ') return { type: 'WEBP', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
      if (f === 'VP8L') { const b = buf.readUInt32LE(21); return { type: 'WEBP', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 } }
      if (f === 'VP8X') return { type: 'WEBP', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
      return { type: 'WEBP' }
    }
    if (/<svg/i.test(buf.slice(0, 800).toString('utf8'))) return { type: 'SVG' }
  } catch {}
  return null
}

export const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')

// an — результат labMain({op:'process'}).an. ox/oy — смещение, если анализировалась вырезка (crop).
export function fmtAnalysis(an, { ox = 0, oy = 0, mapTitle = true } = {}) {
  if (!an) return ''
  const L = []
  L.push('PALETTE (dominant colors, share of the picture):')
  L.push('  ' + an.palette.map((p) => `${p.ch}=${p.hex} ${p.pct}%`).join('   '))
  if (an.regions && an.regions.length) {
    L.push('SHAPES (connected areas of one color; x,y,w,h in source pixels; fill = area / bounding box: ~1.0 rectangle, ~0.79 ellipse, ~0.5 triangle):')
    an.regions.forEach((r, i) => {
      L.push(`  ${i + 1}. ${r.ch} ${r.hex}  x=${r.x + ox} y=${r.y + oy} w=${r.w} h=${r.h}  ${r.pct}%  fill ${r.fill} -> ${r.shape}${r.edge ? ', touches ' + r.edge : ''}`)
    })
  }
  if (an.map) {
    L.push(`TEXT MAP (${an.cols}x${an.rows}; one char = ${an.cellW}x${an.cellH} source px; letters = PALETTE above):`)
    L.push(an.map.split('\n').map((l) => '  |' + l + '|').join('\n'))
  }
  return L.join('\n')
}

export function verdict(pctDiff) {
  if (pctDiff < 0.5) return 'IDENTICAL (practically no differences)'
  if (pctDiff < 3) return 'VERY CLOSE (small local differences)'
  if (pctDiff < 12) return 'SIMILAR, but with clearly visible differences'
  if (pctDiff < 35) return 'DIFFERENT in many places'
  return 'VERY DIFFERENT (layout or colors do not match)'
}
