import { charWidth, strWidth } from './term.js';

export class TextBuffer {
  constructor() { this.c = []; this.i = 0; }
  get text() { return this.c.join(''); }
  get empty() { return this.c.length === 0; }
  set(t) { this.c = Array.from(t); this.i = this.c.length; }
  clear() { this.c = []; this.i = 0; }
  insert(str) {
    const a = Array.from(str);
    this.c = [...this.c.slice(0, this.i), ...a, ...this.c.slice(this.i)];
    this.i += a.length;
  }
  backspace() { if (this.i > 0) { this.c.splice(this.i - 1, 1); this.i--; } }
  del() { this.c.splice(this.i, 1); }
  left() { if (this.i > 0) this.i--; }
  right() { if (this.i < this.c.length) this.i++; }
  lineStart() { let j = this.i; while (j > 0 && this.c[j - 1] !== '\n') j--; return j; }
  lineEnd() { let j = this.i; while (j < this.c.length && this.c[j] !== '\n') j++; return j; }
  home() { this.i = this.lineStart(); }
  end() { this.i = this.lineEnd(); }
  killToStart() { const s = this.lineStart(); this.c.splice(s, this.i - s); this.i = s; }
  killToEnd() { const e = this.lineEnd(); this.c.splice(this.i, e - this.i); }
  wordBack() {
    let j = this.i;
    while (j > 0 && /\s/.test(this.c[j - 1])) j--;
    while (j > 0 && !/\s/.test(this.c[j - 1])) j--;
    return j;
  }
  wordFwd() {
    let j = this.i;
    while (j < this.c.length && /\s/.test(this.c[j])) j++;
    while (j < this.c.length && !/\s/.test(this.c[j])) j++;
    return j;
  }
  deleteWordBack() { const j = this.wordBack(); this.c.splice(j, this.i - j); this.i = j; }
  moveWordBack() { this.i = this.wordBack(); }
  moveWordFwd() { this.i = this.wordFwd(); }
  up() {
    const s = this.lineStart();
    if (s === 0) return false;
    const col = this.i - s;
    const prevEnd = s - 1;
    let k = prevEnd;
    while (k > 0 && this.c[k - 1] !== '\n') k--;
    this.i = Math.min(k + col, prevEnd);
    return true;
  }
  down() {
    const e = this.lineEnd();
    if (e >= this.c.length) return false;
    const col = this.i - this.lineStart();
    const ns = e + 1;
    let ne = ns;
    while (ne < this.c.length && this.c[ne] !== '\n') ne++;
    this.i = Math.min(ns + col, ne);
    return true;
  }
  // soft-wrap into rows of `width` cells, return rows + cursor position
  layout(width) {
    const rows = [''];
    let row = 0, col = 0, cur = { row: 0, col: 0 };
    for (let idx = 0; idx <= this.c.length; idx++) {
      const ch = this.c[idx];
      if (ch !== undefined && ch !== '\n') {
        const cw = charWidth(ch.codePointAt(0));
        if (col + cw > width) { rows.push(''); row++; col = 0; }
      } else if (ch === undefined && col >= width) {
        rows.push(''); row++; col = 0;
      }
      if (idx === this.i) cur = { row, col };
      if (ch === undefined) break;
      if (ch === '\n') { rows.push(''); row++; col = 0; continue; }
      rows[row] += ch;
      col += charWidth(ch.codePointAt(0));
    }
    return { rows, cur };
  }
}

export function wrapText(text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '', lw = 0;
    for (const word of para.split(' ')) {
      const ww = strWidth(word);
      if (ww > width) {
        if (line) { out.push(line); line = ''; lw = 0; }
        let chunk = '', cw = 0;
        for (const ch of word) {
          const w = charWidth(ch.codePointAt(0));
          if (cw + w > width) { out.push(chunk); chunk = ''; cw = 0; }
          chunk += ch; cw += w;
        }
        line = chunk; lw = cw;
        continue;
      }
      if (line === '') { line = word; lw = ww; }
      else if (lw + 1 + ww <= width) { line += ' ' + word; lw += 1 + ww; }
      else { out.push(line); line = word; lw = ww; }
    }
    out.push(line);
  }
  return out;
}
