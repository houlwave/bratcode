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
import { decryptChromiumCookie, deriveKey, listClaudehackAccounts, looksLikeClaudehackDir } from '../src/pool/login.js';
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
