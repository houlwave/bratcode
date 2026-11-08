import { mix } from './term.js';

// pixel font, 10 rows tall (x-height starts at row 3). stroke = 2px.
const G = {
  b: ['##....', '##....', '##....', '#####.', '######', '##..##', '##..##', '##..##', '######', '#####.'],
  r: ['.....', '.....', '.....', '##.##', '#####', '###..', '##...', '##...', '##...', '##...'],
  a: ['......', '......', '......', '.####.', '##..##', '....##', '.#####', '##..##', '##..##', '.#####'],
  t: ['.....', '.##..', '.##..', '#####', '#####', '.##..', '.##..', '.##..', '.##.#', '..###'],
  c: ['......', '......', '......', '.#####', '######', '##....', '##....', '##....', '######', '.#####'],
  o: ['......', '......', '......', '.####.', '######', '##..##', '##..##', '##..##', '######', '.####.'],
  d: ['....##', '....##', '....##', '.#####', '######', '##..##', '##..##', '##..##', '######', '.#####'],
  e: ['......', '......', '......', '.####.', '##..##', '######', '######', '##....', '##...#', '.####.'],
};

const GAP = 2;
const PADX = 4;
const PADY = 3;
const GLYPH_H = 10;

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

function blur(src, w, h, sigma) {
  if (sigma < 0.05) return src;
  const k = gaussKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < w) v += src[y * w + xx] * k[i + r];
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < h) v += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

export class Logo {
  constructor(groups = ['brat', 'code']) {
    let total = 0;
    for (const word of groups.join('').split('')) total += G[word][0].length;
    total += GAP * (groups.join('').length - 1);

    this.w = total + PADX * 2;
    this.h = GLYPH_H + PADY * 2;
    this.rows = this.h / 2;
    this.layers = groups.map(() => new Float32Array(this.w * this.h));

    let x = PADX;
    groups.forEach((word, gi) => {
      for (const ch of word) {
        const g = G[ch];
        for (let j = 0; j < GLYPH_H; j++) {
          for (let i = 0; i < g[j].length; i++) {
            if (g[j][i] === '#') this.layers[gi][(PADY + j) * this.w + x + i] = 1;
          }
        }
        x += g[0].length + GAP;
      }
    });
    this.cache = new Map();
  }

  // blurred copy of one layer, cached per quantized sigma
  layer(i, sigma) {
    const q = Math.round(sigma * 20);
    if (q <= 1) return this.layers[i];
    const key = i * 1000 + q;
    let f = this.cache.get(key);
    if (!f) {
      f = blur(this.layers[i], this.w, this.h, q / 20);
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(key, f);
    }
    return f;
  }

  // each terminal cell = 2 vertical pixels (upper half block: fg=top, bg=bottom)
  // sigmas: number | number[] (blur radius per word, 0 = razor sharp)
  draw(s, x, y, sigmas, bg, colors) {
    const sg = (l) => (Array.isArray(sigmas) ? sigmas[l] : sigmas);
    const layers = colors.map((_, l) => this.layer(l, sg(l)));
    const boost = colors.map((_, l) => 1.1 + sg(l) * 0.4);
    const px = (i) => {
      let c = bg;
      for (let l = 0; l < layers.length; l++) {
        const a = Math.min(1, layers[l][i] * boost[l]);
        if (a > 0.004) c = mix(c, colors[l], a);
      }
      return c;
    };
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.w; cx++) {
        const top = px(cy * 2 * this.w + cx);
        const bot = px((cy * 2 + 1) * this.w + cx);
        if (top === bg && bot === bg) continue;
        s.put(x + cx, y + cy, '\u2580', top, bot);
      }
    }
  }
}
