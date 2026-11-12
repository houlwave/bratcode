// Per-account cookie jar persisted at ~/.bratcode-data/partitions/account_<id>/cookies.json (0600).
import fs from 'node:fs';
import path from 'node:path';
import { PARTITIONS_DIR } from '../paths.js';

export const partitionDir = (id) => path.join(PARTITIONS_DIR, `account_${id}`);

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const domainMatch = (host, dom) => { const d = String(dom || '').replace(/^\./, '').toLowerCase(); const h = host.toLowerCase(); return h === d || h.endsWith('.' + d); };

export class CookieJar {
  constructor(file) { this.file = file; this.list = []; this.load(); }

  load() {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.list = Array.isArray(j) ? j : (j.cookies || []); } catch { this.list = []; }
    this.prune();
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + '.tmp' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(this.list), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch { /* ignore */ }
  }
  prune() { const now = Date.now() / 1000; this.list = this.list.filter((c) => !(c.expires > 0 && c.expires < now)); }

  set(c) {
    if (!c || !c.name) return;
    const dom = String(c.domain || '').toLowerCase();
    const p = c.path || '/';
    this.list = this.list.filter((x) => !(x.name === c.name && String(x.domain || '').toLowerCase() === dom && (x.path || '/') === p));
    if (c.expires > 0 && c.expires < Date.now() / 1000) return; // deleted by server
    this.list.push({ name: c.name, value: c.value ?? '', domain: dom, path: p, expires: c.expires ?? -1, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite });
  }
  setAll(arr) { for (const c of arr || []) this.set(c); }
  replaceAll(arr) { this.list = []; this.setAll(arr); this.save(); }

  header(url) {
    this.prune();
    const host = hostOf(url);
    let pth = '/'; try { pth = new URL(url).pathname; } catch { /* ignore */ }
    const secure = /^https:/i.test(url);
    return this.list
      .filter((c) => domainMatch(host, c.domain) && pth.startsWith(c.path || '/') && (!c.secure || secure))
      .sort((a, b) => (b.path || '').length - (a.path || '').length)
      .map((c) => `${c.name}=${c.value}`).join('; ');
  }

  // absorb Set-Cookie headers from a fetch Response
  absorb(url, res) {
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (!sc.length) return false;
    const host = hostOf(url);
    for (const line of sc) {
      const parts = line.split(';').map((s) => s.trim());
      const eq = parts[0].indexOf('=');
      if (eq < 1) continue;
      const c = { name: parts[0].slice(0, eq), value: parts[0].slice(eq + 1), domain: host, path: '/', expires: -1, secure: false, httpOnly: false };
      for (const a of parts.slice(1)) {
        const [k, ...v] = a.split('=');
        const key = k.toLowerCase(); const val = v.join('=');
        if (key === 'domain') c.domain = val.toLowerCase();
        else if (key === 'path') c.path = val || '/';
        else if (key === 'expires') { const t = Date.parse(val); if (!Number.isNaN(t)) c.expires = t / 1000; }
        else if (key === 'max-age') { const n = Number(val); if (Number.isFinite(n)) c.expires = Date.now() / 1000 + n; }
        else if (key === 'secure') c.secure = true;
        else if (key === 'httponly') c.httpOnly = true;
      }
      this.set(c);
    }
    this.save();
    return true;
  }

  toPlaywright() {
    return this.list.map((c) => ({ name: c.name, value: c.value, domain: c.domain.startsWith('.') ? c.domain : (c.domain || '').replace(/^/, ''), path: c.path || '/', expires: c.expires > 0 ? c.expires : -1, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax' }));
  }
}
