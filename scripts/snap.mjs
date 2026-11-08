// headless snapshot: renders App frames to SVG (dev tool, used for screenshots in README)
import fs from 'node:fs';
import { App } from '../src/app.js';

const CW = 10, CH = 21;
const col = (c) => '#' + c.toString(16).padStart(6, '0');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function toSvg(app) {
  const s = app.screen;
  let o = `<svg xmlns="http://www.w3.org/2000/svg" width="${s.w * CW}" height="${s.h * CH}" font-family="DejaVu Sans Mono" font-size="16.6">`;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const k = y * s.w + x;
      o += `<rect x="${x * CW}" y="${y * CH}" width="${CW + 0.5}" height="${CH + 0.5}" fill="${col(s.bg[k])}"/>`;
    }
  }
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const k = y * s.w + x;
      const c = s.ch[k];
      if (c === ' ' || c === '\0') continue;
      const bx = x * CW, by = y * CH;
      if (c === '\u2580') { o += `<rect x="${bx}" y="${by}" width="${CW + 0.5}" height="${CH / 2 + 0.25}" fill="${col(s.fg[k])}"/>`; continue; }
      if (c === '\u258c') { o += `<rect x="${bx}" y="${by}" width="${CW / 2}" height="${CH + 0.5}" fill="${col(s.fg[k])}"/>`; continue; }
      const w = s.at[k] & 1 ? ' font-weight="bold"' : '';
      const u = s.at[k] & 8 ? ' text-decoration="underline"' : '';
      o += `<text x="${bx}" y="${by + CH - 6}" fill="${col(s.fg[k])}"${w}${u}>${esc(c)}</text>`;
    }
  }
  return o + '</svg>';
}

export function make(opts = {}) {
  let t = 0;
  const app = new App({ out: null, cols: 100, rows: 30, truecolor: true, cwd: '/home/user/webapp', clock: () => t, tip: ['tab', 'switches between brat and demure'], placeholder: 'what is the tech stack of this project?', ...opts });
  app.at = (ms) => { t = ms; };
  app.shot = (file) => { app.draw(); fs.writeFileSync(file, toSvg(app)); };
  app.dir = '~/my-app';
  app.branch = 'main';
  return app;
}

if (process.argv[1].endsWith('snap.mjs')) {
  const out = process.argv[2] || '/tmp/snaps';
  fs.mkdirSync(out, { recursive: true });
  const a = make(); a.at(0); a.shot(`${out}/01-intro-0.svg`);
  a.at(900); a.shot(`${out}/02-intro-mid.svg`);
  a.at(3000); a.shot(`${out}/03-home.svg`);
}

if (process.argv[1].endsWith('snap.mjs')) {
  const out = process.argv[2] || '/tmp/snaps';
  const a = make(); a.at(5000);
  a.shot(`${out}/03-home.svg`);
  // chat flow
  const b = make(); b.at(5000);
  b.input.set('fix the bug in my login form, and make it iconic');
  b.key({ name: 'enter' });
  b.at(5300); b.shot(`${out}/04-thinking.svg`);
  b.at(7000); b.shot(`${out}/05-typing.svg`);
  b.at(12000); b.input.set('now with tests'); b.shot(`${out}/06-done.svg`);
  // demure + demo
  const c = make(); c.at(1000); c.key({ name: 'tab' }); c.at(1100); c.shot(`${out}/07-demure.svg`);
  c.key({ name: 'tab' }); c.demo(); c.at(1100 + 9000); c.shot(`${out}/08-demo.svg`);
  // palette
  const d = make(); d.at(5000); d.key({ name: 'char', text: '/' }); d.shot(`${out}/09-palette.svg`);
  // dark theme
  const e = make({ theme: 'dark' }); e.at(5000); e.shot(`${out}/10-dark.svg`);
  // small
  const f = make({ cols: 60, rows: 18 }); f.at(5000); f.shot(`${out}/11-small.svg`);
}
