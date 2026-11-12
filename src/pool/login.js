// Adding accounts to the pool:
//   1) loginInWindow()  - opens a REAL (visible) browser window on genspark.ai; as soon as the auth cookie appears the window closes
//   2) importFromBrowsers() - read-only import of existing Genspark sessions from the user's Chrome/Brave/Edge profiles on this Mac
//   3) importFromFile() - claudehack export (accounts.json + partitions) or a plain cookies.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { findBrowserExecutable, HOME, IS_MAC } from '../paths.js';
import * as cfg from './config.js';
import { fetchUserInfo } from './balance.js';

// ---------------------------------------------------------------- 1) window login
export async function loginInWindow(store, { onStatus, timeoutMs = 10 * 60 * 1000, signal } = {}) {
  const exe = findBrowserExecutable();
  if (!exe) throw new Error('no Chrome/Brave/Chromium found. Install one (brew install --cask google-chrome) or use /accounts import');
  const { chromium } = await import('playwright-core');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bratcode-login-'));
  onStatus?.('opening a window - sign in to genspark.ai there');
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: exe, headless: false, viewport: { width: 1000, height: 760 }, args: ['--no-first-run', '--no-default-browser-check'] });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(cfg.ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const t0 = Date.now();
    for (;;) {
      if (signal?.aborted) throw new Error('cancelled');
      if (Date.now() - t0 > timeoutMs) throw new Error('login timed out');
      const cookies = await ctx.cookies(cfg.ORIGIN);
      if (cfg.hasAuthCookie(cookies) && (await looksSignedIn(cookies))) {
        onStatus?.('signed in, saving the session');
        return addFromCookies(store, cookies);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function looksSignedIn(cookies) {
  // the cookie alone also appears for anonymous visitors; confirm with /api/user
  const { CookieJar } = await import('./jar.js');
  const j = new CookieJar(path.join(os.tmpdir(), 'bc-probe-' + process.pid + '.json'));
  j.setAll(cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, secure: c.secure, httpOnly: c.httpOnly })));
  const u = await fetchUserInfo(j, 8000);
  return !!u.ok;
}

export async function addFromCookies(store, cookies) {
  const { CookieJar } = await import('./jar.js');
  const tmp = new CookieJar(path.join(os.tmpdir(), 'bc-add-' + process.pid + '-' + Date.now() + '.json'));
  tmp.setAll(cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite })));
  const info = await fetchUserInfo(tmp, 10000);
  if (!info.ok) throw new Error('these cookies are not a signed-in genspark session (' + info.reason + ')');
  const dup = store.list().find((a) => a.email && a.email === info.email);
  if (dup) { store.jar(dup.id).replaceAll(tmp.list); store.update(dup.id, (a) => { delete a.dead; delete a.loggedOutAt; }); return { account: store.get(dup.id), updated: true }; }
  const acc = store.add({ name: info.name || info.email, email: info.email, cookies: tmp.list });
  return { account: acc, updated: false };
}

// ---------------------------------------------------------------- 2) import from the Mac browsers
const BROWSERS = [
  { name: 'Chrome', dir: 'Google/Chrome', keychain: 'Chrome' },
  { name: 'Brave', dir: 'BraveSoftware/Brave-Browser', keychain: 'Brave' },
  { name: 'Edge', dir: 'Microsoft Edge', keychain: 'Microsoft Edge' },
  { name: 'Chromium', dir: 'Chromium', keychain: 'Chromium' },
];

export function listBrowserProfiles() {
  if (!IS_MAC) return [];
  const out = [];
  for (const b of BROWSERS) {
    const root = path.join(HOME, 'Library', 'Application Support', b.dir);
    let dirs = []; try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      if (!(d === 'Default' || /^Profile \d+$/.test(d))) continue;
      const cookies = [path.join(root, d, 'Network', 'Cookies'), path.join(root, d, 'Cookies')].find((p) => fs.existsSync(p));
      if (cookies) out.push({ browser: b.name, keychain: b.keychain, profile: d, cookies });
    }
  }
  return out;
}

