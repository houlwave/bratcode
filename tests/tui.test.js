import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, eq, ok, has } from './helpers.js';
import { startMock } from './mock-genspark.js';
import { fakeClient } from './fake-tg.js';
import { setOrigin } from '../src/pool/config.js';
import { AccountStore } from '../src/pool/accounts.js';
import { TgService } from '../src/telegram/client.js';
import { createBrain } from '../src/brain.js';
import { App } from '../src/app.js';
import { qrHalfBlocks, qrMatrix } from '../src/telegram/qr.js';

console.log('tui');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tui-'));
const accountsDef = { A: { email: 'a@x.io', tokens: 700 }, B: { email: 'b@x.io', tokens: 300 } };
const mock = await startMock(accountsDef);
const prevOrigin = process.env.BRATCODE_ORIGIN;
setOrigin(mock.origin);

const store = new AccountStore({ file: path.join(tmp, 'acc.json') });
for (const k of ['A', 'B']) store.add({ id: 'id' + k, name: 'acc' + k, email: accountsDef[k].email, cookies: [{ name: 'gs_session', value: k, domain: '127.0.0.1', path: '/', expires: Date.now() / 1000 + 3600 }] });

const tgFile = path.join(tmp, 'tg.json');
const svc = new TgService({ file: tgFile, factory: () => fakeClient() });
const proj = fs.mkdtempSync(path.join(tmp, 'proj-'));
const brain = await createBrain({
  cwd: proj, store, tgService: svc, recaptcha: false, tunnel: false,
  settings: () => ({ model: 'claude-opus-5-5' }),
  poolOptions: { typingGapMs: 20 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(15); } };

let t = 0;
const mk = (o = {}) => {
  const app = new App({ out: null, cols: 110, rows: 40, truecolor: true, cwd: proj, clock: () => t, brain, anim: false, ...o });
  app.dir = '~/proj'; app.branch = 'main';
  return app;
};
const screenText = (app) => { app.draw(); const s = app.screen; const rows = []; for (let y = 0; y < s.h; y++) rows.push(s.ch.slice(y * s.w, (y + 1) * s.w).join('').replace(/\0/g, '')); return rows.join('\n'); };
const type = (app, text) => { for (const ch of text) app.key({ name: 'char', text: ch }); };

await test('QR: half-blocks are a square matrix with a quiet zone, 2 rows per text row', () => {
  const m = qrMatrix('tg://login?token=abc');
  const lines = qrHalfBlocks('tg://login?token=abc', { border: 2 });
  eq(lines.length, Math.ceil((m.length + 4) / 2));
  ok(lines.every((l) => Array.from(l).length === m.length + 4));
  ok(/^[█ ▀▄]+$/.test(lines.join('')));
  eq(lines[0], '█'.repeat(m.length + 4), 'top quiet zone is solid light');
});

await test('status line: tunnel, tg and balance are on the bottom row', () => {
  const app = mk();
  const txt = screenText(app);
  has(txt, '~/proj:main'); has(txt, 'local'); has(txt, 'tg off'); has(txt, 'cr');
});

await test('BALANCE TRIGGER #1: starting to type refreshes balances (once per gap)', async () => {
  const app = mk();
  mock.hits.balance.length = 0;
  const before = brain.pool.stats.typingRefreshes;
  type(app, 'h');
  await brain.pool.refreshAll().catch(() => {}); // let the wave land
  await waitFor(() => brain.pool.stats.typingRefreshes > before);
  ok(mock.hits.balance.length >= 2, 'both accounts were asked');
  const n = brain.pool.stats.typingRefreshes;
  brain.pool.typingGapMs = 60000;
  type(app, 'ello');
  eq(brain.pool.stats.typingRefreshes, n, 'no spam while typing the same prompt');
  brain.pool.typingGapMs = 20;
  await sleep(40);
  type(app, '!');
  ok(brain.pool.stats.typingRefreshes > n, 'next gap -> refreshes again');
  await waitFor(() => brain.pool.refreshing === 0);
});

await test('RUN in the TUI: one prompt = one request, text streams, BALANCE TRIGGER #2 after it', async () => {
  const app = mk();
  mock.hits.ask.length = 0;
  accountsDef.A.spend = 25;
  type(app, 'сделай красиво'); app.key({ name: 'enter' });
  eq(app.messages.length, 2); ok(app.liveBot, 'live bot attached'); eq(app.view, 'chat');
  await waitFor(() => !app.busy);
  await brain.runner.settle();
  const bot = app.messages[1];
  has(bot.text, 'ответ от a@x.io'); ok(!bot.error, bot.error);
  eq(mock.hits.ask.length, 1);
  has(mock.hits.ask[0].payload.user_s_input, 'сделай красиво');
  has(mock.hits.ask[0].payload.user_s_input, '/agent/');
  eq(store.get('idA').tokens, 675, 'balance refreshed right after the request');
  has(screenText(app), 'ответ от a@x.io');
  delete accountsDef.A.spend;
});

await test('INBOX in the TUI: typing during a run goes to the SAME run (+ line, no new track, no new request)', async () => {
  const app = mk();
  accountsDef.A.delay = 350;
  mock.hits.ask.length = 0;
  type(app, 'первая'); app.key({ name: 'enter' });
  await sleep(30);
  ok(app.brain.runner.busy);
  type(app, 'и ещё вот это'); app.key({ name: 'enter' });
  const inbox = app.messages.find((m) => m.inbox);
  ok(inbox, 'inbox message shown'); eq(app.trackNo, 2, 'inbox does not take a track number');
  eq(brain.sandbox.pendingInbox(), 1);
  const g = await (await fetch(brain.sandbox.localBase() + '/ls')).text();
  has(g, 'NEW MESSAGE FROM THE USER'); has(g, 'и ещё вот это');
  has(screenText(app), '+ и ещё вот это');
  await waitFor(() => !app.busy);
  delete accountsDef.A.delay;
  await brain.runner.settle();
  eq(mock.hits.ask.length, 1, 'still ONE request');
});

await test('SANDBOX STEPS appear under the track while the agent works on the computer', async () => {
  const app = mk();
  accountsDef.A.delay = 400;
  type(app, 'посмотри папку'); app.key({ name: 'enter' });
  await sleep(30);
  await fetch(brain.sandbox.localBase() + '/exec?cmd=' + encodeURIComponent('echo hi'));
  const bot = app.messages[1];
  ok(bot.steps.some((s) => /echo hi/.test(s.label)), 'exec step recorded');
  const txt = screenText(app);
  has(txt, '$ echo hi');
  await waitFor(() => !app.busy);
  delete accountsDef.A.delay;
  await brain.runner.settle();
  ok(bot.steps.every((s) => s.status !== 'running'));
  has(screenText(app), '\u2713');
});

await test('SIDE B (demure) asks before tg_send; enter allows, esc denies. SIDE A just does it', async () => {
  fs.writeFileSync(tgFile, JSON.stringify({ session: 'S' }));
  const app = mk();
  const send = (text) => fetch(brain.sandbox.localBase() + '/tg_send?chat=1&text=' + encodeURIComponent(text)).then((r) => r.text());
  // side a: no card
  const a = await send('привет a');
  has(a, 'OK sent'); eq(app.cards.length, 0);
  // side b
  app.key({ name: 'tab' });
  eq(app.modeKey, 'demure');
  const p1 = send('привет b');
  await waitFor(() => app.cards.length === 1);
  const txt = screenText(app);
  has(txt, 'sure?'); has(txt, 'send a telegram message'); has(txt, 'привет b');
  app.key({ name: 'enter' });
  has(await p1, 'OK sent');
  const p2 = send('нет');
  await waitFor(() => app.cards.length === 1);
  app.key({ name: 'escape' });
  const denied = await p2;
  has(denied, 'DENIED');
  eq(app.cards.length, 0);
});

await test('/tg: QR overlay renders a scannable code, 2FA password is asked, then linked', async () => {
  fs.rmSync(tgFile, { force: true });
  const app = mk();
  app.run('tg');
  ok(app.overlay);
  await waitFor(() => app.overlay.qr);
  // the fake client asks for the 2FA password at once; a real one only after the scan -> draw the qr phase explicitly
  const realPhase = app.overlay.phase;
  app.overlay.phase = 'qr';
  const txt = screenText(app);
  app.overlay.phase = realPhase;
  has(txt, 'telegram'); has(txt, 'link desktop device'); ok(/[█▀▄]{8,}/.test(txt), 'qr blocks on screen');
  await waitFor(() => app.overlay.phase === 'password');
  has(screenText(app), 'two-step password');
  for (const ch of 'secret') app.key({ name: 'char', text: ch });
  has(screenText(app), '\u2022\u2022\u2022\u2022\u2022\u2022');
  app.key({ name: 'enter' });
  await waitFor(() => app.overlay.phase === 'linked');
  ok(fs.existsSync(tgFile)); eq(app.tg.linked, true);
  has(screenText(app), 'linked:');
  app.key({ name: 'escape' });
  eq(app.overlay, null);
  has(screenText(app), 'tg');
});

await test('/accounts: list with balances, pin with enter, remove needs d twice', async () => {
  const app = mk();
  await brain.pool.refreshAll();
  app.run('accounts');
  const txt = screenText(app);
  has(txt, 'accounts'); has(txt, 'accA'); has(txt, 'accB'); has(txt, 'a@x.io');
  app.key({ name: 'down' });
  app.key({ name: 'char', text: 'd' });
  eq(store.list().length, 2, 'first d only arms');
  has(screenText(app), 'press d again');
  app.key({ name: 'up' });
  eq(store.list().length, 2);
  app.key({ name: 'escape' });
  eq(app.overlay, null);
});

await test('/model overlay lists the catalog and escape closes it', () => {
  const app = mk();
  app.run('model');
  has(screenText(app), 'model');
  app.key({ name: 'escape' });
  eq(app.overlay, null);
});

await test('demo mode (no brain): live commands are hidden, stub reply still works', () => {
  const app = new App({ out: null, cols: 100, rows: 30, truecolor: true, clock: () => t, anim: false });
  ok(!app.cmds().some((c) => c.id === 'tg'));
  type(app, 'hi'); app.key({ name: 'enter' });
  ok(app.messages.length === 2 && !app.messages[1].live);
});

await test('esc during a live run stops it and the status says stopped', async () => {
  const app = mk();
  accountsDef.A.delay = 500;
  type(app, 'долго'); app.key({ name: 'enter' });
  await sleep(40);
  ok(app.busy);
  app.key({ name: 'escape' });
  ok(!app.busy); ok(app.messages[1].stopped);
  has(screenText(app), 'stopped.');
  delete accountsDef.A.delay;
  await waitFor(() => !brain.runner.busy);
  await brain.runner.settle();
  ok(!brain.runner.busy);
});

await test('no accounts: a clear error under the track, nothing crashes', async () => {
  const empty = new AccountStore({ file: path.join(tmp, 'none.json') });
  const b2 = await createBrain({ cwd: proj, store: empty, tgService: svc, recaptcha: false, tunnel: false, settings: () => ({ model: 'claude-opus-5-5' }) });
  const app = new App({ out: null, cols: 100, rows: 30, truecolor: true, clock: () => t, brain: b2, anim: false });
  type(app, 'привет'); app.key({ name: 'enter' });
  await waitFor(() => !app.busy);
  has(app.messages[1].error, 'no usable account');
  has(screenText(app), 'no usable account');
  await b2.close();
});

await brain.close();
await mock.close();
fs.rmSync(tgFile, { force: true });
if (prevOrigin) process.env.BRATCODE_ORIGIN = prevOrigin;
