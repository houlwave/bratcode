// Fetch through Chromium's network stack and the account's browser session.
// Do not use Playwright APIRequestContext: it is a separate HTTP client. Bridge
// the page's ReadableStream incrementally, with backpressure, not response.text().
import { randomUUID } from 'node:crypto';

const bridges = new WeakMap();
const managedHeader = /^(?:cookie|host|origin|referer|user-agent|content-length|accept-encoding|connection|transfer-encoding|sec-.*)$/i;

export function browserHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !managedHeader.test(key)));
}

async function bridgeFor(page) {
  let bridge = bridges.get(page);
  if (!bridge) {
    const pending = new Map();
    const name = '__bratcodeFetch_' + randomUUID().replaceAll('-', '');
    const ready = page.exposeBinding(name, (source, event) => {
      if (source.frame !== page.mainFrame()) return;
      return pending.has(event.id) ? pending.get(event.id)(event) : false;
    });
    bridge = { pending, name, ready };
    bridges.set(page, bridge);
  }
  await bridge.ready;
  return bridge;
}

export async function browserFetch(page, url, { method = 'GET', headers = {}, body, signal } = {}) {
  signal?.throwIfAborted();
  // Never send an account's authenticated request through an unrelated page.
  if (new URL(page.url()).origin !== new URL(url).origin) {
    throw Object.assign(new Error('Account browser is not on the Genspark origin. Sign in via /accounts.'), { code: 'browser-session-unavailable' });
  }
  const { pending, name } = await bridgeFor(page);
  signal?.throwIfAborted();
  const id = randomUUID();
  const controllerKey = name + '_controllers';
  return new Promise((resolve, reject) => {
    let controller, ended = false, delivered = false, resume;
    const release = () => { resume?.(); resume = null; };
    const cleanup = () => { pending.delete(id); signal?.removeEventListener('abort', onAbort); release(); };
    const fail = (err) => {
      if (ended) return;
      ended = true; cleanup();
      controller?.error(err);
      if (!delivered) reject(err);
    };
    const abortPage = () => page.evaluate(({ key, id }) => {
      const controllers = window[key] ||= new Map();
      const ctl = controllers.get(id) || new AbortController();
      controllers.set(id, ctl); ctl.abort();
    }, { key: controllerKey, id }).catch(() => {});
    const onAbort = () => { fail(signal.reason || new DOMException('Aborted', 'AbortError')); void abortPage(); };
    pending.set(id, async (event) => {
      if (ended) return;
      if (event.kind === 'headers') {
        const stream = new ReadableStream({
          start(c) { controller = c; },
          pull() { release(); },
          cancel() { ended = true; cleanup(); void abortPage(); },
        });
        const noBody = method === 'HEAD' || [204, 205, 304].includes(event.status);
        const response = new Response(noBody ? null : stream, { status: event.status, headers: event.headers });
        Object.defineProperty(response, 'url', { value: event.url });
        delivered = true; resolve(response);
      } else if (event.kind === 'chunk') {
        controller.enqueue(new Uint8Array(Buffer.from(event.data, 'base64')));
        if (controller.desiredSize <= 0) await new Promise((r) => { resume = r; });
      } else if (event.kind === 'end') {
        ended = true; controller.close(); cleanup();
      } else if (event.kind === 'error') {
        fail(new Error('Chromium request failed: ' + event.message));
      }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    page.evaluate(async ({ name, key, id, url, method, headers, body }) => {
      const controllers = window[key] ||= new Map();
      const ctl = controllers.get(id) || new AbortController(); controllers.set(id, ctl);
      const emit = async (event) => {
        if (await window[name]({ ...event, id }) === false) ctl.abort();
        ctl.signal.throwIfAborted();
      };
      try {
        const response = await fetch(url, { method, headers, body, credentials: 'same-origin', signal: ctl.signal, redirect: 'follow' });
        await emit({ kind: 'headers', status: response.status, url: response.url, headers: [...response.headers] });
        const reader = response.body?.getReader();
        if (reader) for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (let start = 0; start < value.length; start += 32768) {
            const data = btoa(String.fromCharCode(...value.subarray(start, start + 32768)));
            await emit({ kind: 'chunk', data });
          }
        }
        await emit({ kind: 'end' });
      } catch (e) {
        await window[name]({ kind: 'error', id, message: String(e.message || e) });
      } finally { controllers.delete(id); }
    }, { name, key: controllerKey, id, url, method, headers: browserHeaders(headers), body }).catch(fail);
  });
}
