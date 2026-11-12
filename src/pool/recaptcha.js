// reCAPTCHA token minting in an INVISIBLE headless browser (playwright-core + system Chrome/Brave/Chromium).
// One shared browser, one context per account (cookies from the account jar). Tokens are pre-minted.
// If there is no browser or the page does not expose grecaptcha, we return '' and the request goes without a token.
import { findBrowserExecutable } from '../paths.js';
import * as cfg from './config.js';

const TOKEN_TTL_MS = 100 * 1000;
const TOKEN_WAIT_BUDGET_MS = 8000;
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);

const SCRIPT = (action, forcedKey) => `
(async () => {
  const findSiteKey = () => {
    try {
      const c = window.___grecaptcha_cfg;
      if (c && c.clients) for (const id of Object.keys(c.clients)) {
        const stack = [c.clients[id]]; const seen = new Set();
        while (stack.length) { const o = stack.pop(); if (!o || typeof o !== 'object' || seen.has(o)) continue; seen.add(o);
          for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === 'string' && /^6[0-9A-Za-z_-]{38,}$/.test(v)) return v; if (v && typeof v === 'object') stack.push(v); } }
      }
    } catch (e) {}
    try { const s = Array.from(document.scripts).map(x => x.src).find(src => src && src.includes('recaptcha') && src.includes('render='));
      if (s) { const m = s.match(/[?&]render=([^&]+)/); if (m && m[1] && m[1] !== 'explicit') return decodeURIComponent(m[1]); } } catch (e) {}
    try { const m = document.documentElement.innerHTML.match(/6[0-9A-Za-z_-]{38,}/); if (m) return m[0]; } catch (e) {}
    return null;
  };
  const waitFor = (fn, t = 4000, step = 80) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let v = null; try { v = fn(); } catch (e) {} if (v) return res(v); if (Date.now() - t0 > t) return rej(new Error('timeout')); setTimeout(tick, step); }; tick(); });
  try {
    const g = await waitFor(() => (window.grecaptcha && (window.grecaptcha.enterprise || window.grecaptcha.execute) ? window.grecaptcha : null), 5000);
    const api = g.enterprise || g;
    const siteKey = ${forcedKey ? JSON.stringify(forcedKey) : 'null'} || await waitFor(findSiteKey, 3000);
    const token = await new Promise((resolve, reject) => { const run = () => { try { api.execute(siteKey, { action: ${JSON.stringify(action)} }).then(resolve, reject); } catch (e) { reject(e); } }; if (api.ready) api.ready(run); else run(); });
    return token ? { ok: true, token, siteKey } : { ok: false, error: 'empty_token' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
})();`;

export class Recaptcha {
  constructor({ store, enabled = true } = {}) {
    this.store = store;
    this.enabled = enabled && process.env.BRATCODE_NO_RECAPTCHA !== '1';
    this.browser = null;
    this.ctxs = new Map();   // accountId -> { ctx, page, ready }
    this.minted = new Map(); // accountId -> { token, at, pending }
    this.siteKeys = new Map();
    this.unavailable = '';
  }

  async _browser() {
    if (this.browser) return this.browser;
    if (this.unavailable) return null;
    const exe = findBrowserExecutable();
    if (!exe) { this.unavailable = 'no browser'; return null; }
    try {
      const { chromium } = await import('playwright-core');
      this.browser = await chromium.launch({ executablePath: exe, headless: true, timeout: 20000, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio'] });
      this.browser.on('disconnected', () => { this.browser = null; this.ctxs.clear(); this.minted.clear(); });
      return this.browser;
    } catch (e) { this.unavailable = String(e.message || e).slice(0, 120); return null; }
  }

  async _page(id) {
    const have = this.ctxs.get(id);
    if (have && !have.page.isClosed()) { await have.ready; return have.page; }
    const b = await this._browser();
    if (!b) return null;
    const ctx = await b.newContext({ viewport: { width: 900, height: 700 } });
    const jar = this.store.jar(id);
    try { await ctx.addCookies(jar.toPlaywright()); } catch { /* bad cookies - go anonymous */ }
    await ctx.route('**/*', (route) => {
      const r = route.request();
      if (BLOCKED_TYPES.has(r.resourceType())) return route.abort();
      return route.continue();
    });
    const page = await ctx.newPage();
    const ready = (async () => {
      try { await page.goto(cfg.ORIGIN + '/', { waitUntil: 'commit', timeout: 20000 }); } catch { /* keep going */ }
      for (let i = 0; i < 150; i++) {
        try { if (await page.evaluate('!!(window.grecaptcha && (window.grecaptcha.enterprise || window.grecaptcha.execute))')) return true; } catch { /* page not ready */ }
        await new Promise((r) => setTimeout(r, 120));
      }
      return false;
    })();
    this.ctxs.set(id, { ctx, page, ready });
    await ready;
    return page;
  }

  async _mint(id, action = 'ask') {
    try {
      const page = await this._page(id);
      if (!page) return '';
      const res = await page.evaluate(SCRIPT(action, this.siteKeys.get(id) || null));
      if (res && res.ok && res.token) { if (res.siteKey) this.siteKeys.set(id, res.siteKey); return res.token; }
      if (res && res.error === 'sitekey_not_found') this.siteKeys.delete(id);
    } catch { /* ignore */ }
    return '';
  }

  premint(id, action = 'ask') {
    if (!this.enabled || !id) return;
    const cur = this.minted.get(id) || {};
    if (cur.pending) return;
    cur.pending = true; this.minted.set(id, cur);
    this._mint(id, action).then((token) => {
      const n = this.minted.get(id) || {}; n.pending = false;
      if (token) { n.token = token; n.at = Date.now(); }
      this.minted.set(id, n);
    }).catch(() => { const n = this.minted.get(id) || {}; n.pending = false; this.minted.set(id, n); });
  }

  warmup(id) { this.premint(id); }

  /** A fresh single-use token or '' (never blocks longer than the budget). */
  async getFreshToken(action, id) {
    if (!this.enabled || !id) return '';
    const cur = this.minted.get(id);
    if (cur && cur.token && Date.now() - cur.at < TOKEN_TTL_MS) {
      const t = cur.token; cur.token = ''; this.premint(id, action); return t;
    }
    const budget = new Promise((r) => setTimeout(() => r(''), TOKEN_WAIT_BUDGET_MS));
    const t = await Promise.race([this._mint(id, action), budget]);
    this.premint(id, action);
    return t || '';
  }

  async close() {
    for (const { ctx } of this.ctxs.values()) { try { await ctx.close(); } catch { /* ignore */ } }
    this.ctxs.clear();
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.browser = null;
  }
}
