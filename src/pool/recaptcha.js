// reCAPTCHA token minting in an INVISIBLE headless browser (playwright-core + system Chrome/Brave/Chromium).
// One shared browser, one context per account (cookies from the account jar). Tokens are pre-minted.
// The same browser context also sends the API requests (like claudehack's
// electron.net session). A token must not be minted here then sent via Node TLS.
import { findBrowserExecutable } from '../paths.js';
import * as cfg from './config.js';
import { browserFetch } from './browser-fetch.js';

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
  constructor({ store, enabled = true, browserType, findExecutable = findBrowserExecutable } = {}) {
    this.store = store;
    this.enabled = enabled && process.env.BRATCODE_NO_RECAPTCHA !== '1';
    this.browser = null;
    this.browserPending = null;
    this.browserType = browserType;
    this.findExecutable = findExecutable;
    this.closed = false;
    this.ctxs = new Map();   // accountId -> { ctx, page, ready }
    this.minted = new Map(); // accountId -> { token, at, pending }
    this.siteKeys = new Map();
    this.unavailable = '';
  }

  async _browser() {
    if (this.closed) return null;
    if (this.browser) return this.browser;
    if (this.browserPending) return this.browserPending;
    if (this.unavailable) return null;
    this.browserPending = (async () => {
      // Prefer full Chrome's modern headless mode, not the legacy headless shell.
      const exe = this.findExecutable({ headed: true }) || this.findExecutable();
      if (!exe) { this.unavailable = 'no browser; install Chrome or rerun the bratcode installer'; return null; }
      try {
        const chromium = this.browserType || (await import('playwright-core')).chromium;
        const browser = await chromium.launch({ executablePath: exe, headless: true, timeout: 20000, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio'] });
        if (this.closed) { await browser.close(); return null; }
        this.browser = browser;
        browser.on('disconnected', () => { this.browser = null; this.ctxs.clear(); this.minted.clear(); this.siteKeys.clear(); });
        return browser;
      } catch (e) { this.unavailable = String(e.message || e).slice(0, 120); return null; }
    })();
    try { return await this.browserPending; } finally { this.browserPending = null; }
  }

  async _page(id) {
    let entry = this.ctxs.get(id);
    if (entry && entry.page?.isClosed()) {
      await entry.ctx.close().catch(() => {});
      this.ctxs.delete(id); entry = null;
    }
    if (!entry) {
      entry = {};
      // Publish the promise BEFORE launching: warmup, balance and send may race.
      this.ctxs.set(id, entry);
      entry.ready = (async () => {
        const browser = await this._browser();
        if (!browser || this.closed) throw new Error(this.unavailable || 'browser closed');
        const ctx = entry.ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
        const jar = this.store.jar(id);
        jar.prune();
        await ctx.addCookies(jar.toPlaywright()); // Never silently send anonymously.
        entry.cookieState = JSON.stringify(jar.list);
        await ctx.route('**/*', (route) => BLOCKED_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue());
        const page = entry.page = await ctx.newPage();
        await page.goto(cfg.ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (new URL(page.url()).origin !== new URL(cfg.ORIGIN).origin) throw new Error('browser is not on the Genspark origin');
        return page;
      })();
    }
    try {
      const page = await entry.ready;
      const jar = this.store.jar(id);
      jar.prune();
      // Reimport / sign-in may replace a cached jar while the CLI stays open.
      // Invalidate both browser cookies and prefetched tokens together.
      if (JSON.stringify(jar.list) !== entry.cookieState) {
        await entry.ctx.clearCookies();
        await entry.ctx.addCookies(jar.toPlaywright());
        entry.cookieState = JSON.stringify(jar.list);
        this.minted.delete(id); this.siteKeys.delete(id);
      }
      return page;
    } catch (e) {
      if (this.ctxs.get(id) === entry) this.ctxs.delete(id);
      await entry.ctx?.close().catch(() => {});
      throw Object.assign(new Error('Account browser unavailable: ' + String(e.message || e)), { code: 'browser-session-unavailable' });
    }
  }

  async _saveCookies(id) {
    const entry = this.ctxs.get(id);
    if (!entry?.ctx) return;
    const jar = this.store.jar(id);
    const before = entry.cookieState;
    const host = new URL(cfg.ORIGIN).hostname;
    const cookies = (await entry.ctx.cookies()).filter((c) => {
      const domain = c.domain.replace(/^\./, '');
      return host === domain || host.endsWith('.' + domain);
    });
    // Do not overwrite a newer sign-in with an older in-flight response.
    if (JSON.stringify(jar.list) !== before) return;
    jar.replaceAll(cookies);
    entry.cookieState = JSON.stringify(jar.list);
  }

  async fetch(id, url, opts = {}) {
    opts.signal?.throwIfAborted();
    let stopWaiting;
    const cancelled = new Promise((_, reject) => {
      stopWaiting = () => reject(opts.signal.reason || new DOMException('Aborted', 'AbortError'));
      opts.signal?.addEventListener('abort', stopWaiting, { once: true });
    });
    let page;
    try { page = await Promise.race([this._page(id), cancelled]); }
    finally { opts.signal?.removeEventListener('abort', stopWaiting); }
    opts.signal?.throwIfAborted();
    const response = await browserFetch(page, url, opts);
    // Set-Cookie is not exposed by in-page fetch; Chromium owns it. Synchronize
    // the private jar, without copying any other account's context or storage.
    await this._saveCookies(id).catch(() => {});
    return response;
  }

  async _mint(id, action = 'ask') {
    try {
      const page = await this._page(id);
      if (!page) return '';
      const res = await page.evaluate(SCRIPT(action, this.siteKeys.get(id) || null));
      await this._saveCookies(id).catch(() => {});
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
    const entry = this.ctxs.get(id);
    if (entry && JSON.stringify(this.store.jar(id).list) !== entry.cookieState) this.minted.delete(id);
    const cur = this.minted.get(id);
    if (cur && cur.token && Date.now() - cur.at < TOKEN_TTL_MS) {
      const t = cur.token; cur.token = ''; this.premint(id, action); return t;
    }
    let timer;
    const budget = new Promise((r) => { timer = setTimeout(() => r(''), TOKEN_WAIT_BUDGET_MS); });
    let t;
    try { t = await Promise.race([this._mint(id, action), budget]); }
    finally { clearTimeout(timer); }
    this.premint(id, action);
    return t || '';
  }

  async close() {
    this.closed = true;
    try { await this.browserPending; } catch { /* failed launch */ }
    await Promise.allSettled([...this.ctxs.values()].map(async (entry) => {
      try { await entry.ready; } catch { /* failed page */ }
      try { await entry.ctx?.close(); } catch { /* ignore */ }
    }));
    this.ctxs.clear(); this.minted.clear(); this.siteKeys.clear();
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.browser = null;
  }
}
