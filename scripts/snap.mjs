// headless renderer: draws App frames to SVG (dev tool, makes the screenshots in docs/)
import fs from 'node:fs';
import { App } from '../src/app.js';

const CW = 10, CH = 21;
const col = (c) => '#' + c.toString(16).padStart(6, '0');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function toSvg(app) {
  const s = app.screen;
  let o = `<svg xmlns="http://www.w3.org/2000/svg" width="${s.w * CW}" height="${s.h * CH}" font-family="DejaVu Sans Mono" font-size="16.6">`;
  o += `<rect width="100%" height="100%" fill="${col(s.bg[0])}"/>`;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const k = y * s.w + x;
      if (s.bg[k] === 0 && s.ch[k] !== '\u2580') continue;
      if (s.ch[k] === '\u2580') {
        o += `<rect x="${x * CW}" y="${y * CH}" width="${CW + 0.5}" height="${CH + 0.5}" fill="${col(s.bg[k])}"/>`;
        o += `<rect x="${x * CW}" y="${y * CH}" width="${CW + 0.5}" height="${CH / 2}" fill="${col(s.fg[k])}"/>`;
      } else {
        o += `<rect x="${x * CW}" y="${y * CH}" width="${CW + 0.5}" height="${CH + 0.5}" fill="${col(s.bg[k])}"/>`;
      }
    }
  }
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const k = y * s.w + x;
      const c = s.ch[k];
      if (c === ' ' || c === '\0' || c === '\u2580') continue;
      const w = s.at[k] & 1 ? ' font-weight="bold"' : '';
      o += `<text x="${x * CW}" y="${y * CH + CH - 6}" fill="${col(s.fg[k])}"${w}>${esc(c)}</text>`;
    }
  }
  return o + '</svg>';
}

export function make(opts = {}) {
  let t = 0;
  const app = new App({ out: null, cols: 100, rows: 30, truecolor: true, cwd: '/home/user/webapp', clock: () => t, placeholder: 'what is the tech stack of this project?', ...opts });
  app.at = (ms) => { t = ms; };
  app.shot = (file) => { app.draw(); fs.writeFileSync(file, toSvg(app)); };
  app.dir = '~/my-app';
  app.branch = 'main';
  return app;
}

if (process.argv[1].endsWith('snap.mjs')) {
  const out = process.argv[2] || '/tmp/snaps';
  fs.mkdirSync(out, { recursive: true });
  const a = make(); a.at(0); a.shot(`${out}/01-intro.svg`);
  a.at(1000); a.shot(`${out}/02-intro-mid.svg`);
  a.at(5000); a.shot(`${out}/03-home.svg`);
  a.key({ name: 'tab' }); a.at(5250); a.shot(`${out}/04-flip.svg`); a.at(7000); a.shot(`${out}/05-side-b.svg`);
  const b = make(); b.at(5000);
  b.input.set('fix the bug in my login form, and make it iconic');
  b.key({ name: 'enter' });
  b.at(5300); b.shot(`${out}/06-thinking.svg`);
  b.at(7200); b.shot(`${out}/07-typing.svg`);
  b.at(12000); b.input.set('now with tests'); b.shot(`${out}/08-done.svg`);
  const c = make(); c.at(1000); c.demo(); c.at(10000); c.shot(`${out}/09-demo.svg`);
  const d = make(); d.at(5000); d.key({ name: 'char', text: '/' }); d.shot(`${out}/10-palette.svg`);
  const f = make({ cols: 60, rows: 18 }); f.at(5000); f.shot(`${out}/11-small.svg`);
}
