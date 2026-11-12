// Account store: ~/.bratcode-data/accounts.json (0600) + one cookie jar per account in partitions/account_<id>/.
// Same record shape as claudehack (tokens, tokensCheckedAt, dead, lockedModels, modelAccessCheckedAt) so profiles are portable.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ACCOUNTS_FILE, readJsonSafe, writeJsonAtomic } from '../paths.js';
import { CookieJar, partitionDir } from './jar.js';
import path from 'node:path';

export const isAccountAvailable = (a) => {
  if (!a || a.dead) return false;
  if (a.tokens === null || typeof a.tokens === 'undefined') return true; // unknown yet -> try
  return Number(a.tokens) > 0;
};

export class AccountStore {
  constructor({ file = ACCOUNTS_FILE } = {}) {
    this.file = file;
    this.jars = new Map();
  }

  read() {
    const j = readJsonSafe(this.file, { accounts: [] });
    if (!j || !Array.isArray(j.accounts)) return { accounts: [] };
    return j;
  }
  write(db) { writeJsonAtomic(this.file, db, 0o600); try { fs.chmodSync(this.file, 0o600); } catch { /* ignore */ } }

  list() { return this.read().accounts; }
  get(id) { return this.list().find((a) => a.id === id) || null; }

  update(id, fn) {
    const db = this.read();
    const a = db.accounts.find((x) => x.id === id);
    if (!a) return null;
    fn(a);
    this.write(db);
    return a;
  }

  add({ name, email = '', cookies = [], id } = {}) {
    const db = this.read();
    const acc = {
      id: id || crypto.randomBytes(6).toString('hex'),
      name: name || email.split('@')[0] || 'account',
      email,
      createdAt: new Date().toISOString(),
      lastLaunch: null,
      tokens: null,
      tokensCheckedAt: null,
    };
    if (db.accounts.some((a) => a.id === acc.id)) return db.accounts.find((a) => a.id === acc.id);
    db.accounts.push(acc);
    this.write(db);
    if (cookies.length) this.jar(acc.id).replaceAll(cookies);
    return acc;
  }

  remove(id) {
    const db = this.read();
    db.accounts = db.accounts.filter((a) => a.id !== id);
    this.write(db);
    this.jars.delete(id);
    try { fs.rmSync(partitionDir(id), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Transport is attached to jars, including jars already cached before startup.
  // Tests/import probes can keep plain HTTP; the live brain uses Chromium.
  setTransport(fetchForAccount) {
    this.fetchForAccount = fetchForAccount;
    for (const [id, jar] of this.jars) this._attachTransport(id, jar);
  }

  _attachTransport(id, jar) {
    if (this.fetchForAccount) jar.fetch = (url, opts) => this.fetchForAccount(id, url, opts);
    else delete jar.fetch;
  }

  jar(id) {
    let j = this.jars.get(id);
    if (!j) {
      j = new CookieJar(path.join(partitionDir(id), 'cookies.json'));
      this._attachTransport(id, j);
      this.jars.set(id, j);
    }
    return j;
  }
}
