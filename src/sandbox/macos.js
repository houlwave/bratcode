// macOS control commands for the sandbox: sysinfo, osascript, screen, clipboard, open_app, open, notify.
// Everything degrades gracefully on Linux (used by tests): commands return a clear "macOS only" note.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { IS_MAC, SHOTS_DIR, HOME, enrichedPath } from '../paths.js';

const run = (cmd, args, { ms = 20000, input, env } = {}) => new Promise((resolve) => {
  const c = execFile(cmd, args, { timeout: ms, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: enrichedPath(), ...(env || {}) } }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
  });
  if (input !== undefined) { try { c.stdin.end(input); } catch { /* ignore */ } }
});

const b64 = (s) => Buffer.from(String(s).replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const val = (p, k) => (p[k + '_b64'] !== undefined ? b64(p[k + '_b64']) : p[k]);
const expand = (t) => String(t || '').replace(/^~(?=$|\/)/, HOME);
const E = (msg, http = 400) => Object.assign(new Error(msg), { http });

const macOnly = (what) => `${what} is available only on macOS (this host: ${process.platform}).`;

export function createMacos({ shotsDir = SHOTS_DIR } = {}) {
  fs.mkdirSync(shotsDir, { recursive: true });

  async function sysinfo() {
    const lines = [];
    lines.push(`OS:       ${IS_MAC ? 'macOS' : os.type()} ${os.release()} (${os.arch()})`);
    lines.push(`host:     ${os.hostname()}   user: ${os.userInfo().username}`);
    lines.push(`CPU:      ${os.cpus()[0]?.model || '?'} x${os.cpus().length}`);
    lines.push(`RAM:      ${(os.freemem() / 1e9).toFixed(1)} GB free of ${(os.totalmem() / 1e9).toFixed(1)} GB`);
    lines.push(`uptime:   ${Math.round(os.uptime() / 3600)} h`);
    lines.push(`home:     ${HOME}`);
    lines.push(`node:     ${process.version}`);
    const df = await run('df', ['-h', '/']);
    if (df.ok) lines.push('disk:     ' + (df.stdout.trim().split('\n')[1] || '').replace(/\s+/g, ' '));
    if (IS_MAC) {
      const batt = await run('pmset', ['-g', 'batt']);
      if (batt.ok) lines.push('battery:  ' + (batt.stdout.split('\n').find((l) => /%/.test(l)) || '').trim());
      const front = await run('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { ms: 5000 });
      if (front.ok) lines.push('frontmost app: ' + front.stdout.trim());
      const ver = await run('sw_vers', ['-productVersion']);
      if (ver.ok) lines[0] = `OS:       macOS ${ver.stdout.trim()} (${os.arch()})`;
    }
    lines.push(`cwd:      ${process.cwd()}`);
    return lines.join('\n');
  }

  async function osascript(p) {
    if (!IS_MAC) return { text: macOnly('osascript'), ok: false };
    const script = val(p, 'script') ?? val(p, 'code') ?? val(p, 'src');
    if (!script) throw E('missing "script" (or script_b64): e.g. osascript?script=tell%20application%20%22Music%22%20to%20playpause');
    const lang = /^(js|javascript|jxa)$/i.test(p.lang || '') ? 'JavaScript' : 'AppleScript';
    const t = Math.min(120, Math.max(1, Number(p.timeout) || 30)) * 1000;
    const r = await run('osascript', ['-l', lang, '-'], { input: script, ms: t });
    const out = (r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '')).trim();
    if (!r.ok) {
      const hint = /not allowed|not authorized|-1743|-1744|assistive/i.test(out)
        ? '\nHINT: macOS blocked the automation. Ask the user to allow it: System Settings -> Privacy & Security -> Automation (and Accessibility) -> enable the terminal app.'
        : '';
      return { ok: false, text: `ERROR: osascript failed (${r.code})\n${out}${hint}` };
    }
    return { ok: true, text: out || '(no output)' };
  }

  async function screen(p) {
    if (!IS_MAC) return { text: macOnly('screen'), ok: false };
    const name = `scr${Date.now()}.png`;
    const file = path.join(shotsDir, name);
    const args = ['-x', '-t', 'png'];
    if (p.display) args.push('-D', String(Number(p.display) || 1));
    args.push(file);
    const r = await run('screencapture', args, { ms: 15000 });
    if (!r.ok || !fs.existsSync(file)) {
      return { ok: false, text: `ERROR: screencapture failed. Ask the user to allow Screen Recording for the terminal: System Settings -> Privacy & Security -> Screen Recording.\n${r.stderr}` };
    }
    // shrink for the model if sips is available (retina screens are huge)
    const small = path.join(shotsDir, name.replace('.png', '.s.png'));
    const sp = await run('sips', ['--resampleWidth', String(Math.min(1600, Number(p.w) || 1440)), file, '--out', small], { ms: 15000 });
    const use = sp.ok && fs.existsSync(small) ? path.basename(small) : name;
    return { ok: true, shot: use, text: `OK screenshot saved: ${path.join(shotsDir, use)}\nSEE IT: {BASE}/shots/${use}\nTip: {BASE}/view?src=${use} describes it (palette, shapes, text map).` };
  }

  async function clipboard(p) {
    if (!IS_MAC) return { text: macOnly('clipboard'), ok: false };
    const text = val(p, 'text');
    if (text !== undefined) {
      await new Promise((resolve) => { const c = spawn('pbcopy'); c.on('close', resolve); c.on('error', resolve); c.stdin.end(String(text)); });
      return { ok: true, text: `OK ${String(text).length} chars copied to the clipboard` };
    }
    const r = await run('pbpaste', []);
    return { ok: r.ok, text: r.ok ? (r.stdout.length > 60000 ? r.stdout.slice(0, 60000) + '\n...[cut]' : r.stdout || '(clipboard is empty)') : 'ERROR: ' + r.stderr };
  }

  async function open_app(p) {
    if (!IS_MAC) return { text: macOnly('open_app'), ok: false };
    const name = p.name || p.app;
    if (!name) throw E('missing "name" (open_app?name=Safari[&url=https://...])');
    const args = ['-a', String(name)];
    if (p.url) args.push(String(p.url));
    const r = await run('open', args);
    return { ok: r.ok, text: r.ok ? `OK launched ${name}${p.url ? ' with ' + p.url : ''}` : `ERROR: ${r.stderr.trim() || 'could not open ' + name}` };
  }

  async function open(p) {
    const target = p.target || p.url || p.path;
    if (!target) throw E('missing "target" (open?target=~/Desktop/a.pdf or a URL)');
    const t = /^[a-z]+:\/\//i.test(target) ? target : expand(target);
    if (!IS_MAC) return { text: macOnly('open'), ok: false };
    const r = await run('open', [t]);
    return { ok: r.ok, text: r.ok ? `OK opened ${t}` : `ERROR: ${r.stderr.trim()}` };
  }

  async function notify(p) {
    if (!IS_MAC) return { text: macOnly('notify'), ok: false };
    const title = String(p.title || 'bratcode').replace(/["\\]/g, ' ');
    const text = String(val(p, 'text') ?? p.message ?? '').replace(/["\\]/g, ' ');
    const r = await run('osascript', ['-e', `display notification "${text}" with title "${title}"`]);
    return { ok: r.ok, text: r.ok ? 'OK notification shown' : 'ERROR: ' + r.stderr };
  }

  return { sysinfo, osascript, screen, clipboard, open_app, open, notify };
}

export function macCommands(mac) {
  return {
    sysinfo: async () => mac.sysinfo(),
    osascript: (p) => mac.osascript(p),
    screen: async (p, ctx) => { const r = await mac.screen(p); return { ...r, text: String(r.text).replace(/\{BASE\}/g, ctx.base) }; },
    clipboard: (p) => mac.clipboard(p),
    open_app: (p) => mac.open_app(p),
    open: (p) => mac.open(p),
    notify: (p) => mac.notify(p),
  };
}
