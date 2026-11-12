// bratcode sandbox: the user's computer as a GET-only agent API.
//   http://127.0.0.1:<port>/agent/<token>/help        (+ invisible https tunnel in front)
// One continuous `ai_chat` request can drive the whole machine through plain GET requests.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAgent } from './agent.js';
import * as ev from './events.js';
import { createBackups } from './backups.js';
import { createMacos, macCommands } from './macos.js';
import { Tunnel } from './tunnel.js';
import { HOME, SHOTS_DIR, DATA_DIR, ensureDirs } from '../paths.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm',
};
const mime = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

const expandHome = (t) => String(t).replace(/^~(?=$|\/)/, HOME);

export const newToken = () => crypto.randomBytes(18).toString('base64url');

/**
 * @param {object} o
 * @param {string} [o.cwd]       project folder; default for relative paths / exec cwd
 * @param {string} [o.token]
 * @param {number} [o.port]      0 = any free port
 * @param {boolean} [o.tunnel]   start invisible tunnel
 * @param {object} [o.telegram]  { commands, titles, sensitive } from src/telegram/agent.js
 * @param {Function} [o.confirm] async (cmd, params) => boolean   (Side B / demure approval)
 * @param {string} [o.stateDir]
 */
export async function createSandbox(o = {}) {
  ensureDirs();
  const cwd = path.resolve(expandHome(o.cwd || process.cwd()));
  const token = o.token || newToken();
  const stateDir = o.stateDir || path.join(DATA_DIR, 'sandbox');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const ROOT = path.parse(cwd).root; // '/' on unix

  // real paths: absolute | ~ | relative to project folder. Whole disk is reachable by design.
  function safe(rel = '') {
    let t = expandHome(String(rel === undefined || rel === null || rel === '' ? '.' : rel));
    if (!path.isAbsolute(t)) t = path.resolve(cwd, t);
    return path.resolve(t);
  }
  const relOf = (abs) => abs;

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  async function serveFile(req, res, abs, opts = {}) {
    let st;
    try { st = await fsp.stat(abs); } catch { res.writeHead(404); return res.end('Not found'); }
    if (st.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      if (fs.existsSync(idx)) { abs = idx; st = await fsp.stat(abs); } else { res.writeHead(404); return res.end('Directory (no index.html)'); }
    }
    res.writeHead(200, { 'Content-Type': opts.type || mime(abs), 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(abs).pipe(res);
  }

  function proxy(req, res, url) {
    const m = url.pathname.match(/^\/proxy\/(\d+)(\/.*)?$/);
    if (!m) { res.writeHead(404); return res.end('bad proxy url'); }
    const port = Number(m[1]);
    if (port === server.address()?.port) { res.writeHead(400); return res.end('loop'); }
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers['accept-encoding'];
    const pr = http.request({ host: '127.0.0.1', port, path: (m[2] || '/') + url.search, method: req.method, headers }, (r) => {
      const h = { ...r.headers }; delete h['x-frame-options']; delete h['content-security-policy'];
      res.writeHead(r.statusCode, h); r.pipe(res);
    });
    pr.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`port ${port} unreachable: ${e.message}`); });
    req.pipe(pr);
  }

  const backups = createBackups({ session: new Date().toISOString().replace(/[:.]/g, '-') });
  const mac = createMacos({ shotsDir: path.join(stateDir, 'shots') });
  const tg = o.telegram || {};

  const extra = {
    defaultCwd: cwd,
    protected: [HOME, ROOT, path.join(HOME, 'Desktop'), path.join(HOME, 'Documents'), path.join(HOME, 'Downloads'), DATA_DIR],
    commands: {
      ...macCommands(mac),
      ...(tg.commands || {}),
      undo: async (p) => {
        const n = Math.min(50, Math.max(1, Number(p.n) || 1));
        const r = await backups.undo(n);
        if (!r.length) return 'nothing to undo (no backed-up changes in this session)';
        return `UNDO: ${r.filter((x) => x.ok).length}/${r.length} reverted\n` + r.map((x) => `  #${x.id} ${x.path}: ${x.action}`).join('\n');
      },
      history: async (p) => {
        const l = backups.list(Math.min(100, Math.max(1, Number(p.n) || 20)));
        if (!l.length) return '(no backed-up changes yet)';
        return `HISTORY (newest first, undo reverts the top one):\n` + l.map((e) => `  #${e.id} ${new Date(e.t).toISOString().slice(11, 19)} ${e.op.padEnd(8)} ${e.path}${e.existed ? '' : '  (new)'}`).join('\n');
      },
    },
    titles: {
      ...(tg.titles || {}),
      osascript: (p) => 'osascript ' + String(p.script || '(b64)').slice(0, 80),
      open_app: (p) => 'open_app ' + (p.name || p.app || ''),
      notify: (p) => 'notify ' + (p.title || ''),
      undo: (p) => `undo ${p.n || 1}`,
    },
    sensitive: new Set([...(tg.sensitive || []), ...(o.sensitive || [])]),
    confirm: o.confirm,
    help: { telegram: !!tg.commands },
  };

  let agent = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('bratcode sandbox\n'); }
      if (url.pathname.startsWith('/agent') && agent) {
        if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
        return await agent(req, res, url);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found');
    } catch (e) {
      try { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('ERROR: ' + (e.message || e)); } catch { /* ignore */ }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port || 0, '127.0.0.1', resolve);
  });
  const boundPort = server.address().port;
  agent = createAgent({ ROOT, PORT: boundPort, safe, relOf, token, serveFile, proxy, readBody, stateDir, backups, extra });

  const tunnel = new Tunnel({ port: boundPort, bin: o.cloudflared, log: true });
  if (o.tunnel !== false) tunnel.start();

  const localBase = () => `http://127.0.0.1:${boundPort}/agent/${token}`;
  const publicBase = () => (tunnel.url ? `${tunnel.url}/agent/${token}` : '');

  return {
    token, port: boundPort, cwd, server, tunnel, backups, events: ev,
    localBase, publicBase,
    helpUrl: () => `${publicBase() || localBase()}/help`,
    // wait until the tunnel is up (or give up) -> URL for ai_chat
    async ready(ms = 20000) {
      if (tunnel.status === 'up' || tunnel.status === 'off' || tunnel.status === 'missing') return this.helpUrl();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        tunnel.on('status', (s) => { if (s.status === 'up') { clearTimeout(t); resolve(); } });
      });
      return this.helpUrl();
    },
    // a prompt typed while the agent works: delivered in the answer to its next GET
    pushMessage: (text) => ev.userMessage(text),
    pendingInbox: () => ev.state.inbox.length,
    pause: (v) => ev.setPaused(v),
    killAll: () => ev.killAll(),
    async stop() {
      tunnel.stop();
      try { agent.closeBrowser(); } catch { /* ignore */ }
      await new Promise((r) => server.close(r));
    },
  };
}
