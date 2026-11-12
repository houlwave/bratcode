// Invisible HTTPS tunnel (cloudflared quick tunnel) with auto-reconnect.
// The user never sees it: stdout/stderr are swallowed, status is exposed via events.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { BIN_DIR, LOGS_DIR, enrichedPath } from '../paths.js';

export function findCloudflared() {
  if (process.env.CLOUDFLARED_PATH && fs.existsSync(process.env.CLOUDFLARED_PATH)) return process.env.CLOUDFLARED_PATH;
  const local = path.join(BIN_DIR, 'cloudflared');
  if (fs.existsSync(local)) return local;
  for (const dir of enrichedPath().split(':')) {
    const p = path.join(dir, 'cloudflared');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  try { return execFileSync('which', ['cloudflared'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

// status: 'off' | 'starting' | 'up' | 'down' | 'missing'
export class Tunnel extends EventEmitter {
  constructor({ port, bin, retryMs = 3000, maxRetryMs = 30000, log = true } = {}) {
    super();
    this.port = port;
    this.bin = bin === undefined ? findCloudflared() : bin;
    this.retryMs = retryMs;
    this.maxRetryMs = maxRetryMs;
    this.status = 'off';
    this.url = process.env.BRATCODE_TUNNEL_URL || '';
    this.child = null;
    this.stopped = false;
    this.attempt = 0;
    this.logFile = log ? path.join(LOGS_DIR, 'tunnel.log') : null;
  }

  _set(status, url) {
    const changed = status !== this.status || (url !== undefined && url !== this.url);
    this.status = status;
    if (url !== undefined) this.url = url;
    if (changed) this.emit('status', { status: this.status, url: this.url });
  }

  start() {
    this.stopped = false;
    if (process.env.BRATCODE_TUNNEL_URL) { this._set('up', process.env.BRATCODE_TUNNEL_URL); return this; }
    if (process.env.BRATCODE_NO_TUNNEL === '1') { this._set('off', ''); return this; }
    if (!this.bin) { this._set('missing', ''); return this; }
    this._spawn();
    return this;
  }

  _spawn() {
    if (this.stopped) return;
    this._set('starting', '');
    let c;
    try {
      c = spawn(this.bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: enrichedPath() },
      });
    } catch (e) { this._set('missing', ''); return; }
    this.child = c;
    let logFd = null;
    if (this.logFile) { try { logFd = fs.openSync(this.logFile, 'a', 0o600); } catch { logFd = null; } }
    let buf = '';
    const onData = (d) => {
      const s = String(d);
      if (logFd !== null) { try { fs.writeSync(logFd, s); } catch { /* ignore */ } }
      buf = (buf + s).slice(-4000);
      const m = buf.match(URL_RE);
      if (m && this.status !== 'up') { this.attempt = 0; this._set('up', m[0]); }
    };
    c.stdout.on('data', onData);
    c.stderr.on('data', onData);
    c.on('error', () => { /* handled by close */ });
    c.on('close', () => {
      if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* ignore */ } }
      if (this.child === c) this.child = null;
      if (this.stopped) { this._set('off', ''); return; }
      this._set('down', '');
      this.attempt++;
      const wait = Math.min(this.maxRetryMs, this.retryMs * Math.pow(1.6, Math.min(this.attempt, 8)));
      this._timer = setTimeout(() => this._spawn(), wait);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._timer);
    if (this.child) { try { this.child.kill('SIGTERM'); } catch { /* ignore */ } }
    this._set('off', '');
  }
}
