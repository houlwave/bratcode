// low-level terminal toolkit: colors, cell buffer, diff renderer. zero deps.

export const BOLD = 1;
export const ITALIC = 4;
export const UNDERLINE = 8;

export const hex = (s) => parseInt(s.slice(1), 16);
const pack = (r, g, b) => (r << 16) | (g << 8) | b;

export function mix(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return pack(
    Math.round(ar + (br - ar) * t),
    Math.round(ag + (bg - ag) * t),
    Math.round(ab + (bb - ab) * t),
  );
}

// ---- character widths -------------------------------------------------------
export function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x2060 || cp === 0xfeff
  ) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function strWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

// ---- 256 color fallback (macOS Terminal.app has no truecolor) --------------
const LV = [0, 95, 135, 175, 215, 255];
const q256 = new Map();
function nearestLevel(v) {
  let bi = 0, bd = 1e9;
  for (let i = 0; i < 6; i++) {
    const d = Math.abs(LV[i] - v);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}
function to256(c) {
  let n = q256.get(c);
  if (n !== undefined) return n;
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const ri = nearestLevel(r), gi = nearestLevel(g), bi = nearestLevel(b);
  const cr = LV[ri], cg = LV[gi], cb = LV[bi];
  const dc = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
  const avg = (r + g + b) / 3;
  const gl = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + gl * 10;
  const dg = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
  n = dg < dc ? 232 + gl : 16 + 36 * ri + 6 * gi + bi;
  q256.set(c, n);
  return n;
}

export function detectTruecolor(env = process.env) {
  const o = (env.BRATCODE_COLORS || '').toLowerCase();
  if (o === '256') return false;
  if (o === 'truecolor' || o === '24bit') return true;
  if (/truecolor|24bit/i.test(env.COLORTERM || '')) return true;
  if (env.WT_SESSION || env.KITTY_WINDOW_ID) return true;
  if (['iTerm.app', 'vscode', 'WezTerm', 'ghostty', 'Hyper', 'rio'].includes(env.TERM_PROGRAM)) return true;
  if (/kitty|alacritty|ghostty|wezterm|direct/i.test(env.TERM || '')) return true;
  return false;
}

// ---- screen buffer ---------------------------------------------------------
export class Screen {
  constructor(w, h, truecolor) {
    this.truecolor = truecolor;
    this.resize(w, h);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.ch = new Array(n).fill(' ');
    this.fg = new Int32Array(n);
    this.bg = new Int32Array(n);
    this.at = new Uint8Array(n);
    this.prev = new Array(h).fill(null);
  }

  invalidate() { this.prev.fill(null); }

  clear(bg, fg) {
    this.ch.fill(' ');
    this.fg.fill(fg);
    this.bg.fill(bg);
    this.at.fill(0);
  }

  rect(x, y, w, h, bg) {
    const x0 = Math.max(0, x), x1 = Math.min(this.w, x + w);
    const y0 = Math.max(0, y), y1 = Math.min(this.h, y + h);
    for (let j = y0; j < y1; j++) {
      for (let i = x0; i < x1; i++) {
        const k = j * this.w + i;
        this.ch[k] = ' ';
        this.bg[k] = bg;
      }
    }
  }

  put(x, y, c, fg, bg = -1, at = 0) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const k = y * this.w + x;
    // never leave half of a wide char behind
    if (this.ch[k] === '\0' && x > 0) this.ch[k - 1] = ' ';
    if (x + 1 < this.w && this.ch[k + 1] === '\0') this.ch[k + 1] = ' ';
    this.ch[k] = c;
    this.fg[k] = fg;
    if (bg !== -1) this.bg[k] = bg;
    this.at[k] = at;
  }

  // draws text, returns the x after the last cell
  text(x, y, s, fg, bg = -1, at = 0, maxX = this.w) {
    for (const ch of s) {
      const cw = charWidth(ch.codePointAt(0));
      if (cw === 0) continue;
      if (x + cw > maxX) break;
      this.put(x, y, ch, fg, bg, at);
      if (cw === 2) this.put(x + 1, y, '\0', fg, bg, at);
      x += cw;
    }
    return x;
  }

  sgr(fg, bg, at) {
    let s = '\x1b[0';
    if (at & BOLD) s += ';1';
    if (at & ITALIC) s += ';3';
    if (at & UNDERLINE) s += ';4';
    if (this.truecolor) {
      s += `;38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}`;
      s += `;48;2;${(bg >> 16) & 255};${(bg >> 8) & 255};${bg & 255}`;
    } else {
      s += `;38;5;${to256(fg)};48;5;${to256(bg)}`;
    }
    return s + 'm';
  }

  // returns an escape string containing only the rows that changed
  render() {
    let out = '';
    for (let y = 0; y < this.h; y++) {
      let row = '';
      let cfg = -2, cbg = -2, cat = -1;
      for (let x = 0; x < this.w; x++) {
        const k = y * this.w + x;
        const c = this.ch[k];
        if (c === '\0') continue;
        const f = this.fg[k], b = this.bg[k], a = this.at[k];
        if (f !== cfg || b !== cbg || a !== cat) {
          row += this.sgr(f, b, a);
          cfg = f; cbg = b; cat = a;
        }
        row += c;
      }
      if (row !== this.prev[y]) {
        this.prev[y] = row;
        out += `\x1b[${y + 1};1H${row}`;
      }
    }
    return out;
  }
}