// Chromium on macOS: v10 + AES-128-CBC, key = PBKDF2(keychain password, 'saltysalt', 1003, 16), iv = 16 spaces.
export function decryptChromiumCookie(buf, key, dbVersion = 0) {
  if (!buf || buf.length < 4) return '';
  const tag = buf.subarray(0, 3).toString();
  if (tag !== 'v10' && tag !== 'v11') return buf.toString('utf8');
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let out = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  if (dbVersion >= 24 && out.length > 32) out = out.subarray(32); // newer Chrome prefixes the host hash
  return out.toString('utf8');
}
export const deriveKey = (password) => crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');

/** Read-only: copies the Cookies DB to a temp file, never touches the browser profile. */
export function readGensparkCookies(profile) {
  if (!IS_MAC) throw new Error('browser import works on macOS only');
  let pass = '';
  try { pass = execFileSync('security', ['find-generic-password', '-w', '-s', `${profile.keychain} Safe Storage`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error(`macOS Keychain refused access to "${profile.keychain} Safe Storage". Click "Allow" in the system dialog and retry.`); }
  const key = deriveKey(pass);
  const tmp = path.join(os.tmpdir(), `bc-cookies-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(profile.cookies, tmp);
  try {
    const q = (sql) => execFileSync('sqlite3', ['-json', tmp, sql], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    let ver = 0; try { ver = Number(JSON.parse(q("select value from meta where key='version'") || '[]')[0]?.value) || 0; } catch { /* old schema */ }
    const rows = JSON.parse(q("select host_key as domain, name, hex(encrypted_value) as enc, value, path, expires_utc, is_secure as secure, is_httponly as httpOnly from cookies where host_key like '%genspark.ai'") || '[]');
    return rows.map((r) => {
      let value = r.value || '';
      if (!value && r.enc) { try { value = decryptChromiumCookie(Buffer.from(r.enc, 'hex'), key, ver); } catch { value = ''; } }
      const expires = r.expires_utc > 0 ? Math.floor(r.expires_utc / 1e6 - 11644473600) : -1;
      return { name: r.name, value, domain: r.domain, path: r.path || '/', expires, secure: !!r.secure, httpOnly: !!r.httpOnly };
    }).filter((c) => c.value);
  } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
}

export async function importFromBrowsers(store, { onStatus } = {}) {
  const profiles = listBrowserProfiles();
  const added = [], failed = [];
  for (const p of profiles) {
    onStatus?.(`${p.browser} / ${p.profile}`);
    try {
      const cookies = readGensparkCookies(p);
      if (!cfg.hasAuthCookie(cookies)) continue;
      const r = await addFromCookies(store, cookies);
      added.push({ ...r, from: `${p.browser}/${p.profile}` });
    } catch (e) { failed.push({ from: `${p.browser}/${p.profile}`, error: String(e.message || e) }); }
  }
  return { added, failed, scanned: profiles.length };
}

// ---------------------------------------------------------------- 3) file import
/** claudehack export dir (accounts.json) or a JSON file with an array of cookies. */
export async function importFromFile(store, file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) return { added: [await addFromCookies(store, raw)], failed: [] };
  if (Array.isArray(raw.cookies)) return { added: [await addFromCookies(store, raw.cookies)], failed: [] };
  if (Array.isArray(raw.accounts)) {
    const added = [];
    for (const a of raw.accounts) {
      const part = path.join(path.dirname(file), 'partitions', `account_${a.id}`, 'cookies.json');
      if (!fs.existsSync(part)) continue;
      try { added.push(await addFromCookies(store, JSON.parse(fs.readFileSync(part, 'utf8')))); } catch { /* skip */ }
    }
    return { added, failed: [] };
  }
  throw new Error('unknown file format');
}
