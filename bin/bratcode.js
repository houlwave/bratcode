#!/usr/bin/env node
import { VERSION } from '../src/app.js';

const args = process.argv.slice(2);
const has = (...f) => f.some((x) => args.includes(x));
const G = '\x1b[38;2;138;206;0m';
const R = '\x1b[0m';
const B = '\x1b[1m';

if (has('-v', '--version')) {
  console.log(`bratcode ${VERSION}`);
  process.exit(0);
}

if (has('-h', '--help')) {
  console.log(`
  ${G}${B}bratcode${R} ${VERSION}  a coding agent cli that is so brat.
  (design preview: the ui is real, the brain is not connected yet)

  ${B}usage${R}
    bratcode                 start
    bratcode --theme dark    brat | dark
    bratcode --no-anim       turn off animations
    bratcode --version

  ${B}env${R}
    BRATCODE_COLORS=256      force 256 colors (for terminals without truecolor)

  ${B}inside${R}
    tab mode   ctrl+p commands   / palette   ctrl+c twice to quit
`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('bratcode needs an interactive terminal.');
  process.exit(1);
}

const ti = args.indexOf('--theme');
const theme = ti >= 0 ? args[ti + 1] : undefined;

const { App } = await import('../src/app.js');
new App({ theme, anim: !has('--no-anim') }).start();
