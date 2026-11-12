import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, eq, ok, has } from './helpers.js';
import { startMock } from './mock-genspark.js';
import { setOrigin } from '../src/pool/config.js';
import { AccountStore } from '../src/pool/accounts.js';
import { Pool } from '../src/pool/pool.js';
import { Runner, buildAgentPrompt } from '../src/pool/runner.js';
import { createSseParser } from '../src/pool/sse-parser.js';
import { parseMemberBenefits, isModelLockedFor, modelKey } from '../src/pool/model-access.js';
import { looksCreditExhaustedStrict, stripCreditNotice } from '../src/pool/config.js';
import { parseModelId, resolveModelId, buildCatalog } from '../src/pool/models.js';
import { CookieJar } from '../src/pool/jar.js';
import { decryptChromiumCookie, deriveKey, listClaudehackAccounts, looksLikeClaudehackDir, snapshotCookieDatabase, loginInWindow, addFromCookies, createImportVerifier, importFromClaudehackDir } from '../src/pool/login.js';
import { findBrowserExecutable } from '../src/paths.js';
import { fetchUserInfo, parseUserInfo } from '../src/pool/balance.js';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { createSandbox } from '../src/sandbox/server.js';

console.log('pool');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pool-'));
const exp = (d) => Date.now() / 1000 + d;
const cookie = (v) => ({ name: 'gs_session', value: v, domain: '127.0.0.1', path: '/', expires: exp(3600) });

const accountsDef = {
  A: { email: 'a@x.io', tokens: 500 },
  B: { email: 'b@x.io', tokens: 900 },
  C: { email: 'c@x.io', tokens: 0 },
};
const mock = await startMock(accountsDef);
setOrigin(mock.origin);

function mkPool(def = ['A', 'B', 'C']) {
  const store = new AccountStore({ file: path.join(tmp, 'acc-' + Math.random().toString(36).slice(2) + '.json') });
  const ids = {};
  for (const k of def) { const a = store.add({ id: 'id' + k, name: 'acc' + k, email: accountsDef[k].email, cookies: [cookie(k)] }); ids[k] = a.id; }
  return { store, ids, pool: new Pool({ store, typingGapMs: 50 }) };
}

await test('SSE parser: split frames, multi-line data, utf8 across chunks', () => {
  const got = [];
  const p = createSseParser((d) => got.push(d));
  const buf = Buffer.from('data: {"a":"при', 'utf8');
  p.push(Buffer.from('data: {"a":"при'));
  p.push(Buffer.from('вет"}\n\n: keepalive\n\ndata: x\ndata: y\n\n'));
  p.end();
  eq(got, ['{"a":"привет"}', 'x\ny']);
});

await test('credit exhaustion detection (RU/EN) + notice stripping', () => {
  ok(looksCreditExhaustedStrict('Ваш баланс кредитов отрицательный. Этот запуск остановлен.'));
  ok(looksCreditExhaustedStrict('Please top up to continue'));
  ok(!looksCreditExhaustedStrict('Расскажи про кредиты в банке. '.repeat(30)));
  eq(stripCreditNotice('Часть ответа\nВаш баланс кредитов отрицательный.\n[upgrade]'), 'Часть ответа');
});

await test('model access: locked flagship models, version-aware keys', () => {
  const r = parseMemberBenefits({ status: 0, ai_chat: { flagship_locked: true, flagship_models: ['claude-opus-5-5'], member_only_locked: false } });
  eq(r, { ok: true, locked: ['claude-opus-5-5'] });
  ok(isModelLockedFor({ lockedModels: ['claude-opus-5-5'] }, 'claude-opus-5.5'));
  ok(!isModelLockedFor({ lockedModels: ['claude-opus-5-5'] }, 'claude-opus-5'));
  eq(modelKey('claude-4-5-haiku'), 'claude:haiku:4.5');
  eq(parseMemberBenefits({ status: 0 }).ok, false);
});

