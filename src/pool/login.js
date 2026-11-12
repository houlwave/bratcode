// Adding accounts to the pool:
//   1) loginInWindow()  - opens a REAL browser window and closes after /api/user confirms sign-in
//   2) importFromBrowsers() - read-only import of existing Genspark sessions from the user's Chrome/Brave/Edge profiles on this Mac
//   3) importFromFile() - claudehack export (accounts.json + partitions) or a plain cookies.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { findBrowserExecutable, HOME, IS_MAC } from '../paths.js';
import * as cfg from './config.js';
import { fetchUserInfo, parseUserInfo } from './balance.js';

// ---------------------------------------------------------------- 1) window login
export async function loginInWindow(store, { onStatus, timeoutMs = 10 * 60 * 1000, signal, findExecutable = findBrowserExecutable, browserType } = {}) {
  if (signal?.aborted) throw new Error('cancelled');
  const exe = findExecutable({ headed: true });
  if (!exe) throw new Error('no window-capable browser. Install Google Chrome or rerun the bratcode installer (headless-shell cannot show a login window).');
  if (!IS_MAC && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !browserType) {
    throw new Error('no graphical display: run bratcode in a desktop session to sign in');
  }
  const chromium = browserType || (await import('playwright-core')).chromium;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bratcode-login-'));
  let ctx;
  const closeOnAbort = () => { ctx?.close().catch(() => {}); };
  try {
    onStatus?.('starting browser...');
    ctx = await chromium.launchPersistentContext(profile, {
      executablePath: exe, headless: false, timeout: 20000,
      viewport: { width: 1000, height: 760 },
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    signal?.addEventListener('abort', closeOnAbort, { once: true });
    if (signal?.aborted) throw new Error('cancelled');
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.bringToFront();
    onStatus?.('browser opened - sign in to genspark.ai there');
    await page.goto(cfg.ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const t0 = Date.now();
    for (;;) {
      if (signal?.aborted) throw new Error('cancelled');
      if (Date.now() - t0 > timeoutMs) throw new Error('login timed out');
      const pages = ctx.pages().filter((p) => !p.isClosed());
      if (!pages.length) throw new Error('login window was closed before sign-in completed');
      // Verify inside the real signed-in browser, not with a separate Node TLS session.
      const current = pages.find((p) => { try { return new URL(p.url()).origin === cfg.ORIGIN; } catch { return false; } });
      if (current) {
        const json = await current.evaluate(async (userPath) => {
          try {
            const res = await fetch(userPath, { credentials: 'include', signal: AbortSignal.timeout(8000) });
            return res.ok ? await res.json() : null;
          } catch { return null; }
        }, cfg.USER_PATH).catch(() => null);
        const info = parseUserInfo(json);
        if (info.ok) {
          onStatus?.('signed in, saving the session');
          return saveVerifiedCookies(store, await ctx.cookies(cfg.ORIGIN), info);
        }
      }
      await delay(1500, undefined, { signal });
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('cancelled');
    if (!ctx) throw new Error('login browser failed to start: ' + String(e.message || e).split('\n')[0] + '. Install Google Chrome or rerun the installer.');
    throw e;
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    try { await ctx?.close(); } catch { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export async function addFromCookies(store, cookies, { verifyInBrowser } = {}) {
  const { CookieJar } = await import('./jar.js');
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-add-'));
  const tmp = new CookieJar(path.join(probeDir, 'cookies.json'));
  // A probe may absorb refreshed cookies; remove its private temporary jar on every exit.
  try {
    tmp.setAll(cookies);
    let info = await fetchUserInfo(tmp, 10000);
    if (!info.ok && !info.dead && verifyInBrowser) {
      const browserResult = await verifyInBrowser(cookies);
      if (browserResult.info.ok) tmp.setAll(browserResult.cookies);
      info = browserResult.info;
    }
    if (!info.ok) throw new Error(sessionError(info));
    return saveVerifiedCookies(store, tmp.list, info);
  } finally { fs.rmSync(probeDir, { recursive: true, force: true }); }
}

export function sessionError(info) {
  if (info.reason === 'not-login') return 'session expired or signed out: sign in again';
  if (info.reason === 'blocked') return 'Genspark blocked the API check (HTTP 403 / browser challenge); cookies were not proven invalid. Use a sign-in window or retry later.';
  return `cannot verify Genspark session: ${info.reason}${info.status ? ` (HTTP ${info.status})` : ''}; retry or use a sign-in window`;
}

function saveVerifiedCookies(store, cookies, info) {
  const dup = store.list().find((a) => a.email && a.email.toLowerCase() === info.email.toLowerCase());
  if (dup) { store.jar(dup.id).replaceAll(cookies); store.update(dup.id, (a) => { delete a.dead; delete a.loggedOutAt; }); return { account: store.get(dup.id), updated: true }; }
  const acc = store.add({ name: info.name || info.email, email: info.email, cookies });
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

// ---------------------------------------------------------------- 2b) import from a claudehack folder
// claudehack (the Electron desktop app) is itself an Electron/Chromium app: it keeps its own
// accounts.json plus one real Chromium profile per account under <folder>/Partitions/account_<id>/.
// Each profile's Cookies db is encrypted exactly like a browser's, but the Keychain item is named
// after the app's productName ("Claude Safe Storage" / account "Claude") instead of a browser name.
// SQLite's read-only backup includes committed WAL transactions without altering the app's data.
export function detectClaudehackKeychainName(dir) {
  // best-effort: the keychain service name is "<productName> Safe Storage"; claudehack's
  // productName is "Claude", but let the caller override via BRATCODE_CLAUDEHACK_KEYCHAIN.
  return process.env.BRATCODE_CLAUDEHACK_KEYCHAIN || 'Claude';
}

export function listClaudehackAccounts(dir) {
  // reading accounts.json + locating each profile's Cookies file is just disk I/O,
  // so this part works everywhere; only readClaudehackCookies() needs the macOS Keychain.
  const root = String(dir || '').trim();
  if (!root) return [];
  const dbPath = path.join(root, 'accounts.json');
  const partitionsRoot = path.join(root, 'Partitions');
  let db;
  try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch { throw new Error(`no accounts.json in ${root}`); }
  const accounts = Array.isArray(db.accounts) ? db.accounts : [];
  const out = [];
  for (const a of accounts) {
    if (!a || !a.id) continue;
    const partDir = path.join(partitionsRoot, `account_${a.id}`);
    const cookies = [path.join(partDir, 'Network', 'Cookies'), path.join(partDir, 'Cookies')].find((p) => fs.existsSync(p));
    if (cookies) out.push({ id: a.id, name: a.name || a.email || a.id, email: a.email || '', cookies });
  }
  return out;
}

/** Read-only: decrypts one claudehack account's Cookies db via its app Keychain item. */
export function readClaudehackCookies(entry, keychainName) {
  if (!IS_MAC) throw new Error('claudehack import works on macOS only');
  return readGensparkCookies({ keychain: keychainName || detectClaudehackKeychainName(), cookies: entry.cookies });
}

// Lazy shared browser, isolated context per account; never merges different users' cookies.
export function createImportVerifier({ browserType, findExecutable = findBrowserExecutable } = {}) {
  let browserPromise;
  return {
    async verify(cookies) {
      browserPromise ||= (async () => {
        const chromium = browserType || (await import('playwright-core')).chromium;
        const executablePath = findExecutable();
        if (!executablePath) throw new Error('no browser for session verification; rerun the installer');
        return chromium.launch({ executablePath, headless: true, timeout: 20000 });
      })();
      const browser = await browserPromise;
      const ctx = await browser.newContext();
      try {
        const { CookieJar } = await import('./jar.js');
        const jar = new CookieJar(''); // normalization only; this jar is never persisted
        jar.setAll(cookies);
        await ctx.addCookies(jar.toPlaywright());
        const page = await ctx.newPage();
        const res = await page.goto(cfg.ORIGIN + cfg.USER_PATH, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (!res || !res.ok()) {
          return { info: { ok: false, reason: res?.status() === 401 ? 'not-login' : 'blocked' }, cookies: [] };
        }
        let json; try { json = await res.json(); } catch { /* challenge / non-JSON */ }
        return { info: json ? parseUserInfo(json) : { ok: false, reason: 'blocked' }, cookies: await ctx.cookies(cfg.ORIGIN) };
      } finally { await ctx.close(); }
    },
    async close() { try { await (await browserPromise)?.close(); } catch { /* failed launch */ } },
  };
}

/** Import every account from a claudehack userData folder (read-only, never touches claudehack's files). */
export async function importFromClaudehackDir(store, dir, { onStatus, readCookies = readClaudehackCookies, createVerifier = createImportVerifier } = {}) {
  const entries = listClaudehackAccounts(dir);
  const keychain = detectClaudehackKeychainName(dir);
  const added = [], failed = [];
  const verifier = createVerifier();
  try {
    for (const e of entries) {
      onStatus?.(e.name);
      try {
        const cookies = readCookies(e, keychain);
        if (!cfg.hasAuthCookie(cookies)) { failed.push({ from: e.name, error: 'no session cookie (logged out?)' }); continue; }
        const r = await addFromCookies(store, cookies, { verifyInBrowser: (c) => verifier.verify(c) });
        added.push({ ...r, from: e.name });
      } catch (err) { failed.push({ from: e.name, error: String(err.message || err) }); }
    }
  } finally { await verifier.close(); }
  return { added, failed, scanned: entries.length };
}

// Chromium on macOS: v10 + AES-128-CBC, key = PBKDF2(keychain password, 'saltysalt', 1003, 16), iv = 16 spaces.
export function decryptChromiumCookie(buf, key, dbVersion = 0, domain) {
  if (!buf || !buf.length) return '';
  const tag = buf.subarray(0, 3).toString();
  if (tag !== 'v10' && tag !== 'v11') return buf.toString('utf8');
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let out = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  const hostHash = domain === undefined ? null : crypto.createHash('sha256').update(domain).digest();
  const hasHash = hostHash && out.length >= 32 && out.subarray(0, 32).equals(hostHash);
  if (dbVersion >= 24 && hostHash && !hasHash) throw new Error('cookie host hash mismatch (wrong Keychain key or damaged database)');
  if (hasHash || (dbVersion >= 24 && out.length >= 32)) out = out.subarray(32);
  return out.toString('utf8');
}
export const deriveKey = (password) => crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');

/** Read-only SQLite snapshot includes committed WAL data even while the app is open. */
export function snapshotCookieDatabase(source, destination, run = execFileSync) {
  run('sqlite3', ['-readonly', source, '.timeout 5000', `.backup ${JSON.stringify(destination)}`], {
    encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Read-only: snapshots the Cookies DB to a temp file, never changes the browser profile. */
export function readGensparkCookies(profile) {
  if (!IS_MAC) throw new Error('browser import works on macOS only');
  let pass = '';
  try { pass = execFileSync('security', ['find-generic-password', '-w', '-s', `${profile.keychain} Safe Storage`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error(`macOS Keychain refused access to "${profile.keychain} Safe Storage". Click "Allow" in the system dialog and retry.`); }
  const key = deriveKey(pass);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cookies-'));
  const tmp = path.join(tmpDir, 'Cookies');
  try {
    snapshotCookieDatabase(profile.cookies, tmp);
    const q = (sql) => execFileSync('sqlite3', ['-json', tmp, sql], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    let ver = 0; try { ver = Number(JSON.parse(q("select value from meta where key='version'") || '[]')[0]?.value) || 0; } catch { /* old schema */ }
    const rows = JSON.parse(q("select host_key as domain, name, hex(encrypted_value) as enc, value, path, expires_utc, is_secure as secure, is_httponly as httpOnly from cookies where host_key like '%genspark.ai'") || '[]');
    return rows.map((r) => {
      let value = r.value || '';
      if (!value && r.enc) { try { value = decryptChromiumCookie(Buffer.from(r.enc, 'hex'), key, ver, r.domain); } catch { value = ''; } }
      const expires = r.expires_utc > 0 ? Math.floor(r.expires_utc / 1e6 - 11644473600) : -1;
      return { name: r.name, value, domain: r.domain, path: r.path || '/', expires, secure: !!r.secure, httpOnly: !!r.httpOnly };
    }).filter((c) => c.value);
  } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

export async function importFromBrowsers(store, { onStatus } = {}) {
  const profiles = listBrowserProfiles();
  const added = [], failed = [];
  const verifier = createImportVerifier();
  try {
    for (const p of profiles) {
      onStatus?.(`${p.browser} / ${p.profile}`);
      try {
        const cookies = readGensparkCookies(p);
        if (!cfg.hasAuthCookie(cookies)) continue;
        const r = await addFromCookies(store, cookies, { verifyInBrowser: (c) => verifier.verify(c) });
        added.push({ ...r, from: `${p.browser}/${p.profile}` });
      } catch (e) { failed.push({ from: `${p.browser}/${p.profile}`, error: String(e.message || e) }); }
    }
  } finally { await verifier.close(); }
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

/** True-ish check that a folder looks like a claudehack userData dir (accounts.json present). */
export function looksLikeClaudehackDir(dir) {
  try { return fs.existsSync(path.join(String(dir || ''), 'accounts.json')); } catch { return false; }
}
