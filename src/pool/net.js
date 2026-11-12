// HTTP to Genspark with a per-account cookie jar. Plain fetch (Node 18+), no electron.
import * as cfg from './config.js';

export class GsError extends Error {
  constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); }
}

/** One request. `path` is relative to ORIGIN or an absolute URL. Cookies are sent and absorbed. */
export async function gsRequest(jar, { method = 'GET', path, headers = {}, body = null, timeoutMs = 60000, signal, stream = false } = {}) {
  const url = /^https?:/i.test(path) ? path : cfg.ORIGIN + path;
  const h = { ...cfg.defaultHeaders(), ...headers };
  if (body == null) delete h['content-type'];
  const cookie = jar ? jar.header(url) : '';
  if (cookie) h.cookie = cookie;

  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener?.('abort', onAbort);
  const timer = timeoutMs > 0 ? setTimeout(() => ctl.abort(new Error('timeout ' + timeoutMs + 'ms: ' + url)), timeoutMs) : null;
  try {
    let res = await fetch(url, { method, headers: h, body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), signal: ctl.signal, redirect: 'manual' });
    // follow redirects manually so Set-Cookie of every hop is kept; remember the final url (credit_exhausted shows up there)
    let hops = 0; let finalUrl = url;
    while (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops++ < 5) {
      jar?.absorb(finalUrl, res);
      finalUrl = new URL(res.headers.get('location'), finalUrl).toString();
      if (/credit_exhausted/i.test(finalUrl)) return { status: 402, url: finalUrl, text: finalUrl, json: null, headers: res.headers, creditRedirect: true };
      const c2 = jar ? jar.header(finalUrl) : '';
      res = await fetch(finalUrl, { method: res.status === 307 || res.status === 308 ? method : 'GET', headers: { ...h, ...(c2 ? { cookie: c2 } : {}) }, body: res.status === 307 || res.status === 308 ? (body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))) : undefined, signal: ctl.signal, redirect: 'manual' });
    }
    jar?.absorb(finalUrl, res);
    if (stream) return { status: res.status, url: finalUrl, res, headers: res.headers, timer, ctl };
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, url: finalUrl, text, json, headers: res.headers };
  } finally {
    if (!stream && timer) clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

export const gsJson = (jar, path, opts = {}) => gsRequest(jar, { ...opts, path, headers: { accept: 'application/json, text/plain, */*', ...(opts.headers || {}) } });

export const isNotLogin = (json) => !!json && (Number(json.status) === -5 || String(json.message || '').toLowerCase() === 'not login');