await test('model catalog: latest per family, stale id -> fresh', () => {
  const c = buildCatalog([{ id: 'claude-opus-5', family: 'opus', version: [5] }, { id: 'claude-opus-5-5', family: 'opus', version: [5, 5] }, { id: 'claude-sonnet-4-6', family: 'sonnet', version: [4, 6] }]);
  eq(c.primary.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-4-6']);
  eq(c.more.map((m) => m.id), ['claude-opus-5']);
  eq(parseModelId('claude-4-5-haiku').version, [4, 5]);
});

await test('cookie jar: set-cookie absorb, domain/path match, expiry, 0600 file', async () => {
  const f = path.join(tmp, 'jar.json');
  const j = new CookieJar(f);
  j.set({ name: 'a', value: '1', domain: 'genspark.ai', path: '/', expires: exp(100) });
  j.set({ name: 'old', value: '2', domain: 'genspark.ai', path: '/', expires: exp(-10) });
  ok(j.header('https://www.genspark.ai/x').includes('a=1')); ok(!j.header('https://www.genspark.ai/x').includes('old'));
  ok(!j.header('https://evil.com/').includes('a=1'));
  j.save(); eq(fs.statSync(f).mode & 0o777, 0o600);
});

await test('chromium cookie decryption (v10, AES-128-CBC)', () => {
  const key = deriveKey('pw');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const enc = Buffer.concat([Buffer.from('v10'), c.update('secret-value'), c.final()]);
  eq(decryptChromiumCookie(enc, key, 0), 'secret-value');
});

await test('headed browser discovery skips headless shell, including CHROMIUM_PATH override', () => {
  const shell = '/fake/chromium_headless_shell-100/chrome-headless-shell-linux64/chrome-headless-shell';
  const chrome = '/fake/chromium-100/chrome-linux64/chrome';
  const opts = {
    env: { CHROMIUM_PATH: shell, PLAYWRIGHT_BROWSERS_PATH: '/fake' },
    exists: (f) => [shell, chrome].includes(f),
    readDir: (dir) => dir === '/fake' ? ['chromium_headless_shell-100', 'chromium-100'] : [],
  };
  eq(findBrowserExecutable(opts), shell);
  eq(findBrowserExecutable({ ...opts, headed: true }), chrome);
  eq(findBrowserExecutable({ ...opts, headed: true, exists: (f) => f === shell }), undefined);
});

await test('headed discovery recognises macOS x64 Chrome for Testing', () => {
  const exe = '/fake/chromium-100/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  eq(findBrowserExecutable({ headed: true, env: { PLAYWRIGHT_BROWSERS_PATH: '/fake' }, exists: (f) => f === exe, readDir: () => ['chromium-100'] }), exe);
});

await test('Chromium v24 host hash is stripped and validated; legacy plaintext remains intact', () => {
  const key = deriveKey('pw');
  const hash = crypto.createHash('sha256').update('.genspark.ai').digest();
  const encrypt = (value) => {
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from('v10'), c.update(value), c.final()]);
  };
  const enc = encrypt(Buffer.concat([hash, Buffer.from('live-session')]));
  eq(decryptChromiumCookie(enc, key, 24, '.genspark.ai'), 'live-session');
  eq(decryptChromiumCookie(enc, key, 0, '.genspark.ai'), 'live-session');
  eq(decryptChromiumCookie(encrypt(hash), key, 24, '.genspark.ai'), '');
  eq(decryptChromiumCookie(Buffer.from('abc'), key), 'abc');
  let error; try { decryptChromiumCookie(enc, key, 24, 'wrong.ai'); } catch (e) { error = e; }
  has(error.message, 'host hash mismatch');
});

await test('user parser accepts wrapped and top-level Genspark response shapes', () => {
  for (const json of [
    { data: { cogen: { email: 'user@x.io' } } },
    { data: { user: { email: 'user@x.io' } } },
    { cogen: { email: 'user@x.io' } },
    { user: { email: 'user@x.io' } },
    { email: 'user@x.io' },
  ]) eq(parseUserInfo(json).email, 'user@x.io');
  eq(parseUserInfo({ status: -5, data: { email: 'stale@x.io' } }).reason, 'not-login');
  eq(parseUserInfo(null).ok, false);
  eq(parseUserInfo({ status: 0, data: {} }).ok, false);
});

