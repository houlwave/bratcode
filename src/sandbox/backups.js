// Automatic backups before every file mutation + /undo.
// Journal lives in ~/.bratcode-data/backups/<session>/journal.json, blobs next to it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BACKUPS_DIR } from '../paths.js';

const MAX_ENTRIES = 500;
const MAX_FILE = 50 * 1024 * 1024; // do not copy files bigger than this

export function createBackups({ dir, session } = {}) {
  const root = path.join(dir || BACKUPS_DIR, session || String(Date.now()));
  const blobs = path.join(root, 'blobs');
  const journalFile = path.join(root, 'journal.json');
  fs.mkdirSync(blobs, { recursive: true, mode: 0o700 });

  let journal = [];
  try { journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')); } catch { journal = []; }
  let seq = journal.reduce((m, e) => Math.max(m, e.id), 0);

  const persist = () => {
    try { fs.writeFileSync(journalFile, JSON.stringify(journal.slice(-MAX_ENTRIES), null, 1), { mode: 0o600 }); } catch { /* ignore */ }
  };

  // snapshot `abs` (file, dir or missing path) BEFORE the agent changes it
  async function save(abs, op = 'write') {
    const id = ++seq;
    let st = null;
    try { st = await fsp.lstat(abs); } catch { st = null; }
    const entry = { id, t: Date.now(), op, path: abs, existed: !!st, kind: st ? (st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file') : null };
    if (st) {
      const dest = path.join(blobs, String(id));
      try {
        if (entry.kind === 'file') {
          if (st.size > MAX_FILE) { entry.skipped = 'too big'; }
          else await fsp.copyFile(abs, dest);
        } else if (entry.kind === 'dir') {
          await fsp.cp(abs, dest, { recursive: true, dereference: false });
        } else if (entry.kind === 'link') {
          entry.link = await fsp.readlink(abs);
        }
      } catch (e) { entry.skipped = String(e.message || e).slice(0, 100); }
    }
    journal.push(entry);
    if (journal.length > MAX_ENTRIES) {
      const old = journal.splice(0, journal.length - MAX_ENTRIES);
      for (const o of old) fsp.rm(path.join(blobs, String(o.id)), { recursive: true, force: true }).catch(() => {});
    }
    persist();
    return entry;
  }

  const list = (n = 20) => journal.slice(-n).reverse();

  // revert last n entries (newest first). Entries with `skipped` cannot be restored.
  async function undo(n = 1) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const e = journal.pop();
      if (!e) break;
      try {
        const blob = path.join(blobs, String(e.id));
        if (!e.existed) {
          await fsp.rm(e.path, { recursive: true, force: true });
          out.push({ ok: true, id: e.id, path: e.path, action: 'removed (it did not exist before)' });
        } else if (e.skipped) {
          out.push({ ok: false, id: e.id, path: e.path, action: `cannot restore (${e.skipped})` });
        } else if (e.kind === 'link') {
          await fsp.rm(e.path, { recursive: true, force: true });
          await fsp.symlink(e.link, e.path);
          out.push({ ok: true, id: e.id, path: e.path, action: 'symlink restored' });
        } else {
          await fsp.rm(e.path, { recursive: true, force: true });
          await fsp.mkdir(path.dirname(e.path), { recursive: true });
          if (e.kind === 'dir') await fsp.cp(blob, e.path, { recursive: true });
          else await fsp.copyFile(blob, e.path);
          out.push({ ok: true, id: e.id, path: e.path, action: 'restored' });
        }
        fsp.rm(blob, { recursive: true, force: true }).catch(() => {});
      } catch (err) {
        out.push({ ok: false, id: e.id, path: e.path, action: 'error: ' + (err.message || err) });
      }
    }
    persist();
    return out;
  }

  return { save, list, undo, size: () => journal.length, root };
}
