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
  ${G}${B}bratcode${R} ${VERSION}  a full desktop & coding agent cli that is so brat.

  ${B}usage${R}
    bratcode                 start (live: your accounts, your mac, your telegram)
    bratcode --demo          design preview, nothing is connected
    bratcode --no-anim       turn off animations
    bratcode --version

  ${B}env${R}
    BRATCODE_COLORS=256      force 256 colors (for terminals without truecolor)
    BRATCODE_NO_TUNNEL=1     local sandbox only (no public https url)
    BRATCODE_DATA=<dir>      state dir (default ~/.bratcode-data)

  ${B}inside${R}
    tab flip the record   ctrl+p commands   / palette   ctrl+c twice to quit
    /accounts  /tg  /balance  /model  /undo  /stop
`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('bratcode needs an interactive terminal.');
  process.exit(1);
}

const { App } = await import('../src/app.js');
const anim = !has('--no-anim');

if (has('--demo')) {
  new App({ anim }).start();
} else {
  let brain = null;
  try {
    const { createBrain } = await import('../src/brain.js');
    brain = await createBrain({ cwd: process.cwd() });
  } catch (e) {
    console.error(`bratcode: could not start the brain (${(e && e.message) || e}).\nrun "bratcode --demo" for the design preview.`);
    process.exit(1);
  }
  const app = new App({ anim, brain, onQuit: () => brain.close() });
  app.start();
  brain.warm(); // balances are true from the first seconds
}