await test('WAL snapshot imports committed cookies absent from the main SQLite file (read-only)', async () => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); }
  catch { console.log('    skipped SQLite integration: sqlite3 is not installed'); return; }
  const dir = fs.mkdtempSync(path.join(tmp, "wal's-"));
  const source = path.join(dir, 'Cookies');
  const destination = path.join(dir, 'snapshot.db');
  const db = spawn('sqlite3', [source]);
  const exited = once(db, 'exit');
  try {
    const ready = new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('SQLite fixture timed out')), 5000);
      db.stdout.on('data', (part) => { output += part; if (output.includes('ready')) { clearTimeout(timer); resolve(); } });
      db.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    db.stdin.write("PRAGMA journal_mode=WAL; CREATE TABLE cookies(value TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO cookies VALUES('fresh-session'); SELECT 'ready';\n");
    await ready;
    const beforeDb = fs.readFileSync(source), beforeWal = fs.readFileSync(source + '-wal');
    const stale = path.join(dir, 'stale.db'); fs.copyFileSync(source, stale);
    eq(execFileSync('sqlite3', [stale, 'select value from cookies'], { encoding: 'utf8' }), '');
    snapshotCookieDatabase(source, destination);
    eq(execFileSync('sqlite3', [destination, 'select value from cookies'], { encoding: 'utf8' }).trim(), 'fresh-session');
    ok(fs.readFileSync(source).equals(beforeDb)); ok(fs.readFileSync(source + '-wal').equals(beforeWal));
  } finally { db.stdin.end(); await exited; }
});

await test('API challenge is not misreported as signed-out; browser fallback verifies imported cookies', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
    res.end('<html>challenge</html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  setOrigin('http://127.0.0.1:' + server.address().port);
  const store = new AccountStore({ file: path.join(tmp, 'challenge-accounts.json') });
  const jar = new CookieJar(path.join(tmp, 'challenge.json')); jar.setAll([cookie('A')]);
  try {
    const info = await fetchUserInfo(jar);
    eq(info.reason, 'blocked'); ok(!info.dead);
    let error; try { await addFromCookies(store, [cookie('A')]); } catch (e) { error = e; }
    has(error.message, 'not proven invalid'); eq(store.list().length, 0);
    let called = 0;
    const result = await addFromCookies(store, [cookie('A')], { verifyInBrowser: async (cookies) => {
      called++; eq(cookies[0].value, 'A');
      return { info: { ok: true, email: 'browser@x.io', name: 'browser' }, cookies: [cookie('B')] };
    } });
    eq(called, 1); eq(result.account.email, 'browser@x.io');
    has(store.jar(result.account.id).header(mock.origin), 'gs_session=B');
  } finally { setOrigin(mock.origin); await new Promise((r) => server.close(r)); }
});

await test('browser import verifier isolates cookie contexts, reuses one browser, and closes resources', async () => {
  let launches = 0, contextCloses = 0, browserCloses = 0;
  const seen = [];
  const verifier = createImportVerifier({
    findExecutable: () => '/fake/chrome',
    browserType: { launch: async () => {
      launches++;
      return {
        close: async () => { browserCloses++; },
        newContext: async () => {
          let cookies;
          return {
            addCookies: async (c) => { cookies = c; seen.push(c); },
            cookies: async () => cookies,
            close: async () => { contextCloses++; },
            newPage: async () => ({ goto: async () => ({ ok: () => true, json: async () => ({ cogen: { email: cookies[0].value + '@x.io' } }) }) }),
          };
        },
      };
    } },
  });
  try {
    eq((await verifier.verify([cookie('A')])).info.email, 'A@x.io');
    eq((await verifier.verify([cookie('B')])).info.email, 'B@x.io');
    eq(seen.map((c) => c.map((x) => x.value)), [['A'], ['B']]);
    eq(launches, 1); eq(contextCloses, 2);
  } finally { await verifier.close(); }
  eq(browserCloses, 1);
});

