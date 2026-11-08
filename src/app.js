import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Screen, detectTruecolor, mix, BOLD, ITALIC } from './term.js';
import { C, MODES } from './theme.js';
import { Cover } from './cover.js';
import { parseKeys } from './keys.js';
import { TextBuffer, wrapText } from './text.js';

export const VERSION = '0.1.0';
const MODEL = 'brat-1';

const VERBS = [
  'von dutch-ing', 'club classic-ing', 'apple dancing', '365 partying', 'talk talk-ing',
  'b2b-ing', 'rewinding', 'being brat', 'guessing', 'sympathy-ing',
];
const PLACEHOLDERS = [
  'make it brat', 'fix the bug, bestie', 'refactor this but make it iconic',
  'write tests, no excuses', 'what is the tech stack of this project?',
  'explain this repo like i am five',
];
const HINTS = [['tab', 'flip'], ['ctrl+p', 'commands']];
const EQ = ' \u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
const COVER = 30;

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDur = (ms) => `${Math.floor(ms / 60000)}:${pad2(Math.floor(ms / 1000) % 60)}`;

function homeify(p) {
  const h = os.homedir();
  return p === h ? '~' : p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

function gitBranch(dir) {
  let d = dir;
  for (let i = 0; i < 8; i++) {
    try {
      const head = fs.readFileSync(path.join(d, '.git', 'HEAD'), 'utf8').trim();
      const m = head.match(/^ref: refs\/heads\/(.+)$/);
      return m ? m[1] : head.slice(0, 7);
    } catch { /* keep walking up */ }
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return null;
}

const COMMANDS = [
  { id: 'new', title: 'new session', hint: 'ctrl+n' },
  { id: 'mode', title: 'flip the record', hint: 'tab' },
  { id: 'demo', title: 'show demo session', hint: '' },
  { id: 'keys', title: 'keyboard shortcuts', hint: '' },
  { id: 'exit', title: 'exit', hint: 'ctrl+d' },
];

export class App {
  constructor(o = {}) {
    this.out = o.out === undefined ? process.stdout : o.out;
    const cols = o.cols || this.out?.columns || 100;
    const rows = o.rows || this.out?.rows || 30;
    this.screen = new Screen(cols, rows, o.truecolor ?? detectTruecolor());
    this.anim = o.anim !== false;
    this.clock = o.clock || (() => performance.now());
    this.cwd = o.cwd || process.cwd();
    this.dir = homeify(this.cwd);
    this.branch = gitBranch(this.cwd);

    this.cover = new Cover({ word: 'brat', w: COVER, h: COVER });
    this.modeKey = 'brat';
    this.prevKey = 'brat';
    this.flipAt = -1e9;
    this.input = new TextBuffer();
    this.history = [];
    this.histIdx = -1;
    this.draft = '';
    this.messages = [];
    this.scroll = 0;
    this.view = 'home';
    this.palette = null;
    this.toast = null;
    this.quitArm = -1e9;
    this.placeholder = o.placeholder || pick(PLACEHOLDERS);
    this.introAt = this.clock();
    this.lastKey = -1e9;
    this.timer = null;
    this.onQuit = o.onQuit || (() => {});
  }

  get mode() { return MODES[this.modeKey]; }
  get busy() { return this.messages.some((m) => m.role === 'bot' && !m.done); }
  get trackNo() { return this.messages.filter((m) => m.role === 'user').length + 1; }

  // ---------------------------------------------------------------- lifecycle
  start() {
    const { out } = this;
    out.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h\x1b]0;bratcode\x07\x1b[2J');
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      for (const k of parseKeys(d)) this.key(k);
      this.frame();
    });
    out.on('resize', () => {
      this.screen.resize(out.columns, out.rows);
      out.write('\x1b[2J');
      this.frame();
    });
    for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => this.quit());
    process.on('exit', () => this.restore());
    this.timer = setInterval(() => this.frame(), 33);
    this.frame();
  }

  restore() {
    if (this.restored) return;
    this.restored = true;
    this.out.write('\x1b[0m\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l');
    try { process.stdin.setRawMode(false); } catch { /* not a tty */ }
  }

  quit() {
    clearInterval(this.timer);
    this.restore();
    const g = this.screen.truecolor ? '\x1b[38;2;138;206;0m' : '\x1b[38;5;112m';
    this.out.write(`\n  ${g}\x1b[1mbye.\x1b[0m stay ${g}\x1b[1mbrat\x1b[0m.\n\n`);
    this.onQuit();
    process.exit(0);
  }

  frame() {
    this.draw();
    const s = this.screen.render();
    if (s) this.out.write(s);
  }

  // ---------------------------------------------------------------- input
  say(text, ms = 2200) { this.toast = { text, until: this.clock() + ms }; }

  key(k) {
    const now = this.clock();
    this.lastKey = now;
    if (this.palette) return this.paletteKey(k);
    const inp = this.input;

    if (k.name === 'paste') { inp.insert(k.text.replace(/\r\n?/g, '\n')); return; }
    if (k.ctrl) {
      switch (k.name) {
        case 'c':
          if (!inp.empty) { inp.clear(); this.histIdx = -1; return; }
          if (now - this.quitArm < 1600) return this.quit();
          this.quitArm = now;
          return this.say('press ctrl+c again to exit');
        case 'd': if (inp.empty) return this.quit(); return inp.del();
        case 'p': return this.openPalette('');
        case 'n': return this.run('new');
        case 'l': this.screen.invalidate(); this.introAt = now; return;
        case 'j': return inp.insert('\n');
        case 'a': return inp.home();
        case 'e': return inp.end();
        case 'u': return inp.killToStart();
        case 'k': return inp.killToEnd();
        case 'w': return inp.deleteWordBack();
        case 'b': return inp.left();
        case 'f': return inp.right();
        case 'left': return inp.moveWordBack();
        case 'right': return inp.moveWordFwd();
        default: return;
      }
    }
    switch (k.name) {
      case 'tab': return this.flip(k.shift ? -1 : 1);
      case 'escape': if (this.busy) this.stopBot(); return;
      case 'enter':
        if (k.alt || k.shift) return inp.insert('\n');
        if (inp.text.endsWith('\\')) { inp.backspace(); return inp.insert('\n'); }
        return this.submit();
      case 'backspace': return k.alt ? inp.deleteWordBack() : inp.backspace();
      case 'delete': return inp.del();
      case 'left': return k.alt ? inp.moveWordBack() : inp.left();
      case 'right': return k.alt ? inp.moveWordFwd() : inp.right();
      case 'home': return inp.home();
      case 'end': return inp.end();
      case 'up': if (!inp.up()) this.histMove(1); return;
      case 'down': if (!inp.down()) this.histMove(-1); return;
      case 'pageup': this.scroll += Math.max(3, this.screen.h - 10); return;
      case 'pagedown': this.scroll = Math.max(0, this.scroll - Math.max(3, this.screen.h - 10)); return;
      case 'char':
        if (k.alt) {
          if (k.text === 'b') return inp.moveWordBack();
          if (k.text === 'f') return inp.moveWordFwd();
          return;
        }
        if (k.text === '/' && inp.empty) return this.openPalette('');
        return inp.insert(k.text);
      default:
    }
  }

  histMove(dir) {
    if (!this.history.length) return;
    if (dir > 0) {
      if (this.histIdx === -1) this.draft = this.input.text;
      this.histIdx = Math.min(this.history.length - 1, this.histIdx + 1);
    } else {
      if (this.histIdx === -1) return;
      this.histIdx--;
    }
    this.input.set(this.histIdx === -1 ? this.draft : this.history[this.history.length - 1 - this.histIdx]);
  }

  // tab = turn the record over: side a (brat) <-> side b (demure)
  flip() {
    const keys = Object.keys(MODES);
    this.prevKey = this.modeKey;
    this.modeKey = keys[(keys.indexOf(this.modeKey) + 1) % keys.length];
    this.flipAt = this.anim ? this.clock() : -1e9;
    if (this.view === 'chat') this.say(`side ${this.mode.side}: ${this.mode.label}, ${this.mode.blurb}`);
  }

  // color of the accent right now (cross-fades while flipping)
  accent(now) {
    const t = clamp((now - this.flipAt) / 360, 0, 1);
    return mix(MODES[this.prevKey].color, this.mode.color, t);
  }

  openPalette(query) { this.palette = { query, sel: 0 }; }

  paletteItems() {
    const q = this.palette.query.trim().toLowerCase();
    return COMMANDS.filter((c) => !q || c.title.includes(q) || c.id.includes(q));
  }

  paletteKey(k) {
    const p = this.palette;
    const items = this.paletteItems();
    if (k.name === 'escape' || (k.ctrl && (k.name === 'c' || k.name === 'p'))) { this.palette = null; return; }
    if (k.name === 'up' || (k.ctrl && k.name === 'k')) { p.sel = (p.sel - 1 + items.length) % Math.max(1, items.length); return; }
    if (k.name === 'down' || k.name === 'tab' || (k.ctrl && k.name === 'n')) { p.sel = (p.sel + 1) % Math.max(1, items.length); return; }
    if (k.name === 'enter') {
      const it = items[p.sel];
      this.palette = null;
      if (it) this.run(it.id);
      return;
    }
    if (k.name === 'backspace') {
      if (!p.query) { this.palette = null; return; }
      p.query = Array.from(p.query).slice(0, -1).join('');
      p.sel = 0;
      return;
    }
    if (k.name === 'char' && !k.alt) { p.query += k.text; p.sel = 0; }
    if (k.name === 'paste') { p.query += k.text.replace(/\s+/g, ' '); p.sel = 0; }
  }

  run(id) {
    switch (id) {
      case 'new':
        this.messages = [];
        this.scroll = 0;
        this.view = 'home';
        this.input.clear();
        this.introAt = this.clock();
        this.placeholder = pick(PLACEHOLDERS);
        break;
      case 'mode': this.flip(); break;
      case 'demo': this.demo(); break;
      case 'keys': this.help(); break;
      case 'exit': this.quit(); break;
      default:
    }
  }

  // ---------------------------------------------------------------- stubs
  submit() {
    const text = this.input.text.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      const id = text.slice(1).split(/\s+/)[0].toLowerCase();
      const alias = { help: 'keys', quit: 'exit', q: 'exit', clear: 'new', flip: 'mode' }[id] || id;
      if (COMMANDS.some((c) => c.id === alias)) {
        this.input.clear();
        return this.run(alias);
      }
    }
    if (this.busy) return this.say('one sec, being iconic');
    this.history.push(text);
    this.histIdx = -1;
    this.input.clear();
    this.view = 'chat';
    this.scroll = 0;
    this.send(text);
  }

  // the stub: no brain yet, only a very pretty reply
  send(text) {
    const now = this.clock();
    const echo = text.replace(/\s+/g, ' ').slice(0, 64);
    const brat = this.modeKey === 'brat';
    const user = { role: 'user', text, mode: this.modeKey };
    const bot = {
      role: 'bot',
      mode: this.modeKey,
      steps: [brat
        ? { label: 'checked the vibe', detail: '0 files, 0 problems' }
        : { label: 'planned very mindfully', detail: '1 step' }],
      text: brat
        ? `heyyy. i am only the cover for now: no band, no brain yet. nothing is connected, so i cannot touch your code.\n\nbut i heard you: "${echo}". the real tracks drop soon. stay brat.`
        : `very mindful. i am just the sleeve for now, so i will not touch your files.\n\nyou said "${echo}". noted, very quietly. the real music comes later.`,
      t0: now,
      thinkMs: this.anim ? 1100 + Math.random() * 700 : 0,
      cps: this.anim ? 80 : 1e6,
      verb: pick(VERBS),
      done: false,
    };
    user.bot = bot;
    this.messages.push(user, bot);
  }

  demo() {
    const now = this.clock();
    this.view = 'chat';
    this.scroll = 0;
    const user = { role: 'user', text: 'make the vibes more brat, please', mode: this.modeKey };
    const bot = {
      role: 'bot',
      mode: this.modeKey,
      steps: [
        { label: 'checked the vibe', detail: '3 files' },
        { label: 'edited src/vibes.ts', detail: '+2 -1' },
      ],
      text: 'done. it was way too demure in there, so i turned it up and added a party. no tests were harmed.',
      t0: now,
      thinkMs: this.anim ? 900 : 0,
      cps: this.anim ? 90 : 1e6,
      verb: pick(VERBS),
      done: false,
    };
    user.bot = bot;
    this.messages.push(user, bot, {
      role: 'diff',
      after: bot,
      file: 'src/vibes.ts',
      rows: [
        [1, ' ', 'export const vibe = {'],
        [2, '-', "  mood: 'demure',"],
        [2, '+', "  mood: 'brat',"],
        [3, ' ', "  volume: 'loud',"],
        [4, '+', '  party: true,'],
        [5, ' ', '};'],
      ],
    });
  }

  help() {
    this.view = 'chat';
    this.scroll = 0;
    this.messages.push({
      role: 'bot',
      mode: this.modeKey,
      steps: [],
      text: [
        'enter          send',
        'alt+enter      new line (or \\ then enter)',
        'tab            flip the record: side a brat / side b demure',
        'ctrl+p or /    command palette',
        'up / down      message history',
        'pgup / pgdn    scroll',
        'esc            stop the reply',
        'ctrl+c         clear, twice to quit',
        'ctrl+n         new session',
      ].join('\n'),
      t0: this.clock(),
      thinkMs: 0,
      cps: 1e6,
      done: false,
    });
  }

  stopBot() {
    const now = this.clock();
    for (const m of this.messages) {
      if (m.role === 'bot' && !m.done) {
        m.cut = Math.max(0, this.botShown(m, now));
        m.done = true;
        m.stopped = true;
        m.dur = now - m.t0;
      }
    }
  }

  botShown(m, now) {
    const el = now - m.t0;
    if (el < m.thinkMs) return -1;
    return Math.floor(((el - m.thinkMs - (m.steps.length ? 350 : 0)) / 1000) * m.cps);
  }

  tick(now) {
    for (const m of this.messages) {
      if (m.role !== 'bot' || m.done) continue;
      if (this.botShown(m, now) >= m.text.length) {
        m.done = true;
        m.dur = m.thinkMs + (m.steps.length ? 350 : 0) + (m.text.length / m.cps) * 1000;
      }
    }
    if (this.toast && now > this.toast.until) this.toast = null;
  }

  // ---------------------------------------------------------------- drawing
  draw() {
    const s = this.screen;
    const now = this.clock();
    this.tick(now);
    s.clear(C.bg, C.fg);
    if (this.view === 'home') this.drawHome(now);
    else this.drawChat(now);
    this.drawToast(now);
    if (this.palette) { this.scrim(0.6); this.drawPalette(now); }
  }

  scrim(a) {
    const s = this.screen;
    for (let k = 0; k < s.bg.length; k++) {
      s.bg[k] = mix(s.bg[k], 0x000000, a);
      s.fg[k] = mix(s.fg[k], 0x000000, a);
    }
  }

  inputLayout(tw) {
    const { rows, cur } = this.input.layout(Math.max(8, tw));
    const shown = Math.min(rows.length, 5);
    const first = clamp(cur.row - shown + 1, 0, rows.length - shown);
    return { rows, cur, shown, first };
  }

  // "01  ask anything..." : every message you write is the next track
  drawInput(x, y, w, now, color) {
    const s = this.screen;
    const L = this.inputLayout(w - 4);
    const no = pad2(this.trackNo);
    const ph = `ask anything... "${this.placeholder}"`;
    const maxX = x + w;
    s.text(x, y, no, color, -1, BOLD);
    if (this.input.empty) {
      s.text(x + 4, y, ph, C.dim, -1, 0, maxX);
    } else {
      for (let j = 0; j < L.shown; j++) s.text(x + 4, y + j, L.rows[L.first + j], C.fg, -1, 0, maxX);
    }
    if (!this.palette) {
      const on = !this.anim || now - this.lastKey < 600 || Math.floor(now / 530) % 2 === 0;
      if (on) {
        const under = this.input.empty ? ph[0] : (L.rows[L.cur.row] || '')[L.cur.col] || ' ';
        s.put(x + 4 + L.cur.col, y + L.cur.row - L.first, under, C.bg, color);
      }
    }
    return L.shown;
  }

  // the line under the input is also the player bar:
  // idle = a short green stub, thinking = a sweeping segment, replying = it fills up
  drawBar(x, y, w, now, color) {
    const s = this.screen;
    for (let i = 0; i < w; i++) s.put(x + i, y, '\u2500', C.faint);
    const bot = this.messages.find((m) => m.role === 'bot' && !m.done);
    if (!bot) {
      for (let i = 0; i < 4; i++) s.put(x + i, y, '\u2501', color);
      return;
    }
    const shown = this.botShown(bot, now);
    if (shown < 0) {
      const len = 8;
      const pos = Math.round(((Math.sin((now / 1000) * 3.4 - 1.57) + 1) / 2) * (w - len));
      for (let i = 0; i < len; i++) s.put(x + pos + i, y, '\u2501', mix(C.faint, color, Math.sin((Math.PI * (i + 0.5)) / len)));
      return;
    }
    const fill = Math.round(clamp(shown / Math.max(1, bot.text.length), 0, 1) * w);
    for (let i = 0; i < fill; i++) s.put(x + i, y, '\u2501', color);
    s.put(x + Math.min(w - 1, fill), y, '\u2501', C.fg);
  }

  drawHints(xRight, y) {
    const s = this.screen;
    const items = this.busy ? [['esc', 'stop'], ['ctrl+p', 'commands']] : HINTS;
    let len = -3;
    for (const [k, l] of items) len += k.length + 1 + l.length + 3;
    let x = xRight - len;
    items.forEach(([k, l], i) => {
      x = s.text(x, y, k, C.fg, -1, BOLD);
      x = s.text(x, y, ' ' + l, C.dim);
      if (i < items.length - 1) x += 3;
    });
  }

  drawChips(x, y, now) {
    const s = this.screen;
    for (const m of Object.values(MODES)) {
      const on = m.id === this.modeKey;
      const label = ` ${m.side.toUpperCase()} ${m.label} `;
      const bg = on ? mix(MODES[this.prevKey].id === m.id ? MODES[this.prevKey].color : m.color, m.color, clamp((now - this.flipAt) / 360, 0, 1)) : -1;
      x = s.text(x, y, label, on ? C.bg : C.dim, bg, on ? BOLD : 0);
      x += 1;
    }
  }

  drawHome(now) {
    const s = this.screen;
    const { w, h } = s;
    const wide = w >= 80 && h >= 20;
    const rows = COVER / 2;
    const rw = wide ? Math.min(60, w - COVER - 10) : Math.min(60, w - 4);
    const blockW = wide ? COVER + 4 + rw : rw;
    const bx = Math.floor((w - blockW) / 2);
    const by = Math.max(1, Math.floor(((wide ? h - 1 : h - 3) - (wide ? rows : 10)) / 2));
    const rx = wide ? bx + COVER + 4 : bx;
    const ry = wide ? by : by;
    const color = this.accent(now);

    const t = (now - this.introAt) / 1000;
    const fade = (delay, dur = 0.5) => (this.anim ? clamp((t - delay) / dur, 0, 1) : 1);
    const fadeTo = (c, d) => mix(C.bg, c, fade(d));

    if (wide) {
      // intro: out-of-focus cover pulls into focus. side a never fully does, side b does.
      const p = this.anim ? clamp(t / 1.9, 0, 1) : 1;
      const ease = 1 - (1 - p) ** 3;
      const q = clamp((now - this.flipAt) / 560, 0, 1);
      const flipping = q < 1;
      const side = flipping && q < 0.5 ? MODES[this.prevKey] : this.mode;
      const sharp = side.id === 'demure';
      const target = sharp ? 0 : 0.9 + (this.anim ? Math.sin(now / 1000 * 1.1) * 0.12 * ease : 0);
      this.cover.draw(s, bx, by, {
        color: mix(C.bg, side.color, fade(0, 0.45)),
        ink: C.bg,
        sigma: lerp(3.4, target, ease),
        scaleX: flipping ? Math.abs(Math.cos(Math.PI * q)) : 1,
      });
    }

    // right column
    let y = ry;
    if (!wide) {
      s.text(rx, y, 'bratcode', mix(C.bg, C.fg, fade(0)), -1, BOLD);
      y += 2;
    } else {
      let x = s.text(rx, y, 'bratcode', fadeTo(C.fg, 0.35), -1, BOLD);
      s.text(x + 2, y, VERSION, fadeTo(C.dim, 0.35));
      y += 1;
    }
    {
      const x = s.text(rx, y, `side ${this.mode.side} `, mix(C.bg, color, fade(0.45)), -1, BOLD);
      s.text(x, y, `\u00b7 ${this.mode.blurb}`, fadeTo(C.dim, 0.45));
    }
    // wide: title on top of the sleeve, input at the bottom, like credits on a back cover
    const iy = ry + (wide ? rows - 6 : 3);
    const n = this.drawInput(rx, iy, rw, now, color);
    this.drawBar(rx, iy + n, rw, now, color);
    this.drawChips(rx, iy + n + 2, now);
    if (wide) this.drawHints(rx + rw, ry + rows - 1);
    else this.drawHints(rx + rw, iy + n + 4);
    s.text(2, h - 1, this.dir + (this.branch ? `:${this.branch}` : ''), C.faint, -1, 0, w - 4);
  }

  eq(x, y, now, color, n = 5) {
    const s = this.screen;
    for (let i = 0; i < n; i++) {
      const v = (Math.sin((now / 1000) * 9 + i * 1.7) + Math.sin((now / 1000) * 5.3 + i * 2.9)) / 4 + 0.5;
      s.put(x + i, y, EQ[1 + Math.round(clamp(v, 0, 1) * 7)], color);
    }
    return x + n;
  }

  buildLines(cw, mx, now) {
    const s = this.screen;
    const lines = [];
    const blank = () => lines.push(() => {});
    let n = 0;
    for (const m of this.messages) {
      if (m.role === 'user') {
        n++;
        const no = n;
        const color = MODES[m.mode].color;
        wrapText(m.text, cw - 12).forEach((r, i) => {
          lines.push((y) => {
            if (i === 0) {
              s.text(mx, y, pad2(no), color, -1, BOLD);
              if (m.bot?.done) {
                const d = fmtDur(m.bot.dur);
                s.text(mx + cw - d.length, y, d, C.dim);
              }
            }
            s.text(mx + 4, y, r, C.fg, -1, BOLD, mx + cw - 8);
          });
        });
      } else if (m.role === 'bot') {
        const color = MODES[m.mode].color;
        const shown = m.done && !m.stopped ? m.text.length : m.stopped ? m.cut : this.botShown(m, now);
        if (!m.done && shown < 0) {
          lines.push((y) => {
            const x = this.eq(mx + 4, y, now, color);
            const x2 = s.text(x + 2, y, m.verb, C.text);
            s.text(x2 + 2, y, `${((now - m.t0) / 1000).toFixed(1)}s`, C.dim);
          });
        } else {
          for (const st of m.steps) {
            lines.push((y) => {
              let x = s.text(mx + 4, y, '\u2713', color, -1, BOLD);
              x = s.text(x + 1, y, st.label, C.text);
              s.text(x + 2, y, st.detail, C.dim);
            });
          }
          if (m.steps.length) blank();
          const body = wrapText(m.text.slice(0, Math.max(0, shown)), cw - 8);
          body.forEach((r, i) => {
            const last = i === body.length - 1;
            lines.push((y) => {
              const x = s.text(mx + 4, y, r, C.text);
              if (last && !m.done) s.put(x, y, ' ', C.fg, color);
            });
          });
          if (m.stopped) lines.push((y) => s.text(mx + 4, y, 'stopped.', C.dim, -1, ITALIC));
        }
        blank();
      } else if (m.role === 'diff') {
        if (!m.after.done) continue;
        const dx = mx + 4;
        const dw = cw - 6;
        lines.push((y) => {
          s.rect(dx, y, dw, 1, C.panel);
          s.text(dx + 2, y, m.file, C.fg, C.panel, BOLD);
        });
        for (const [no, kind, txt] of m.rows) {
          lines.push((y) => {
            const bg = kind === '+' ? mix(C.panel, C.green, 0.2) : kind === '-' ? mix(C.panel, C.hot, 0.22) : C.panel;
            const sign = kind === '+' ? C.green : kind === '-' ? C.hot : C.dim;
            s.rect(dx, y, dw, 1, bg);
            s.text(dx + 2, y, String(no).padStart(2), C.dim, bg);
            s.text(dx + 5, y, kind, sign, bg, BOLD);
            s.text(dx + 7, y, txt, C.fg, bg, 0, dx + dw - 1);
          });
        }
        lines.push((y) => s.rect(dx, y, dw, 1, C.panel));
        blank();
      }
    }
    return lines;
  }

  drawChat(now) {
    const s = this.screen;
    const { w, h } = s;
    const cw = Math.min(96, w - 6);
    const mx = Math.floor((w - cw) / 2);
    const color = this.accent(now);
    const L = this.inputLayout(cw - 4);
    const barY = h - 2;
    const inputY = barY - L.shown;

    // header: bratcode / first prompt ............ [ A brat ]
    s.text(mx, 1, 'bratcode', C.fg, -1, BOLD);
    const first = this.messages.find((m) => m.role === 'user');
    if (first) s.text(mx + 11, 1, first.text.replace(/\s+/g, ' '), C.dim, -1, 0, mx + cw - 16);
    const chip = ` ${this.mode.side.toUpperCase()} ${this.mode.label} `;
    s.text(mx + cw - chip.length, 1, chip, C.bg, color, BOLD);

    const top = 3;
    const bottom = inputY - 2;
    const area = Math.max(1, bottom - top + 1);
    const lines = this.buildLines(cw, mx, now);
    const maxScroll = Math.max(0, lines.length - area);
    this.scroll = clamp(this.scroll, 0, maxScroll);
    const end = lines.length - this.scroll;
    const start = Math.max(0, end - area);
    for (let i = start; i < end; i++) lines[i](top + i - start);
    if (this.scroll > 0) {
      const t = ` ${this.scroll} more below `;
      s.text(mx + cw - t.length, bottom + 1, t, C.bg, C.dim);
    }

    this.drawInput(mx, inputY, cw, now, color);
    this.drawBar(mx, barY, cw, now, color);
    s.text(mx, h - 1, this.dir + (this.branch ? `:${this.branch}` : ''), C.faint, -1, 0, mx + cw - 30);
    this.drawHints(mx + cw, h - 1);
  }

  drawToast(now) {
    if (!this.toast) return;
    const s = this.screen;
    const t = ` ${this.toast.text} `;
    const left = this.toast.until - now;
    const cw = Math.min(96, s.w - 6);
    const x = Math.floor((s.w - cw) / 2) + cw - t.length;
    s.text(x, 2, t, left < 400 ? C.dim : C.fg, C.panel);
  }

  drawPalette(now) {
    const s = this.screen;
    const items = this.paletteItems();
    const pw = Math.min(56, s.w - 4);
    const ph = 6 + Math.max(1, items.length);
    const x = Math.floor((s.w - pw) / 2);
    const y = Math.max(1, Math.floor((s.h - ph) / 3));
    const color = this.mode.color;
    s.rect(x, y, pw, ph, C.panel);
    s.text(x + 3, y + 1, 'commands', color, C.panel, BOLD);
    s.text(x + pw - 6, y + 1, 'esc', C.dim, C.panel);
    const q = this.palette.query;
    const cx = s.text(x + 3, y + 3, q, C.fg, C.panel);
    if (!q) s.text(x + 3, y + 3, 'type to filter', C.dim, C.panel);
    const on = !this.anim || now - this.lastKey < 600 || Math.floor(now / 530) % 2 === 0;
    if (on) s.put(cx, y + 3, !q ? 't' : ' ', C.bg, color);
    if (!items.length) s.text(x + 3, y + 5, 'nothing here, bestie', C.dim, C.panel);
    items.forEach((it, i) => {
      const sel = i === this.palette.sel;
      const bg = sel ? color : C.panel;
      s.rect(x + 1, y + 5 + i, pw - 2, 1, bg);
      s.text(x + 3, y + 5 + i, it.title, sel ? C.bg : C.fg, bg, sel ? BOLD : 0);
      if (it.hint) s.text(x + pw - 3 - it.hint.length, y + 5 + i, it.hint, sel ? C.bg : C.dim, bg);
    });
  }
}
