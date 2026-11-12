// Platform & storage paths for bratcode (macOS-first, Linux/Windows fallback).
// All persistent state lives in ~/.bratcode-data so updating ~/.bratcode never touches sessions/accounts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_MAC = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';
export const HOME = os.homedir();

export const DATA_DIR = path.resolve(process.env.BRATCODE_DATA || path.join(HOME, '.bratcode-data'));
export const PARTITIONS_DIR = path.join(DATA_DIR, 'partitions');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const SHOTS_DIR = path.join(DATA_DIR, 'shots');
export const MEM_DIR = path.join(DATA_DIR, 'memory');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const BIN_DIR = path.join(DATA_DIR, 'bin');
export const BROWSERS_DIR = path.join(DATA_DIR, 'browsers');

export const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const TG_SESSION_FILE = path.join(DATA_DIR, 'telegram.json');
export const MODELS_CACHE_FILE = path.join(DATA_DIR, 'models-cache.json');

// claudehack (the Electron Genspark account manager) keeps its own accounts.json
// + one Chromium partition per account under this folder by default on macOS.
export const DEFAULT_CLAUDEHACK_DIR = IS_MAC ? path.join(HOME, 'Library', 'Application Support', 'claudehack') : '';

export function ensureDirs() {
  for (const d of [DATA_DIR, PARTITIONS_DIR, LOGS_DIR, SHOTS_DIR, MEM_DIR, BACKUPS_DIR, BIN_DIR, BROWSERS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch {}
  }
}

export function enrichedPath(basePath = process.env.PATH || '') {
  const extra = [
    BIN_DIR,
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, '.bun', 'bin'),
    path.join(HOME, '.pyenv', 'shims'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const parts = String(basePath).split(':').filter(Boolean);
  for (const p of extra) {
    if (!parts.includes(p)) parts.push(p);
  }
  return parts.join(':');
}

export function findBrowserExecutable({ headed = false, exists = fs.existsSync, readDir = fs.readdirSync, env = process.env } = {}) {
  const usable = (file) => (!headed || !/headless[_-]shell/i.test(file)) && exists(file);
  if (env.CHROMIUM_PATH && usable(env.CHROMIUM_PATH)) return env.CHROMIUM_PATH;

  const pwRoots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    BROWSERS_DIR,
    path.join(HOME, 'Library', 'Caches', 'ms-playwright'),
    path.join(HOME, '.cache', 'ms-playwright'),
    path.join(HOME, '.pw-browsers'),
    '/home/user/.pw-browsers',
    '/ms-playwright',
  ].filter(Boolean);

  for (const root of pwRoots) {
    let dirs = [];
    try { dirs = readDir(root).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      const cands = [
        path.join(root, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
        path.join(root, d, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
        path.join(root, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(root, d, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        path.join(root, d, 'chrome-linux64', 'chrome'),
        path.join(root, d, 'chrome-linux', 'headless_shell'),
        path.join(root, d, 'chrome-linux', 'chrome'),
      ];
      for (const c of cands) {
        if (usable(c)) return c;
      }
    }
  }

  const sys = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  for (const s of sys) {
    if (usable(s)) return s;
  }
  return undefined;
}

export function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data, mode = 0o600) {
  ensureDirs();
  const tmp = `${file}.tmp.${process.pid}`;
  const raw = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tmp, raw, { encoding: 'utf8', mode });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.writeFileSync(file, raw, { encoding: 'utf8', mode }); } catch {}
  }
}

export function readSettings() {
  const def = {
    model: 'claude-opus-5-5',
    preferredAccountId: '',
    claudehackDir: '',
  };
  const s = readJsonSafe(SETTINGS_FILE, {});
  return { ...def, ...(s && typeof s === 'object' ? s : {}) };
}

export function saveSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) };
  writeJsonAtomic(SETTINGS_FILE, next);
  return next;
}