await test('batch import verifies 148 synthetic claudehack profiles without mixing accounts', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'batch-'));
  const entries = Array.from({ length: 148 }, (_, i) => ({ id: String(i + 1), name: 'account-' + i }));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: entries }));
  for (const e of entries) {
    const part = path.join(dir, 'Partitions', 'account_' + e.id);
    fs.mkdirSync(part, { recursive: true }); fs.writeFileSync(path.join(part, 'Cookies'), 'fixture');
  }
  const server = http.createServer((req, res) => {
    const sid = /gs_session=sid_(\d+)/.exec(req.headers.cookie || '')?.[1];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 0, cogen: { email: `account-${sid}@x.io` } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  setOrigin('http://127.0.0.1:' + server.address().port);
  const store = new AccountStore({ file: path.join(tmp, 'batch-accounts.json') });
  let closed = false;
  try {
    const result = await importFromClaudehackDir(store, dir, {
      readCookies: (entry) => [{ ...cookie('sid_' + entry.id), domain: '.genspark.ai' }, cookie('sid_' + entry.id)],
      createVerifier: () => ({ verify: async () => { throw new Error('HTTP probe should suffice'); }, close: async () => { closed = true; } }),
    });
    eq(result.scanned, 148); eq(result.added.length, 148); eq(result.failed, []); eq(store.list().length, 148);
    for (const r of result.added) has(store.jar(r.account.id).header('https://www.genspark.ai'), 'gs_session=sid_' + r.account.email.match(/\d+/)[0]);
  } finally { setOrigin(mock.origin); await new Promise((r) => server.close(r)); }
  ok(closed);
});

await test('verified import updates existing account and does not duplicate email case variants', async () => {
  const { store, ids } = mkPool(['A']);
  store.update(ids.A, (a) => { a.email = 'A@X.IO'; a.dead = true; });
  const r = await addFromCookies(store, [cookie('A')]);
  eq(r.updated, true); eq(r.account.id, ids.A); ok(!r.account.dead); eq(store.list().length, 1);
});

await test('signed-out cookies are rejected without browser fallback or creating an account', async () => {
  const store = new AccountStore({ file: path.join(tmp, 'reject.json') });
  let called = false, error;
  try { await addFromCookies(store, [cookie('NOPE')], { verifyInBrowser: async () => { called = true; } }); } catch (e) { error = e; }
  has(error.message, 'expired'); eq(called, false); eq(store.list().length, 0);
});

await test('window login chooses headed browser, focuses it, verifies in-page and cleans profile', async () => {
  const store = new AccountStore({ file: path.join(tmp, 'window.json') });
  let opts, profile, closed = false, focused = false;
  const page = {
    isClosed: () => false, url: () => mock.origin + '/',
    bringToFront: async () => { focused = true; }, goto: async () => {},
    evaluate: async () => ({ cogen: { email: 'window@x.io' } }),
  };
  const r = await loginInWindow(store, {
    findExecutable: (o) => { eq(o.headed, true); return '/fake/chrome'; },
    browserType: { launchPersistentContext: async (p, o) => {
      profile = p; opts = o;
      return { pages: () => [page], cookies: async () => [cookie('A')], close: async () => { closed = true; } };
    } },
  });
  eq(opts.headless, false); eq(opts.timeout, 20000); ok(focused); ok(closed); ok(!fs.existsSync(profile));
  eq(r.account.email, 'window@x.io');
});

await test('failed browser launch cleans temporary profile and reports a useful error', async () => {
  let profile, error;
  try {
    await loginInWindow(null, {
      findExecutable: () => '/fake/chrome',
      browserType: { launchPersistentContext: async (p) => { profile = p; throw new Error('cannot launch'); } },
    });
  } catch (e) { error = e; }
  has(error.message, 'failed to start'); ok(!fs.existsSync(profile));
});

