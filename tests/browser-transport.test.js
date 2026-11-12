import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { test, eq, ok, has } from './helpers.js';
import { browserFetch, browserHeaders } from '../src/pool/browser-fetch.js';
import { AccountStore } from '../src/pool/accounts.js';
import { Recaptcha } from '../src/pool/recaptcha.js';
import { askStream, buildPayload } from '../src/pool/ask.js';
import { gsRequest } from '../src/pool/net.js';
import { Pool } from '../src/pool/pool.js';
import { Runner } from '../src/pool/runner.js';
import { findBrowserExecutable } from '../src/paths.js';
import * as cfg from '../src/pool/config.js';
import { createBrain } from '../src/brain.js';

console.log('browser transport');
const waitFor = async (fn, ms = 10000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('condition timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

await test('browser headers: Chromium owns UA, cookie, origin and client hints', () => {
  eq(browserHeaders({ 'user-agent': 'fake', Cookie: 'secret', Origin: 'https://fake', Referer: 'fake', Host: 'fake', 'Content-Length': '1', 'sec-fetch-site': 'same-origin', 'sec-ch-ua': 'fake', accept: 'text/event-stream', 'content-type': 'application/json', traceparent: 'trace' }), {
    accept: 'text/event-stream', 'content-type': 'application/json', traceparent: 'trace',
  });
});

await test('High matches claudehack ai_chat payload (not reasoning_effort on code_sandbox)', () => {
  const payload = buildPayload({ userInput: 'hello', model: 'claude-opus-5-5' });
  eq(payload.type, 'ai_chat'); eq(payload.ai_chat_model, 'claude-opus-5-5');
  eq(payload.ai_chat_enable_search, true); eq(payload.session_state.messages, payload.messages);
  ok(!('reasoning_effort' in payload)); ok(!('use_model' in payload));
});

await test('unavailable Chromium fails explicitly, without sending via Node or trying other accounts', async () => {
  const store = new AccountStore({ file: path.join(process.env.BRATCODE_DATA, 'no-browser.json') });
  for (const id of ['no-browser-A', 'no-browser-B']) {
    store.add({ id, name: id });
    store.update(id, (a) => { a.tokens = 100; a.tokensCheckedAt = new Date().toISOString(); });
  }
  const session = new Recaptcha({ store, findExecutable: () => undefined });
  store.setTransport((id, url, opts) => session.fetch(id, url, opts));
  let nodeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { nodeCalls++; throw new Error('must not fall back to Node'); };
  const runner = new Runner({ pool: new Pool({ store }), recaptcha: session });
  try {
    let error;
    try { await runner.ask({ text: 'hi' }); } catch (e) { error = e; }
    await runner.settle();
    eq(error.code, 'browser-session-unavailable'); eq(nodeCalls, 0); eq(runner.history, []);
    has(error.message, 'install Chrome');
  } finally { globalThis.fetch = originalFetch; await session.close(); }
});

const executable = findBrowserExecutable({ headed: true }) || findBrowserExecutable();
if (!executable) {
  if (process.env.BRATCODE_REQUIRE_BROWSER_TESTS === '1') throw new Error('Chromium required for browser transport integration tests');
  console.log('    skipped Chromium integration: set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH (BRATCODE_REQUIRE_BROWSER_TESTS=1 makes it mandatory)');
} else {
  const oldOrigin = cfg.ORIGIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-browser-'));
  const hits = [], closed = [], gates = new Map();
  let mode = 'ok';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const sid = /gs_session=([^;]+)/.exec(req.headers.cookie || '')?.[1] || 'anonymous';
    const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><script src="/recaptcha/api.js?render=6' + 'x'.repeat(40) + '"></script></html>');
    }
    if (url.pathname === '/recaptcha/api.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end('window.grecaptcha={enterprise:{ready:fn=>fn(),execute:()=>fetch("/token").then(r=>r.text())}}');
    }
    if (url.pathname === '/token') return res.end('token-' + sid);
    if (url.pathname === '/api/payment/get_credit_balance') return json({ status: 0, data: { balance: 100 } });
    if (url.pathname === '/api/quota/member_benefits') return json({ status: 0, ai_chat: { flagship_locked: false, member_only_locked: false } });
    if (url.pathname === '/api/agent/ask_abort') return json({ status: 0 });
    if (url.pathname === '/api/probe') {
      res.setHeader('set-cookie', 'refreshed=browser; Path=/; HttpOnly');
      return json({ sid, ua: req.headers['user-agent'] });
    }
    if (url.pathname === '/api/redirect') { res.writeHead(302, { location: '/?fromurl=credit_exhausted' }); return res.end(); }
    if (url.pathname === '/api/slow') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first'); return; }
    if (url.pathname === '/api/delayed-headers') return;
    if (url.pathname !== cfg.ASK_PATH) { res.writeHead(404); return res.end(); }
    const parts = []; for await (const part of req) parts.push(part);
    const payload = JSON.parse(Buffer.concat(parts).toString());
    hits.push({ sid, payload, headers: req.headers });
    res.on('close', () => { closed.push(payload.user_s_input); gates.delete(payload.user_s_input); });
    if (mode === 'challenge') {
      res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
      return res.end('<html><script>window._cf_chl_opt={}</script></html>');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const ev = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    ev({ type: 'project_start', id: 'browser-proj' });
    ev({ type: 'message_start', message_id: 'browser-message', role: 'assistant' });
    const chunk = Buffer.from('data: ' + JSON.stringify({ type: 'message_field_delta', message_id: 'browser-message', field_name: 'content', delta: 'Привет от ' + sid }) + '\n\n');
    const split = chunk.indexOf(Buffer.from('Привет')) + 1;
    res.write(chunk.subarray(0, split)); res.write(chunk.subarray(split));
    const finish = () => { ev({ type: 'project_field', id: 'browser-proj', field_name: 'status', field_value: 'FINISHED' }); res.end(); };
    if (mode === 'hold') gates.set(payload.user_s_input, finish); else finish();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cfg.setOrigin('http://127.0.0.1:' + server.address().port);
  const store = new AccountStore({ file: path.join(dir, 'accounts.json') });
  const cookie = (id) => ({ name: 'gs_session', value: id, domain: '127.0.0.1', path: '/', httpOnly: true });
  for (const id of ['browser-A', 'browser-B']) store.add({ id, name: id, cookies: [cookie(id)] });
  const cachedJar = store.jar('browser-A');
  const session = new Recaptcha({ store, findExecutable: () => executable });
  store.setTransport((id, url, opts) => session.fetch(id, url, opts));
  try {
    await test('Chromium sends one authenticated POST, streams before EOF, and shares the captcha session', async () => {
      mode = 'hold';
      const token = await session.getFreshToken('ask', 'browser-A');
      eq(token, 'token-browser-A');
      const originalFetch = globalThis.fetch;
      let nodeCalls = 0, done = false;
      globalThis.fetch = () => { nodeCalls++; throw new Error('unexpected Node fetch'); };
      const chunks = [];
      let stream;
      try {
        const before = hits.length;
        stream = askStream(cachedJar, { userInput: 'stream-before-EOF', recaptchaToken: token }, { onDelta: (d) => chunks.push(d.delta) });
        stream.promise.finally(() => { done = true; }).catch(() => {});
        await waitFor(() => chunks.length > 0);
        eq(done, false); has(chunks.join(''), 'Привет от browser-A');
        eq(hits.length - before, 1); eq(hits.at(-1).payload.g_recaptcha_token, token);
        gates.get('stream-before-EOF')();
        const result = await stream.promise;
        eq(result.content, 'Привет от browser-A'); ok(result.finished); eq(nodeCalls, 0);
        ok(!hits.at(-1).headers['user-agent'].includes('Chrome/130.0.0.0'));
        has(hits.at(-1).headers['user-agent'], 'Chrome/');
      } finally { globalThis.fetch = originalFetch; gates.get('stream-before-EOF')?.(); stream?.abort(); mode = 'ok'; }
    });

    await test('parallel warmup/probes use one context per account and preserve HttpOnly cookies', async () => {
      const [a, b, page1, page2] = await Promise.all([
        gsRequest(store.jar('browser-A'), { path: '/api/probe' }),
        gsRequest(store.jar('browser-B'), { path: '/api/probe' }),
        session._page('browser-B'), session._page('browser-B'),
      ]);
      eq(a.json.sid, 'browser-A'); eq(b.json.sid, 'browser-B'); eq(page1 === page2, true);
      eq(session.ctxs.size, 2);
      ok(store.jar('browser-A').list.some((c) => c.name === 'refreshed' && c.httpOnly));
      eq(fs.statSync(store.jar('browser-A').file).mode & 0o777, 0o600);
    });

    await test('reimport/sign-in replaces a live context session and invalidates its old preminted token', async () => {
      await waitFor(() => !session.minted.get('browser-A')?.pending);
      store.jar('browser-A').replaceAll([cookie('new-sign-in')]);
      // Token retrieval is deliberately first, before any request syncs cookies.
      const token = await session.getFreshToken('ask', 'browser-A');
      eq(token, 'token-new-sign-in');
      const probe = await gsRequest(store.jar('browser-A'), { path: '/api/probe' });
      eq(probe.json.sid, 'new-sign-in');
    });

    await test('Escape aborts the Chromium reader after headers and closes the server connection', async () => {
      mode = 'hold';
      const chunks = [];
      const stream = askStream(store.jar('browser-B'), { userInput: 'abort-reader' }, { onDelta: (d) => chunks.push(d) });
      stream.promise.catch(() => {});
      await waitFor(() => chunks.length > 0);
      stream.abort();
      const result = await stream.promise;
      eq(result.aborted, true);
      await waitFor(() => closed.includes('abort-reader'));
      mode = 'ok';
    });

    await test('timeout and pre-abort work both before headers and during a Chromium stream', async () => {
      for (const route of ['/api/slow', '/api/delayed-headers']) {
        let error;
        try { await gsRequest(store.jar('browser-B'), { path: route, timeoutMs: 150 }); } catch (e) { error = e; }
        ok(error, route + ' should time out');
      }
      const ctl = new AbortController(); ctl.abort();
      let error;
      try { await gsRequest(store.jar('browser-B'), { path: '/api/probe', signal: ctl.signal }); } catch (e) { error = e; }
      eq(error.name, 'AbortError');
    });

    await test('credit redirect is still recognized through Chromium automatic redirects', async () => {
      const result = await gsRequest(store.jar('browser-B'), { path: '/api/redirect', stream: true });
      eq(result.creditRedirect, true); eq(result.status, 402);
    });

    await test('Chromium challenges remain explicit errors and are not silently retried via Node', async () => {
      mode = 'challenge';
      const pool = new Pool({ store });
      await pool.refreshAll();
      const runner = new Runner({ pool, recaptcha: session });
      const before = hits.length;
      let error;
      try { await runner.ask({ text: 'challenge-in-browser' }); } catch (e) { error = e; }
      await runner.settle();
      eq(error.code, 'cloudflare-challenge'); eq(hits.length - before, 1); eq(runner.history, []);
      mode = 'ok';
    });

    await test('default brain wiring sends balance and chat via Chromium, not the Node client', async () => {
      const brainStore = new AccountStore({ file: path.join(dir, 'brain.json') });
      brainStore.add({ id: 'brain-browser', cookies: [cookie('brain-browser')] });
      const brain = await createBrain({ store: brainStore, cwd: dir, tunnel: false });
      const originalFetch = globalThis.fetch;
      let nodeCalls = 0;
      globalThis.fetch = () => { nodeCalls++; throw new Error('default brain used Node fetch'); };
      try {
        await brain.warm();
        eq(brainStore.get('brain-browser').tokens, 100);
        const before = hits.length;
        const result = await brain.runner.ask({ text: 'default brain' });
        await brain.runner.settle();
        eq(result.content, 'Привет от brain-browser'); eq(nodeCalls, 0); eq(hits.length - before, 1);
        eq(hits.at(-1).payload.g_recaptcha_token, 'token-brain-browser');
      } finally { globalThis.fetch = originalFetch; await brain.close(); }
    });

    await test('browser bridge refuses a page on a different origin', async () => {
      const page = await session._page('browser-A');
      let error;
      try { await browserFetch(page, 'https://example.invalid/api'); } catch (e) { error = e; }
      eq(error.code, 'browser-session-unavailable');
    });
  } finally {
    mode = 'ok';
    for (const finish of gates.values()) finish();
    await session.close();
    cfg.setOrigin(oldOrigin);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
