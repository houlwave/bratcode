import { mix } from './term.js';

// condensed pixel font for the cover. 10px tall, 2px strokes, like a squeezed arial.
const G = {
  b: ['##...', '##...', '##...', '####.', '#####', '##.##', '##.##', '##.##', '#####', '####.'],
  r: ['....', '....', '....', '##.#', '###.', '##..', '##..', '##..', '##..', '##..'],
  a: ['.....', '.....', '.....', '.####', '...##', '.####', '##.##', '##.##', '##.##', '.####'],
  t: ['....', '.##.', '.##.', '####', '.##.', '.##.', '.##.', '.##.', '.###', '..##'],
};
const GAP = 2;
const GH = 10;

function kernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

function blur(src, w, h, sigma) {
  const k = kernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) { const xx = x + i; if (xx >= 0 && xx < w) v += src[y * w + xx] * k[i + r]; }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) { const yy = y + i; if (yy >= 0 && yy < h) v += tmp[yy * w + x] * k[i + r]; }
      out[y * w + x] = v;
    }
  }
  return out;
}

// the album cover: a flat square with one blurry lowercase word.
// 1 terminal cell = 1px wide, 2px tall (upper half block), so w cols x h/2 rows is square.
export class Cover {
  constructor({ word = 'brat', w = 30, h = 30 } = {}) {
    this.w = w;
    this.h = h;
    this.rows = h / 2;
    this.cache = new Map();
    this.field = new Float32Array(w * h);
    let tw = GAP * (word.length - 1);
    for (const ch of word) tw += G[ch][0].length;
    let x = Math.floor((w - tw) / 2);
    const y0 = Math.max(0, Math.round((h - GH) / 2) - 2);
    for (const ch of word) {
      const g = G[ch];
      for (let j = 0; j < GH; j++) for (let i = 0; i < g[j].length; i++) if (g[j][i] === '#') this.field[(y0 + j) * w + x + i] = 1;
      x += g[0].length + GAP;
    }
  }

  blurred(sigma) {
    const q = Math.round(sigma * 20);
    if (q <= 1) return this.field;
    let f = this.cache.get(q);
    if (!f) {
      f = blur(this.field, this.w, this.h, q / 20);
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(q, f);
    }
    return f;
  }

  // scaleX < 1 squeezes the sleeve around its center (used for the flip)
  draw(s, x, y, { color, ink, sigma, alpha = 1, scaleX = 1 }) {
    const f = this.blurred(sigma);
    const boost = 1.1 + sigma * 0.4;
    const px = (i) => {
      const a = Math.min(1, f[i] * boost) * alpha;
      return a > 0.004 ? mix(color, ink, a) : color;
    };
    const wd = Math.max(2, Math.round(this.w * scaleX));
    const x0 = x + Math.floor((this.w - wd) / 2);
    for (let cy = 0; cy < this.rows; cy++) {
      for (let dx = 0; dx < wd; dx++) {
        const sx = Math.min(this.w - 1, Math.floor(((dx + 0.5) / wd) * this.w));
        s.put(x0 + dx, y + cy, '\u2580', px(cy * 2 * this.w + sx), px((cy * 2 + 1) * this.w + sx));
      }
    }
  }
}