await test('closed login window and pre-aborted login fail promptly', async () => {
  const ctl = new AbortController(); ctl.abort();
  let error;
  try { await loginInWindow(null, { signal: ctl.signal, findExecutable: () => { throw new Error('must not launch'); } }); } catch (e) { error = e; }
  eq(error.message, 'cancelled');
  let closed = false;
  try {
    await loginInWindow(null, {
      findExecutable: () => '/fake/chrome',
      browserType: { launchPersistentContext: async () => ({
        pages: () => [], newPage: async () => ({ bringToFront: async () => {}, goto: async () => {} }),
        close: async () => { closed = true; },
      }) },
    });
  } catch (e) { error = e; }
  has(error.message, 'window was closed'); ok(closed);
});

await test('BALANCE TRIGGER #1: starting to type refreshes ALL accounts live (debounced)', async () => {
  const { pool, ids, store } = mkPool();
  mock.hits.balance.length = 0;
  const p = pool.onTyping();
  ok(p, 'refresh started');
  eq(pool.onTyping(), null, 'debounced while busy / within gap');
  await p;
  eq(mock.hits.balance.sort(), ['A', 'B', 'C']);
  eq(store.get(ids.B).tokens, 900); eq(store.get(ids.C).tokens, 0);
  ok(store.get(ids.A).tokensCheckedAt);
  eq(pool.stats.typingRefreshes, 1);
  await new Promise((r) => setTimeout(r, 70));
  await pool.onTyping();
  eq(pool.stats.typingRefreshes, 2, 'after the gap it refreshes again');
});

await test('balance events are emitted for the status bar', async () => {
  const { pool } = mkPool();
  const seen = [];
  pool.on('balance', (s) => seen.push(s));
  await pool.refreshAll();
  ok(seen.length >= 2); const last = seen.at(-1);
  eq(last.total, 1400); eq(last.count, 3); eq(last.usable, 2);
});

await test('pick: richest account first, empty/dead/locked skipped, preferred honoured', async () => {
  const { pool, store, ids } = mkPool();
  await pool.refreshAll();
  eq(pool.pick({}).id, ids.B);
  eq(pool.pick({ preferredId: ids.A }).id, ids.A);
  store.update(ids.B, (a) => { a.lockedModels = ['claude-opus-5-5']; });
  eq(pool.pick({ model: 'claude-opus-5-5' }).id, ids.A, 'B is locked for opus');
  eq(pool.pick({ model: 'claude-sonnet-5' }).id, ids.B);
  store.update(ids.A, (a) => { a.dead = true; });
  eq(pool.pick({ model: 'claude-opus-5-5' }), null);
  eq(pool.rotationQueue({ startId: ids.A, model: 'claude-sonnet-5' }).map((a) => a.id), [ids.B]);
});

await test('dead session (not login) marks the account dead and keeps lastKnownTokens', async () => {
  const store = new AccountStore({ file: path.join(tmp, 'dead.json') });
  const a = store.add({ id: 'dd', name: 'ghost', email: 'g@x.io', cookies: [cookie('NOPE')] });
  store.update('dd', (x) => { x.tokens = 77; });
  const pool = new Pool({ store });
  const r = await pool.refreshBalance('dd');
  eq(r.ok, false); eq(r.reason, 'not-login');
  ok(store.get('dd').dead); eq(store.get('dd').lastKnownTokens, 77); eq(store.get('dd').tokens, 0);
});

await test('RUN: one request, answer arrives, BALANCE TRIGGER #2 fires right after', async () => {
  const { pool, ids, store } = mkPool(['A', 'B']);
  await pool.refreshAll();
  accountsDef.B.spend = 40;
  const runner = new Runner({ pool, getSettings: () => ({ model: 'claude-opus-5-5' }) });
  const chunks = [];
  runner.on('chunk', (c) => chunks.push(c.delta));
  mock.hits.balance.length = 0; mock.hits.ask.length = 0;
  const r = await runner.ask({ text: 'сделай мне красиво' });
  await runner.settle();
  ok(r.ok); has(r.content, 'ответ от b@x.io'); eq(r.accountId, ids.B);
  eq(mock.hits.ask.length, 1, 'exactly ONE ask request');
  ok(mock.hits.balance.includes('B'), 'balance of the used account refreshed after the request');
  eq(store.get(ids.B).tokens, 860, 'new balance persisted (900-40)');
  eq(pool.stats.afterRequestRefreshes, 1);
  ok(chunks.join('').includes('Готово'));
  eq(mock.hits.ask[0].payload.type, 'ai_chat');
  eq(mock.hits.ask[0].payload.ai_chat_enable_search, true);
  delete accountsDef.B.spend;
});

