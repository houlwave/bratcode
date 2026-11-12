// QR code -> terminal text using half blocks. Two QR rows per text row.
// Rendered "inverted for dark terminals": the QR modules are light on a dark background is NOT scannable
// by every phone, so we draw dark modules as spaces on a white quiet zone (classic black-on-white look).
import QRCode from 'qrcode';

/** Boolean matrix of a QR code. */
export function qrMatrix(text, ecl = 'L') {
  const q = QRCode.create(String(text), { errorCorrectionLevel: ecl });
  const n = q.modules.size;
  const rows = [];
  for (let y = 0; y < n; y++) {
    const r = [];
    for (let x = 0; x < n; x++) r.push(!!q.modules.get(x, y));
    rows.push(r);
  }
  return rows;
}

/**
 * Lines of half-block characters. White quiet zone (border modules) around the code.
 * '▀' upper half, '▄' lower half, '█' both, ' ' none  — "ink" = LIGHT here (white), because
 * terminal is dark; dark modules are drawn as empty cells, so the code looks like black-on-white.
 */
export function qrHalfBlocks(text, { border = 2, ecl = 'L' } = {}) {
  const m = qrMatrix(text, ecl);
  const n = m.length;
  const size = n + border * 2;
  const dark = (x, y) => {
    const mx = x - border, my = y - border;
    if (mx < 0 || my < 0 || mx >= n || my >= n) return false; // quiet zone = light
    return m[my][mx];
  };
  const lines = [];
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const top = !dark(x, y);        // light = filled
      const bot = y + 1 < size ? !dark(x, y + 1) : true;
      line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines;
}

export const qrSize = (text, border = 2) => {
  const n = qrMatrix(text).length + border * 2;
  return { w: n, h: Math.ceil(n / 2) };
};
