// Overlays for the TUI: /tg (QR link), /accounts, /model and the approval card (Side B demure).
// Each overlay: { key(k) -> 'close' | undefined, draw(screen, now, color) }
import { BOLD } from './term.js';
import { C } from './theme.js';
import { wrapText } from './text.js';
import { qrHalfBlocks } from './telegram/qr.js';
import { loginInWindow, importFromBrowsers, importFromClaudehackDir, looksLikeClaudehackDir } from './pool/login.js';
import { currentCatalog, resolveModelId } from './pool/models.js';
import { readSettings, saveSettings, DEFAULT_CLAUDEHACK_DIR } from './paths.js';

const WHITE = 0xffffff;
const BLACK = 0x000000;

export const fmtCredits = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('en-US') : '?');
const err = (e) => String((e && e.message) || e || 'error').replace(/\s+/g, ' ').slice(0, 90);

function panel(s, w, h, title, color, hint = 'esc') {
  const pw = Math.max(20, Math.min(w, s.w - 4));
  const ph = Math.max(5, Math.min(h, s.h - 2));
  const x = Math.floor((s.w - pw) / 2);
  const y = Math.max(0, Math.floor((s.h - ph) / 2.4));
  s.rect(x, y, pw, ph, C.panel);
  s.text(x + 3, y + 1, title, color, C.panel, BOLD);
  s.text(x + pw - 3 - hint.length, y + 1, hint, C.dim, C.panel);
  return { x, y, pw, ph, ix: x + 3, iw: pw - 6 };
}

