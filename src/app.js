import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Screen, detectTruecolor, mix, BOLD, UNDERLINE } from './term.js';
import { THEMES, MODES } from './theme.js';
import { Logo } from './logo.js';
import { parseKeys } from './keys.js';
import { TextBuffer, wrapText } from './text.js';

export const VERSION = '0.1.0';
const PINK = 0xff4fa3;
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
const TIPS = [
  ['tab', 'switches between brat and demure'],
  ['ctrl+p', 'opens the command palette'],
  ['/', 'at the start of a line opens commands'],
  ['alt+enter', 'adds a new line, so does \\ then enter'],
  ['up', 'brings back your previous messages'],
  ['ctrl+c', 'clears the input, twice to quit'],
];
const LEVELS = [
  ['tab', 'mode'],
  ['ctrl+p', 'commands'],
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

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
  { id: 'mode', title: 'switch mode', hint: 'tab' },
  { id: 'theme', title: 'switch theme', hint: '' },
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
    this.themeKey = o.theme && THEMES[o.theme] ? o.theme : 'brat';
    this.anim = o.anim !== false;
    this.clock = o.clock || (() => performance.now());
    this.cwd = o.cwd || process.cwd();
    this.dir = homeify(this.cwd);
    this.branch = gitBranch(this.cwd);

    this.logo = new Logo(['brat', 'code']);
    this.modeKey = 'brat';
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
    this.tip = o.tip || pick(TIPS);
    this.introAt = this.clock();
    this.lastKey = -1e9;
    this.timer = null;
    this.onQuit = o.onQuit || (() => {});
  }

  get theme() { return THEMES[this.themeKey]; }
  get mode() { return MODES[this.modeKey]; }
  get busy() { return this.messages.some((m) => m.role === 'bot' && !m.done); }

  // ---------------------------------------------------------------- lifecycle
  start() {
    const { out } = this;
    out.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?2004h\x1b[2J');
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

    if (k.name === 'paste') {
      inp.insert(k.text.replace(/\r\n?/g, '\n'));
      return;
    }
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
      case 'tab': return this.cycleMode(k.shift ? -1 : 1);
      case 'escape':
        if (this.busy) this.stopBot();
        return;
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

  cycleMode(dir = 1) {
    const keys = Object.keys(MODES);
    this.modeKey = keys[(keys.indexOf(this.modeKey) + dir + keys.length) % keys.length];
    this.say(`${this.mode.label} mode: ${this.mode.blurb}`);
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
        this.tip = pick(TIPS);
        this.placeholder = pick(PLACEHOLDERS);
        break;
      case 'mode': this.cycleMode(1); break;
      case 'theme': {
        const keys = Object.keys(THEMES);
        this.themeKey = keys[(keys.indexOf(this.themeKey) + 1) % keys.length];
        this.screen.invalidate();
        this.say(`theme: ${this.themeKey}`);
        break;
      }
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
      const alias = { help: 'keys', quit: 'exit', q: 'exit', clear: 'new' }[id] || id;
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
    this.messages.push({ role: 'user', text, mode: this.modeKey });
    this.messages.push({
      role: 'bot',
      mode: this.modeKey,
      steps: [brat
        ? { label: 'checked the vibe', detail: '0 files, 0 problems' }
        : { label: 'planned very mindfully', detail: '1 step' }],
      text: brat
        ? `heyyy. i am only the pretty part for now. nothing is connected yet, so i cannot touch your code.\n\nbut i heard you: "${echo}". the real stuff drops soon. stay brat.`
        : `very mindful, very demure. i am just a design right now, so i will not touch your files.\n\nyou said "${echo}". i noted it. functionality comes later. very cutesy.`,
      t0: now,
      thinkMs: this.anim ? 1100 + Math.random() * 700 : 0,
      cps: this.anim ? 80 : 1e6,
      verb: pick(VERBS),
      done: false,
    });
  }

  demo() {
    const now = this.clock();
    this.view = 'chat';
    this.scroll = 0;
    this.messages.push({ role: 'user', text: 'make the vibes more brat, please', mode: this.modeKey });
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
    this.messages.push(bot);
    this.messages.push({
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
        'tab            switch mode: brat / demure',
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
    for (const m of this.messages) {
      if (m.role === 'bot' && !m.done) {
        m.cut = Math.max(0, this.botShown(m, this.clock()));
        m.done = true;
        m.stopped = true;
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
      if (this.botShown(m, now) >= m.text.length) m.done = true;
    }
    if (this.toast && now > this.toast.until) this.toast = null;
  }

  // ---------------------------------------------------------------- drawing
  draw() {
    const s = this.screen;
    const th = this.theme;
    const now = this.clock();
    this.tick(now);
    s.clear(th.bg, th.fg);
    if (this.view === 'home') this.drawHome(now);
    else this.drawChat(now);
    this.drawStatus();
    this.drawToast(now);
    if (this.palette) { this.scrim(0.62); this.drawPalette(now); }
  }

  // dim everything behind a modal
  scrim(a) {
    const s = this.screen;
    for (let k = 0; k < s.bg.length; k++) {
      s.bg[k] = mix(s.bg[k], 0x000000, a);
      s.fg[k] = mix(s.fg[k], 0x000000, a);
    }
  }

  barColor(modeKey) {
    return modeKey === 'brat' ? this.theme.bar : MODES[modeKey].color;
  }

  inputLayout(pw) {
    const tw = Math.max(8, pw - 6);
    const { rows, cur } = this.input.layout(tw);
    const shown = Math.min(rows.length, 6);
    const first = clamp(cur.row - shown + 1, 0, rows.length - shown);
    return { rows, cur, shown, first, ph: shown + 4 };
  }

  drawInput(x, y, pw, now) {
    const s = this.screen;
    const th = this.theme;
    const L = this.inputLayout(pw);
    const bar = this.barColor(this.modeKey);
    s.rect(x, y, pw, L.ph, th.panel);
    for (let j = 0; j < L.ph; j++) s.put(x, y + j, '\u258c', bar, th.panel);

    const tx = x + 3;
    const ty = y + 1;
    const maxX = x + pw - 2;
    const empty = this.input.empty;
    if (empty) {
      s.text(tx, ty, `ask anything... "${this.placeholder}"`, th.panelDim, th.panel, 0, maxX);
    } else {
      for (let j = 0; j < L.shown; j++) s.text(tx, ty + j, L.rows[L.first + j], th.panelFg, th.panel, 0, maxX);
    }
    if (!this.palette) {
      const on = !this.anim || now - this.lastKey < 600 || Math.floor(now / 530) % 2 === 0;
      if (on) {
        const cx = tx + L.cur.col;
        const cy = ty + L.cur.row - L.first;
        const under = empty ? `ask anything... "${this.placeholder}"`[0] : (L.rows[L.cur.row] || '')[L.cur.col] || ' ';
        s.put(cx, cy, under, th.panel, th.cursor ?? th.panelFg);
      }
    }

    const my = y + L.shown + 2;
    let nx = s.text(tx, my, this.mode.label, this.mode.color, th.panel, BOLD, maxX);
    nx = s.text(nx, my, ' \u00b7 ', th.panelDim, th.panel, 0, maxX);
    nx = s.text(nx, my, MODEL, th.panelFg, th.panel, 0, maxX);
    s.text(nx, my, ' preview', th.panelDim, th.panel, 0, maxX);
    if (this.busy) {
      const t = 'esc to stop';
      s.text(x + pw - 2 - t.length, my, t, th.panelDim, th.panel);
    }
    return L.ph;
  }

  drawHints(xRight, y) {
    const s = this.screen;
    const th = this.theme;
    const items = this.busy ? [['esc', 'stop'], ['ctrl+p', 'commands']] : LEVELS;
    let len = 0;
    for (const [k, l] of items) len += k.length + 1 + l.length + 3;
    len -= 3;
    let x = xRight - len;
    items.forEach(([k, l], i) => {
      x = s.text(x, y, k, th.fg, -1, BOLD);
      x = s.text(x, y, ' ' + l, th.dim);
      if (i < items.length - 1) x += 3;
    });
  }

  drawHome(now) {
    const s = this.screen;
    const th = this.theme;
    const { w, h } = s;
    const compact = w < this.logo.w + 2 || h < 22;
    const pw = Math.min(80, w - 6);
    const logoRows = compact ? 1 : this.logo.rows;
    const total = logoRows + (compact ? 2 : 1) + 5 + 1;
    const top = Math.max(0, Math.floor((h - 1 - total) / 2) - (compact ? 0 : 1));
    const px = Math.floor((w - pw) / 2);

    // focus-pull intro: both words start blurry, "code" snaps into focus, "brat" never does.
    const p = this.anim ? clamp((now - this.introAt) / 1900, 0, 1) : 1;
    const ease = 1 - (1 - p) ** 3;
    const fade = this.anim ? clamp((now - this.introAt) / 450, 0, 1) : 1;
    const breath = this.anim ? Math.sin(now / 1000 * 1.1) * 0.18 * ease : 0;
    const sBrat = lerp(3.2, 0.62, ease) + breath * 0.5;
    const sCode = lerp(3.2, 0, ease);
    if (compact) {
      const t = 'bratcode';
      const x = Math.floor((w - t.length) / 2);
      s.text(x, top, 'brat', th.logoA, -1, BOLD | UNDERLINE);
      s.text(x + 4, top, 'code', th.logoB, -1, BOLD);
    } else {
      this.logo.draw(
        s, Math.floor((w - this.logo.w) / 2), top, [sBrat, sCode], th.bg,
        [mix(th.bg, th.logoA, fade), mix(th.bg, th.logoB, fade)],
      );
    }
    const py = top + logoRows + (compact ? 1 : 0);
    const ph = this.drawInput(px, py, pw, now);
    this.drawHints(px + pw, py + ph);

    const tipY = Math.max(py + ph + 3, h - 5);
    if (tipY < h - 2 && w >= 44) {
      const [k, t] = this.tip;
      const len = 6 + k.length + 1 + t.length;
      let x = Math.floor((w - len) / 2);
      x = s.text(x, tipY, '\u25cf ', th.fg);
      x = s.text(x, tipY, 'tip ', th.fg, -1, BOLD);
      x = s.text(x, tipY, k, th.fg, -1, BOLD);
      s.text(x, tipY, ' ' + t, th.dim);
    }
  }

  wave(x, y, now, n = 6) {
    const s = this.screen;
    const th = this.theme;
    for (let i = 0; i < n; i++) {
      const v = (Math.sin(now / 1000 * 7 - i * 0.85) + 1) / 2;
      s.put(x + i, y, ' ', th.fg, mix(th.bg, th.fg, v ** 1.4 * 0.85));
    }
    return x + n;
  }

  buildLines(cw, mx, now) {
    const s = this.screen;
    const th = this.theme;
    const lines = [];
    const blank = () => lines.push(() => {});
    for (const m of this.messages) {
      if (m.role === 'user') {
        const bar = this.barColor(m.mode);
        const tw = cw - 6;
        const rows = wrapText(m.text, tw);
        const panel = (y, txt) => {
          s.rect(mx, y, cw, 1, th.panel);
          s.put(mx, y, '\u258c', bar, th.panel);
          if (txt) s.text(mx + 3, y, txt, th.panelFg, th.panel, 0, mx + cw - 2);
        };
        lines.push((y) => panel(y));
        for (const r of rows) lines.push((y) => panel(y, r));
        lines.push((y) => panel(y));
        blank();
      } else if (m.role === 'bot') {
        const md = MODES[m.mode];
        const label = ` ${md.label} `;
        lines.push((y) => s.text(mx, y, label, md.color, th.panel, BOLD));
        const el = now - m.t0;
        const shown = m.done && !m.stopped ? m.text.length : m.stopped ? m.cut : this.botShown(m, now);
        const thinking = !m.done && shown < 0;
        if (thinking) {
          lines.push((y) => {
            let x = this.wave(mx + 2, y, now);
            x = s.text(x + 1, y, m.verb, th.fg);
            s.text(x + 1, y, `${(el / 1000).toFixed(1)}s`, th.dim);
          });
        } else {
          for (const st of m.steps) {
            lines.push((y) => {
              let x = s.text(mx + 2, y, '\u2713', th.fg, -1, BOLD);
              x = s.text(x + 1, y, st.label, th.fg);
              s.text(x + 2, y, st.detail, th.dim);
            });
          }
          if (m.steps.length) blank();
          const body = wrapText(m.text.slice(0, Math.max(0, shown)), cw - 4);
          body.forEach((r, i) => {
            const last = i === body.length - 1;
            lines.push((y) => {
              const x = s.text(mx + 2, y, r, th.fg);
              if (last && !m.done) s.put(x, y, ' ', th.fg, th.fg);
            });
          });
          if (m.stopped) lines.push((y) => s.text(mx + 2, y, 'stopped.', th.dim, -1, ITALIC_FLAG));
        }
        blank();
      } else if (m.role === 'diff') {
        if (!m.after.done) continue;
        const dw = cw - 2;
        const dx = mx + 2;
        lines.push((y) => {
          s.rect(dx, y, dw, 1, th.panel);
          s.text(dx + 2, y, m.file, th.panelFg, th.panel, BOLD);
        });
        for (const [no, kind, txt] of m.rows) {
          lines.push((y) => {
            const bg = kind === '+' ? mix(th.panel, 0x8ace00, 0.2) : kind === '-' ? mix(th.panel, PINK, 0.22) : th.panel;
            const sign = kind === '+' ? 0x8ace00 : kind === '-' ? PINK : th.panelDim;
            s.rect(dx, y, dw, 1, bg);
            s.text(dx + 2, y, String(no).padStart(2), th.panelDim, bg);
            s.text(dx + 5, y, kind, sign, bg, BOLD);
            s.text(dx + 7, y, txt, th.panelFg, bg, 0, dx + dw - 1);
          });
        }
        lines.push((y) => s.rect(dx, y, dw, 1, th.panel));
        blank();
      }
    }
    return lines;
  }

  drawChat(now) {
    const s = this.screen;
    const th = this.theme;
    const { w, h } = s;
    const cw = Math.min(100, w - 4);
    const mx = Math.floor((w - cw) / 2);
    const L = this.inputLayout(cw);
    const panelY = h - 2 - L.ph;

    // header
    s.text(mx, 0, ' bratcode ', th.panelFg, th.panel, BOLD);
    const first = this.messages.find((m) => m.role === 'user');
    if (first) {
      const t = first.text.replace(/\s+/g, ' ');
      s.text(mx + 12, 0, t, th.dim, -1, 0, mx + cw - 14);
    }
    s.text(mx + cw - this.modeKey.length - 1, 0, this.mode.label, this.mode.color === 0x8ace00 ? th.fg : this.mode.color, -1, BOLD);

    const top = 2;
    const area = Math.max(1, panelY - 1 - top);
    const lines = this.buildLines(cw, mx, now);
    while (lines.length && lines[lines.length - 1].length === 0 && lines.length > 0 && false) lines.pop();
    const maxScroll = Math.max(0, lines.length - area);
    this.scroll = clamp(this.scroll, 0, maxScroll);
    const end = lines.length - this.scroll;
    const start = Math.max(0, end - area);
    for (let i = start; i < end; i++) lines[i](top + i - start);
    if (this.scroll > 0) {
      const t = ` ${this.scroll} more below `;
      s.text(mx + cw - t.length, panelY - 1, t, th.panelFg, th.panel);
    }

    this.drawInput(mx, panelY, cw, now);
    this.drawHints(mx + cw, panelY + L.ph);
  }

  drawStatus() {
    const s = this.screen;
    const th = this.theme;
    const y = s.h - 1;
    const left = this.dir + (this.branch ? `:${this.branch}` : '');
    s.text(2, y, left, th.dim, -1, 0, s.w - 14);
    const v = `bratcode ${VERSION}`;
    s.text(s.w - 2 - v.length, y, v, th.dim);
  }

  drawToast(now) {
    if (!this.toast) return;
    const s = this.screen;
    const th = this.theme;
    const t = ` ${this.toast.text} `;
    const x = s.w - t.length - 2;
    const left = this.toast.until - now;
    s.text(x, 1, t, left < 400 ? th.panelDim : th.panelFg, th.panel);
  }

  drawPalette(now) {
    const s = this.screen;
    const th = this.theme;
    const items = this.paletteItems();
    const pw = Math.min(56, s.w - 4);
    const ph = 5 + Math.max(1, items.length);
    const x = Math.floor((s.w - pw) / 2);
    const y = Math.max(1, Math.floor((s.h - ph) / 3));
    s.rect(x, y, pw, ph, th.panel);
    s.text(x + 3, y + 1, 'commands', th.accent, th.panel, BOLD);
    s.text(x + pw - 6, y + 1, 'esc', th.panelDim, th.panel);
    const q = this.palette.query;
    let cx = s.text(x + 3, y + 3, q || '', th.panelFg, th.panel);
    if (!q) s.text(x + 3, y + 3, 'type to filter', th.panelDim, th.panel);
    const on = !this.anim || now - this.lastKey < 600 || Math.floor(now / 530) % 2 === 0;
    if (on) s.put(cx, y + 3, !q ? 't' : ' ', th.panel, th.panelFg);
    if (!items.length) s.text(x + 3, y + 5, 'nothing here, bestie', th.panelDim, th.panel);
    items.forEach((it, i) => {
      const sel = i === this.palette.sel;
      const bg = sel ? th.accent : th.panel;
      s.rect(x + 1, y + 5 + i, pw - 2, 1, bg);
      s.text(x + 3, y + 5 + i, it.title, sel ? th.accentFg : th.panelFg, bg, sel ? BOLD : 0);
      const hint = it.id === 'theme' ? this.themeKey : it.hint;
      if (hint) s.text(x + pw - 3 - hint.length, y + 5 + i, hint, sel ? th.accentFg : th.panelDim, bg);
    });
  }
}

const ITALIC_FLAG = 4;