await test('SEAMLESS HANDOFF: credits die mid-answer -> next live account continues in same project', async () => {
  const { pool, ids } = mkPool(['A', 'B']);
  accountsDef.B.tokens = 900; accountsDef.A.tokens = 500; accountsDef.B.mode = 'exhaust';
  await pool.refreshAll();
  const runner = new Runner({ pool, getSettings: () => ({ model: 'claude-opus-5-5' }) });
  const accEv = [];
  runner.on('account', (a) => accEv.push(a));
  mock.hits.ask.length = 0;
  let r;
  try { r = await runner.ask({ text: 'длинная задача' }); } finally { accountsDef.B.mode = undefined; accountsDef.B.tokens = 900; }
  await runner.settle();
  ok(r.ok); eq(r.handoffs, 1); eq(r.accountId, ids.A);
  has(r.content, 'Сделал первую часть'); has(r.content, 'ответ от a@x.io');
  ok(!/отрицательн/.test(r.content), 'credit notice never leaks to the user');
  eq(mock.hits.ask.length, 2);
  eq(mock.hits.ask[1].payload.project_id, 'proj-1', 'continues in the SAME project');
  has(mock.hits.ask[1].payload.user_s_input, 'Продолжай');
  ok(accEv.some((a) => a.handoff));
  ok(mock.hits.share >= 1, 'project was shared for the next account');
});

await test('no usable account -> clear error; all models locked -> model-locked', async () => {
  const store = new AccountStore({ file: path.join(tmp, 'empty.json') });
  const runner = new Runner({ pool: new Pool({ store }) });
  let e1; try { await runner.ask({ text: 'x' }); } catch (e) { e1 = e; }
  eq(e1.code, 'no-account');
  const { pool, store: s2, ids } = mkPool(['A']);
  s2.update(ids.A, (a) => { a.lockedModels = ['claude-opus-5-5']; a.modelAccessCheckedAt = new Date().toISOString(); });
  accountsDef.A.locked = ['claude-opus-5-5'];
  const r2 = new Runner({ pool, getSettings: () => ({ model: 'claude-opus-5-5' }) });
  let e2; try { await r2.ask({ text: 'x' }); } catch (e) { e2 = e; }
  eq(e2.code, 'model-locked');
  delete accountsDef.A.locked;
});

await test('PREFLIGHT: doubtful cached balance is verified live and a better account is swapped in', async () => {
  const { pool, store, ids } = mkPool(['A', 'B']);
  // cache says A is rich, reality says 0
  accountsDef.A.tokens = 0; accountsDef.B.tokens = 300;
  store.update(ids.A, (a) => { a.tokens = 9999; a.tokensCheckedAt = new Date(Date.now() - 3600e3).toISOString(); });
  store.update(ids.B, (a) => { a.tokens = 10; a.tokensCheckedAt = new Date().toISOString(); });
  const runner = new Runner({ pool, getSettings: () => ({ model: 'claude-opus-5-5' }) });
  mock.hits.ask.length = 0;
  let r;
  try { r = await runner.ask({ text: 'hi' }); } finally { accountsDef.A.tokens = 500; accountsDef.B.tokens = 900; }
  await runner.settle();
  eq(r.accountId, ids.B, 'swapped to B before sending'); eq(mock.hits.ask.length, 1); eq(mock.hits.ask[0].sid, 'B');
});

