// renders the demo flow as SVG frames into a dir (shell turns them into docs/demo.gif)
import fs from 'node:fs';
import { make, toSvg } from './snap.mjs';
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
let n = 0;
const save = (a) => { a.draw(); fs.writeFileSync(`${out}/f${String(n++).padStart(3, '0')}.svg`, toSvg(a)); };
const a = make({ cols: 92, rows: 24, placeholder: 'make it brat' });
let t = 0;
for (; t <= 2400; t += 80) { a.at(t); save(a); }                 // intro: cover pulls into focus
for (; t <= 3600; t += 200) { a.at(t); save(a); }
const msg = 'fix the login bug, make it iconic';
for (const ch of msg) { t += 60; a.at(t); a.lastKey = t; a.key({ name: 'char', text: ch }); save(a); }
t += 300; a.at(t); a.key({ name: 'enter' }); const t0 = t;
for (; t < t0 + 5600; t += 100) { a.at(t); save(a); }            // thinking, reply, track time
// flip to side b on a fresh home screen
const b = make({ cols: 92, rows: 24, placeholder: 'make it brat' });
let u = 6000; b.at(u); for (let i = 0; i < 6; i++) save(b);
b.key({ name: 'tab' });
for (let i = 0; i < 14; i++) { u += 60; b.at(u); save(b); }
for (let i = 0; i < 10; i++) { u += 150; b.at(u); save(b); }
b.key({ name: 'tab' });
for (let i = 0; i < 14; i++) { u += 60; b.at(u); save(b); }
for (let i = 0; i < 6; i++) { u += 150; b.at(u); save(b); }
console.log(n, 'frames');