const decode = (v) => Buffer.from(String(v).replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const param = (p, k) => (p[k + '_b64'] !== undefined ? decode(p[k + '_b64']) : p[k]);

// ------------------------------------------------------------------ /tg
export class TgOverlay {
  constructor(app) {
    this.app = app;
    this.svc = app.brain.tg.service;
    this.ctl = new AbortController();
    this.phase = 'init'; // linked | qr | password | error
    this.qr = null;
    this.msg = '';
    this.pw = '';
    this.closed = false;
    this.begin();
  }

  async begin() {
    this.msg = '';
    this.qr = null;
    const st = this.svc.cached();
    if (st.linked) { this.phase = 'linked'; this.user = st; return; }
    this.phase = 'qr';
    try {
      await this.svc.loginWithQr({
        signal: this.ctl.signal,
        onQr: (url) => { this.qr = qrHalfBlocks(url); },
        onPassword: (hint) => new Promise((resolve) => { this.phase = 'password'; this.hint = hint || ''; this.pw = ''; this.resolve = resolve; }),
        onError: (e) => { if (!this.closed) this.msg = err(e); return false; },
      });
      this.user = this.svc.cached();
      this.phase = 'linked';
      this.app.refreshTg();
      this.app.say('telegram linked');
    } catch (e) {
      if (!this.closed) { this.phase = 'error'; this.msg = err(e); }
    }
  }

  close() {
    this.closed = true;
    try { this.ctl.abort(); } catch { /* ignore */ }
    if (this.resolve) { const r = this.resolve; this.resolve = null; r(''); }
    return 'close';
  }

  key(k) {
    if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return this.close();
    if (this.phase === 'password') {
      if (k.name === 'enter') { const r = this.resolve; this.resolve = null; this.phase = 'qr'; if (r) r(this.pw); this.pw = ''; return; }
      if (k.name === 'backspace') { this.pw = Array.from(this.pw).slice(0, -1).join(''); return; }
      if (k.name === 'char' && !k.alt) { this.pw += k.text; return; }
      if (k.name === 'paste') { this.pw += k.text.replace(/\s+/g, ''); }
      return;
    }
    if (this.phase === 'linked' && k.name === 'char' && k.text === 'l') {
      this.svc.logout().then(() => { this.app.refreshTg(); this.app.say('telegram unlinked'); });
      return this.close();
    }
    if (this.phase === 'error' && k.name === 'enter') {
      this.ctl = new AbortController();
      this.begin();
    }
  }

  draw(s, now, color) {
    const qrH = this.qr ? this.qr.length : 0;
    const qrW = this.qr ? this.qr[0].length : 0;
    const w = Math.max(62, qrW + 8);
    const h = this.phase === 'linked' ? 9 : 10 + qrH;
    const p = panel(s, w, h, 'telegram', color);
    const u = this.user || {};
    let y = p.y + 3;
    const line = (t, fg = C.text, at = 0) => { s.text(p.ix, y, t, fg, C.panel, at, p.ix + p.iw); y++; };
    if (this.phase === 'linked') {
      line(`linked: ${u.name || 'you'}${u.username ? ' @' + u.username : ''}`, C.fg, BOLD);
      line('the agent can read chats and write as you.', C.dim);
      y++;
      line('l  unlink    esc  close', C.dim);
      return;
    }
    if (this.phase === 'password') {
      line('two-step password' + (this.hint ? ` (hint: ${this.hint})` : ''), C.fg, BOLD);
      line('\u2022'.repeat(Array.from(this.pw).length) + '\u2588', color);
      if (this.msg) line(this.msg, C.hot);
      y++;
      line('enter  confirm    esc  cancel', C.dim);
      return;
    }
    if (this.phase === 'error') {
      line('could not link telegram', C.hot, BOLD);
      line(this.msg, C.text);
      y++;
      line('enter  try again    esc  close', C.dim);
      return;
    }
    // qr
    line('settings > devices > link desktop device, then scan:', C.text);
    y++;
    if (!this.qr) { line('asking telegram for a code...', C.dim); return; }
    if (p.ph < qrH + 7 || p.pw < qrW + 2) { line('terminal too small for the qr: make it bigger', C.hot); return; }
    const qx = p.x + Math.floor((p.pw - qrW) / 2);
    for (let r = 0; r < qrH; r++) {
      for (let c = 0; c < qrW; c++) {
        const ch = this.qr[r][c];
        s.put(qx + c, y + r, ch, WHITE, BLACK);
      }
    }
    y += qrH + 1;
    if (this.msg) line(this.msg, C.hot);
  }
}

// ------------------------------------------------------------------ /accounts
export class AccountsOverlay {
  constructor(app) {
    this.app = app;
    this.brain = app.brain;
    this.sel = 0;
    this.msg = '';
    this.working = false;
    this.armDel = '';
    this.ctl = null;
    this.pref = readSettings().preferredAccountId || '';
    this.claudehackDir = readSettings().claudehackDir || '';
    this.editingPath = false; // 'p': type/paste the folder path, then enter to save
    this.pathInput = '';
  }

  rows() { return (this.app.bal && this.app.bal.accounts) || []; }

  async run(label, fn) {
    if (this.working) return;
    this.working = true;
    this.msg = label;
    try { this.msg = await fn(); } catch (e) { this.msg = err(e); } finally { this.working = false; this.brain.pool.changed(); }
  }

  key(k) {
    const rows = this.rows();
    if (this.editingPath) {
      if (k.name === 'escape' || (k.ctrl && k.name === 'c')) { this.editingPath = false; return; }
      if (k.name === 'enter') {
        const dir = this.pathInput.trim().replace(/^~(?=$|\/)/, process.env.HOME || '');
        this.editingPath = false;
        if (!dir) { this.claudehackDir = ''; saveSettings({ claudehackDir: '' }); this.msg = 'claudehack folder unpinned'; return; }
        if (!looksLikeClaudehackDir(dir)) { this.msg = `no accounts.json found in ${dir}`; return; }
        this.claudehackDir = dir;
        saveSettings({ claudehackDir: dir });
        this.msg = `pinned: ${dir}`;
        return;
      }
      if (k.name === 'backspace') { this.pathInput = Array.from(this.pathInput).slice(0, -1).join(''); return; }
      if (k.name === 'char' && !k.alt) { this.pathInput += k.text; return; }
      if (k.name === 'paste') { this.pathInput += k.text; return; }
      return;
    }
    if (k.name === 'escape' || (k.ctrl && k.name === 'c')) { try { this.ctl?.abort(); } catch { /* ignore */ } return 'close'; }
    if (k.name === 'up') { this.sel = Math.max(0, this.sel - 1); this.armDel = ''; return; }
    if (k.name === 'down') { this.sel = Math.min(Math.max(0, rows.length - 1), this.sel + 1); this.armDel = ''; return; }
    if (k.name !== 'char' || k.alt) {
      if (k.name === 'enter' && rows[this.sel]) {
        const id = rows[this.sel].id;
        this.pref = this.pref === id ? '' : id;
        saveSettings({ preferredAccountId: this.pref });
        this.msg = this.pref ? `pinned: ${rows[this.sel].name}` : 'pin removed: best balance first';
      }
      return;
    }
    const { pool, store } = this.brain;
    switch (k.text) {
      case 'a':
        this.ctl = new AbortController();
        return this.run('opening a window...', async () => {
          const r = await loginInWindow(store, { onStatus: (t) => { this.msg = t; }, signal: this.ctl.signal });
          await pool.refreshBalance(r.account.id);
          return `${r.updated ? 'updated' : 'added'}: ${r.account.name}`;
        });
      case 'i':
        return this.run('reading chrome / brave / edge profiles...', async () => {
          const r = await importFromBrowsers(store, { onStatus: (t) => { this.msg = t; } });
          await pool.refreshAll();
          const bad = r.failed[0] ? `, ${r.failed.length} failed: ${r.failed[0].error}` : '';
          return `imported ${r.added.length} from ${r.scanned} profiles${bad}`.slice(0, 110);
        });
      case 'p':
        this.editingPath = true;
        this.pathInput = this.claudehackDir || DEFAULT_CLAUDEHACK_DIR || '';
        return;
      case 'c': {
        const dir = this.claudehackDir || DEFAULT_CLAUDEHACK_DIR;
        if (!dir) { this.msg = 'no claudehack folder pinned yet: press p to set one'; return; }
        return this.run(`reading claudehack accounts from ${dir}...`, async () => {
          const r = await importFromClaudehackDir(store, dir, { onStatus: (t) => { this.msg = t; } });
          await pool.refreshAll();
          const bad = r.failed[0] ? `, ${r.failed.length} failed: ${r.failed[0].error}` : '';
          return `imported ${r.added.length} from ${r.scanned} claudehack accounts${bad}`.slice(0, 120);
        });
      }
      case 'r':
        return this.run('refreshing balances...', async () => { await pool.refreshAll(); const b = pool.summary(); return `${fmtCredits(b.total)} credits on ${b.usable}/${b.count}`; });
      case 'd': {
        const a = rows[this.sel];
        if (!a) return;
        if (this.armDel !== a.id) { this.armDel = a.id; this.msg = `press d again to remove ${a.name}`; return; }
        this.armDel = '';
        store.remove(a.id);
        if (this.pref === a.id) { this.pref = ''; saveSettings({ preferredAccountId: '' }); }
        this.sel = Math.max(0, this.sel - 1);
        pool.changed();
        this.msg = `removed ${a.name}`;
        return;
      }
      default:
    }
  }

  draw(s, now, color) {
    const rows = this.rows();
    const extra = this.editingPath ? 2 : 0;
    const p = panel(s, 76, 9 + extra + Math.max(2, Math.min(rows.length, 10)), 'accounts', color);
    const bal = this.app.bal;
    if (bal) s.text(p.x + 15, p.y + 1, `${fmtCredits(bal.total)} credits  ${bal.usable}/${bal.count} usable`, C.dim, C.panel, 0, p.x + p.pw - 8);
    let y = p.y + 3;
    if (this.editingPath) {
      s.text(p.ix, y, 'claudehack folder (empty = unpin):', C.text, C.panel);
      y++;
      const line = this.pathInput || ' ';
      s.text(p.ix, y, line, C.fg, C.panel, 0, p.ix + p.iw);
      const on = Math.floor(now / 530) % 2 === 0;
      if (on) s.put(p.ix + Array.from(this.pathInput).length, y, ' ', C.bg, color);
      y += 2;
      s.text(p.ix, y, 'enter  save    esc  cancel', C.dim, C.panel);
      return;
    }
    if (this.claudehackDir) {
      s.text(p.ix, y, `claudehack: ${this.claudehackDir}`, C.dim, C.panel, 0, p.ix + p.iw);
      y++;
    }
    if (!rows.length) {
      s.text(p.ix, y, 'no accounts yet. press i to import from your browsers, or a to sign in.', C.text, C.panel, 0, p.ix + p.iw);
      y += 2;
    }
    const vis = Math.min(rows.length, 10);
    const first = Math.max(0, Math.min(this.sel - vis + 1, rows.length - vis));
    for (let i = first; i < first + vis; i++) {
      const a = rows[i];
      const on = i === this.sel;
      const bg = on ? color : C.panel;
      const fg = on ? C.bg : C.fg;
      const dim = on ? C.bg : C.dim;
      s.rect(p.x + 1, y, p.pw - 2, 1, bg);
      const active = bal && bal.active && bal.active.id === a.id;
      s.text(p.ix, y, active ? '\u25cf' : '\u25cb', on ? C.bg : (active ? C.green : C.dim), bg, BOLD);
      const name = (this.pref === a.id ? '\u2605 ' : '') + a.name;
      s.text(p.ix + 2, y, name, fg, bg, on ? BOLD : 0, p.ix + 24);
      s.text(p.ix + 26, y, a.email || '', dim, bg, 0, p.ix + p.iw - 20);
      const right = a.dead ? 'logged out' : a.tokens === null ? '...' : `${fmtCredits(a.tokens)}${a.locked ? ` \u00b7 ${a.locked} locked` : ''}`;
      s.text(p.ix + p.iw - right.length, y, right, a.dead ? (on ? C.bg : C.hot) : dim, bg);
      y++;
    }
    y = p.y + p.ph - 4;
    if (this.msg) s.text(p.ix, y, this.msg, this.working ? color : C.text, C.panel, 0, p.ix + p.iw);
    s.text(p.ix, p.y + p.ph - 2, 'a sign in   i import   c claudehack   p set folder   r refresh   d remove   enter pin', C.dim, C.panel, 0, p.ix + p.iw);
  }
}

// ------------------------------------------------------------------ /model
export class ModelOverlay {
  constructor(app) {
    this.app = app;
    const c = currentCatalog();
    this.items = c.primary.concat(c.more || []);
    this.cur = resolveModelId(readSettings().model);
    this.sel = Math.max(0, this.items.findIndex((m) => m.id === this.cur));
  }

  key(k) {
    if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return 'close';
    if (k.name === 'up') { this.sel = (this.sel - 1 + this.items.length) % Math.max(1, this.items.length); return; }
    if (k.name === 'down' || k.name === 'tab') { this.sel = (this.sel + 1) % Math.max(1, this.items.length); return; }
    if (k.name === 'enter' && this.items[this.sel]) {
      const m = this.items[this.sel];
      saveSettings({ model: m.id });
      this.app.say(`model: ${m.label || m.id}`);
      return 'close';
    }
  }

  draw(s, now, color) {
    const vis = Math.min(this.items.length, 12);
    const p = panel(s, 56, 6 + Math.max(1, vis), 'model', color);
    const first = Math.max(0, Math.min(this.sel - vis + 1, this.items.length - vis));
    let y = p.y + 3;
    for (let i = first; i < first + vis; i++) {
      const m = this.items[i];
      const on = i === this.sel;
      const bg = on ? color : C.panel;
      s.rect(p.x + 1, y, p.pw - 2, 1, bg);
      s.text(p.ix, y, (m.id === this.cur ? '\u25cf ' : '  ') + (m.label || m.id), on ? C.bg : C.fg, bg, on ? BOLD : 0, p.ix + 30);
      s.text(p.ix + 32, y, m.id, on ? C.bg : C.dim, bg, 0, p.ix + p.iw);
      y++;
    }
  }
}

// ------------------------------------------------------------------ approval card (Side B)
export class ConfirmCard {
  constructor({ cmd, params, resolve, timeoutMs = 90000 }) {
    this.cmd = cmd;
    this.params = params || {};
    this.resolve = resolve;
    this.until = Date.now() + timeoutMs;
    this.timer = setTimeout(() => this.answer(false), timeoutMs);
    this.timer.unref?.();
    this.done = false;
  }

  answer(v) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.resolve(!!v);
  }

  describe() {
    const p = this.params;
    if (this.cmd === 'tg_send') return ['send a telegram message', `to    ${param(p, 'chat') ?? param(p, 'to') ?? '?'}`, `text  ${param(p, 'text') ?? param(p, 'message') ?? ''}`];
    return [`run ${this.cmd}`, JSON.stringify(p).slice(0, 240)];
  }

  key(k) {
    if (k.name === 'enter' || (k.name === 'char' && (k.text === 'y' || k.text === 'Y'))) { this.answer(true); return 'close'; }
    if (k.name === 'escape' || (k.ctrl && k.name === 'c') || (k.name === 'char' && (k.text === 'n' || k.text === 'N'))) { this.answer(false); return 'close'; }
  }

  draw(s, now, color) {
    const lines = this.describe();
    const w = Math.min(70, s.w - 4);
    const body = [];
    lines.slice(1).forEach((l) => wrapText(l, w - 6).forEach((r) => body.push(r)));
    const p = panel(s, w, 7 + body.length + 1, 'sure?', color, `${Math.max(0, Math.ceil((this.until - Date.now()) / 1000))}s`);
    let y = p.y + 3;
    s.text(p.ix, y++, lines[0], C.fg, C.panel, BOLD, p.ix + p.iw);
    for (const r of body.slice(0, 8)) s.text(p.ix, y++, r, C.text, C.panel, 0, p.ix + p.iw);
    s.text(p.ix, p.y + p.ph - 2, 'enter  allow      esc  deny', C.dim, C.panel);
  }
}