await test('INBOX through the runner: typing during a run does NOT start a new request', async () => {
  const { pool } = mkPool(['B']);
  await pool.refreshAll();
  accountsDef.B.delay = 300;
  const sb = await createSandbox({ cwd: tmp, tunnel: false });
  const runner = new Runner({ pool, sandbox: sb, getSettings: () => ({ model: 'claude-opus-5-5' }) });
  mock.hits.ask.length = 0;
  const first = runner.send('первая задача');
  eq(first.kind, 'run');
  await new Promise((r) => setTimeout(r, 5));
  ok(runner.busy);
  const second = runner.send('и ещё вот это');
  eq(second.kind, 'inbox');
  eq(sb.pendingInbox(), 1);
  const g = await (await fetch(sb.localBase() + '/ls')).text();
  has(g, 'NEW MESSAGE FROM THE USER'); has(g, 'и ещё вот это');
  try { await first.promise; } finally { delete accountsDef.B.delay; }
  await runner.settle();
  eq(mock.hits.ask.length, 1, 'still ONE ask request');
  has(mock.hits.ask[0].payload.user_s_input, sb.helpUrl());
  has(mock.hits.ask[0].payload.user_s_input, '/agent/');
  await sb.stop();
});

await test('agent prompt points the model at the sandbox guide', () => {
  const p = buildAgentPrompt({ task: 'найди маму', helpUrl: 'https://x.trycloudflare.com/agent/T/help', cwd: '/Users/me/p', platform: 'darwin' });
  has(p, 'https://x.trycloudflare.com/agent/T/help'); has(p, 'найди маму'); has(p, 'macOS'); has(p, 'NEW MESSAGE FROM THE USER');
  eq(buildAgentPrompt({ task: 'x', helpUrl: '' }), 'x');
});

await test('stop() aborts the run and asks the server to abort', async () => {
  const { pool } = mkPool(['B']);
  await pool.refreshAll();
  accountsDef.B.delay = 400;
  const runner = new Runner({ pool, getSettings: () => ({ model: 'claude-opus-5-5' }) });
  const p = runner.ask({ text: 'long' });
  await new Promise((r) => setTimeout(r, 120));
  ok(runner.busy, 'run is in flight');
  ok(runner.stop());
  let r; try { r = await p; } finally { delete accountsDef.B.delay; }
  eq(r.aborted, true); ok(!runner.busy);
  await runner.settle();
});

await test('stripCreditNotice keeps real text sharing a line with the notice', () => {
  eq(stripCreditNotice('Сделал первую часть. Ваш баланс кредитов отрицательный. Этот запуск остановлен. Пожалуйста, пополните, чтобы продолжить.'), 'Сделал первую часть.');
  eq(stripCreditNotice('Только плашка. Your credit balance is negative.'), 'Только плашка.');
});

await test('claudehack folder import: reads accounts.json + Partitions/account_<id>/Cookies', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'claudehack-'));
  eq(looksLikeClaudehackDir(dir), false);
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'abc123', name: 'Work', email: 'work@x.io' }, { id: 'noprofile', name: 'Ghost' }] }));
  eq(looksLikeClaudehackDir(dir), true);
  const partDir = path.join(dir, 'Partitions', 'account_abc123', 'Network');
  fs.mkdirSync(partDir, { recursive: true });
  fs.writeFileSync(path.join(partDir, 'Cookies'), 'fake-sqlite-db');
  const found = listClaudehackAccounts(dir);
  eq(found.length, 1);
  eq(found[0], { id: 'abc123', name: 'Work', email: 'work@x.io', cookies: path.join(partDir, 'Cookies') });
});

await test('failure emits "failed" (never the reserved "error") and does not crash without listeners', async () => {
  const runner = new Runner({ pool: new Pool({ store: new AccountStore({ file: path.join(tmp, 'e2.json') }) }) });
  const seen = []; runner.on('failed', (e) => seen.push(e.code));
  let e; try { await runner.ask({ text: 'x' }); } catch (x) { e = x; }
  eq(e.code, 'no-account'); eq(seen, ['no-account']);
});

await mock.close();
