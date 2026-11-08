// renders intro + chat flow frames as SVG into a dir (converted to GIF by shell)
import fs from 'node:fs';
import { make, toSvg } from './snap.mjs';
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
let n = 0;
const save = (a) => { a.draw(); fs.writeFileSync(`${out}/f${String(n++).padStart(3, '0')}.svg`, toSvg(a)); };
const a = make({ cols: 88, rows: 26, placeholder: 'make it brat' });
// intro 0..2.4s @ 12fps
for (let t = 0; t <= 2600; t += 80) { a.at(t); save(a); }
for (let t = 2600; t <= 3400; t += 200) { a.at(t); save(a); }
// typing
const msg = 'fix the bug in my login form, make it iconic';
let t = 3400;
for (const ch of msg) { a.at(t); a.lastKey = t; a.key({ name: 'char', text: ch }); t += 55; if (n % 2 === 0) save(a); else a.draw(); n++; }
a.at(t); save(a); t += 250;
a.at(t); a.key({ name: 'enter' }); const t0 = t;
for (; t < t0 + 6200; t += 100) { a.at(t); save(a); }
// switch to demure
a.at(t); a.key({ name: 'tab' }); save(a); t += 400; a.at(t); save(a);
for (let i = 0; i < 8; i++) { t += 150; a.at(t); save(a); }
console.log(n, 'frames');
