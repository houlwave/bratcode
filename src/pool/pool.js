// Account pool: live balances, model access, selection and rotation order.
// Two mandatory balance triggers (see PLAN §4):
//   1) onTyping()          - the user starts typing a prompt -> refresh all usable accounts in waves
//   2) afterRequest(id)    - a request finished              -> refresh the account that served it
import { EventEmitter } from 'node:events';
import { AccountStore, isAccountAvailable } from './accounts.js';
import { fetchBalance, fetchModelAccess, fetchUserInfo } from './balance.js';
import * as modelAccess from './model-access.js';
import { MIN_USABLE_TOKENS } from './config.js';

export const BALANCE_WAVE = 5;
export const MODEL_ACCESS_FRESH_MS = 45 * 1000;

const tokensOf = (a) => (a.tokens === null || typeof a.tokens === 'undefined' ? -1 : Number(a.tokens));

export class Pool extends EventEmitter {
  constructor({ store = new AccountStore(), typingGapMs = 8000, probes = {} } = {}) {
    super();
    this.store = store;
    this.typingGapMs = typingGapMs;
    this.lastTypingRefresh = 0;
    this.refreshing = 0;
    this.activeId = '';
    this.log = [];
    // injectable for tests
    this.fetchBalance = probes.fetchBalance || fetchBalance;
    this.fetchModelAccess = probes.fetchModelAccess || fetchModelAccess;
    this.fetchUserInfo = probes.fetchUserInfo || fetchUserInfo;
    this.stats = { balanceCalls: 0, typingRefreshes: 0, afterRequestRefreshes: 0 };
  }

  dev(level, text) { this.log.push({ t: Date.now(), level, text }); if (this.log.length > 200) this.log.shift(); this.emit('dev', { level, text }); }

  // ---- views -------------------------------------------------------------
  usableFor(a, model) { return !!a && isAccountAvailable(a) && !(model && modelAccess.isModelLockedFor(a, model)); }

  summary() {
    const accounts = this.store.list();
    const usable = accounts.filter((a) => isAccountAvailable(a));
    const known = accounts.filter((a) => a.tokens !== null && typeof a.tokens !== 'undefined');
    const total = known.reduce((s, a) => s + (a.dead ? 0 : Math.max(0, Number(a.tokens) || 0)), 0);
    const active = accounts.find((a) => a.id === this.activeId) || null;
    return {
      count: accounts.length,
      usable: usable.length,
      total,
      active: active ? { id: active.id, name: active.name, tokens: active.tokens } : null,
      refreshing: this.refreshing > 0,
      checkedAt: accounts.reduce((m, a) => Math.max(m, a.tokensCheckedAt ? Date.parse(a.tokensCheckedAt) : 0), 0),
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, email: a.email || '', tokens: a.tokens ?? null, dead: !!a.dead, locked: (a.lockedModels || []).length, checkedAt: a.tokensCheckedAt || null })),
    };
  }
  changed() { this.emit('balance', this.summary()); }

  // ---- live probes -------------------------------------------------------
  /** Live balance of one account; persists to accounts.json and emits 'balance'. */
  async refreshBalance(id, { access = true } = {}) {
    const acc = this.store.get(id);
    if (!acc) return { ok: false, tokens: null, reason: 'no-account' };
    const jar = this.store.jar(id);
    this.refreshing++; this.emit('balance', this.summary());
    try {
      this.stats.balanceCalls++;
      const accessP = access ? Promise.resolve().then(() => this.fetchModelAccess(jar, 12000)).catch(() => null) : Promise.resolve(null);
      let res;
      try { res = await this.fetchBalance(jar, 12000); } catch (e) { res = { ok: false, reason: (e && e.message) || 'request-error' }; }
      const acs = await accessP;
      if (acs && acs.ok) this.store.update(id, (a) => { modelAccess.applyModelAccess(a, acs); });

      if (!res || !res.ok) {
        if (res && res.dead) {
          this.store.update(id, (a) => {
            if (a.tokens !== null && typeof a.tokens !== 'undefined') a.lastKnownTokens = a.tokens;
            a.tokens = 0; a.dead = true; a.loggedOutAt = a.loggedOutAt || new Date().toISOString(); a.tokensCheckedAt = new Date().toISOString();
          });
        }
        return { ok: false, tokens: null, reason: (res && res.reason) || 'balance-failed' };
      }
      const tokens = Number(res.tokens);
      this.store.update(id, (a) => {
        a.tokens = tokens; a.tokensCheckedAt = new Date().toISOString();
        if (a.dead) { a.dead = false; delete a.loggedOutAt; delete a.lastKnownTokens; }
      });
      if (!Number.isFinite(tokens) || tokens < MIN_USABLE_TOKENS) return { ok: false, tokens, reason: 'no-credits' };
      return { ok: true, tokens };
    } finally {
      this.refreshing--; this.changed();
    }
  }

  /** Refresh many accounts: waves of BALANCE_WAVE in parallel. */
  async refreshAll({ ids, access = true } = {}) {
    const list = (ids ? ids.map((i) => this.store.get(i)).filter(Boolean) : this.store.list().filter((a) => !a.dead || true))
      .sort((a, b) => tokensOf(b) - tokensOf(a));
    const out = [];
    for (let i = 0; i < list.length; i += BALANCE_WAVE) {
      const wave = list.slice(i, i + BALANCE_WAVE);
      const rs = await Promise.all(wave.map(async (a) => ({ id: a.id, ...(await this.refreshBalance(a.id, { access })) })));
      out.push(...rs);
    }
    this.changed();
    return out;
  }

  // ---- the two mandatory triggers ---------------------------------------
  /** (1) user began typing. Debounced so a long prompt does not spam the API. */
  onTyping() {
    const now = Date.now();
    if (now - this.lastTypingRefresh < this.typingGapMs) return null;
    if (this.refreshing > 0) return null;
    this.lastTypingRefresh = now;
    this.stats.typingRefreshes++;
    // dead accounts are skipped here - they are re-checked by /balance or login
    const ids = this.store.list().filter((a) => !a.dead).map((a) => a.id);
    if (!ids.length) return null;
    return this.refreshAll({ ids }).catch(() => []);
  }

  /** (2) a request finished (any outcome): refresh the account that was used. */
  afterRequest(id) {
    if (!id) return Promise.resolve(null);
    this.stats.afterRequestRefreshes++;
    return this.refreshBalance(id).catch(() => null);
  }

  // ---- selection ---------------------------------------------------------
  pick({ model, preferredId = '', excludeIds = [] } = {}) {
    const excl = new Set(excludeIds.filter(Boolean));
    const all = this.store.list();
    const cands = all.filter((a) => !excl.has(a.id) && this.usableFor(a, model));
    if (!cands.length) return null;
    if (preferredId) {
      const pref = cands.find((a) => a.id === preferredId);
      if (pref) return pref;
      const p = all.find((a) => a.id === preferredId);
      const prefLocked = !!p && !excl.has(p.id) && isAccountAvailable(p) && !this.usableFor(p, model);
      if (!prefLocked) return null;
    }
    return cands.slice().sort((a, b) => tokensOf(b) - tokensOf(a))[0];
  }

  rotationQueue({ startId, excludeIds = [], model } = {}) {
    const excl = new Set(excludeIds.filter(Boolean));
    const list = this.store.list().filter((a) => !excl.has(a.id) && this.usableFor(a, model));
    const rest = list.filter((a) => a.id !== startId).sort((a, b) => tokensOf(b) - tokensOf(a));
    const head = list.find((a) => a.id === startId);
    return (head ? [head] : []).concat(rest);
  }

  /** Like pick(), but a model locked on every account triggers a live re-check of stale lock lists. */
  async pickForModel({ model, preferredId = '', excludeIds = [] } = {}) {
    const first = this.pick({ model, preferredId, excludeIds });
    if (first || !model) return { acc: first, modelLocked: false };
    const excl = new Set(excludeIds.filter(Boolean));
    const lockedOnes = this.store.list().filter((a) => !excl.has(a.id) && isAccountAvailable(a) && modelAccess.isModelLockedFor(a, model));
    if (!lockedOnes.length) return { acc: null, modelLocked: false };
    const now = Date.now();
    const stale = lockedOnes.filter((a) => { const t = a.modelAccessCheckedAt ? Date.parse(a.modelAccessCheckedAt) : 0; return !t || now - t > MODEL_ACCESS_FRESH_MS; }).slice(0, 10);
    await Promise.all(stale.map(async (a) => { try { const r = await this.fetchModelAccess(this.store.jar(a.id), 12000); if (r && r.ok) this.store.update(a.id, (x) => { modelAccess.applyModelAccess(x, r); }); } catch { /* ignore */ } }));
    const again = this.pick({ model, preferredId, excludeIds });
    return { acc: again, modelLocked: !again };
  }

  /** Next account with a LIVE-confirmed positive balance (waves of 5, cache order preserved). */
  async findLive({ excludeIds = [], max = 12, model } = {}) {
    const excl = new Set(excludeIds);
    const cands = this.store.list().filter((a) => !excl.has(a.id) && this.usableFor(a, model)).sort((a, b) => tokensOf(b) - tokensOf(a)).slice(0, max);
    for (let i = 0; i < cands.length; i += BALANCE_WAVE) {
      const wave = cands.slice(i, i + BALANCE_WAVE);
      const checks = await Promise.all(wave.map(async (c) => ({ c, r: await this.refreshBalance(c.id) })));
      for (const { c, r } of checks) {
        if (!r.ok) { this.dev('warn', `account "${c.name}" skipped: ${r.reason}${r.tokens != null ? ` (${r.tokens})` : ''}`); continue; }
        const fresh = this.store.get(c.id) || c;
        if (model && modelAccess.isModelLockedFor(fresh, model)) { this.dev('warn', `account "${c.name}" skipped: ${model} is locked`); continue; }
        this.dev('info', `account "${c.name}" confirmed: ${r.tokens} credits`);
        return fresh;
      }
    }
    return null;
  }

  markExhausted(id) {
    this.store.update(id, (a) => { a.tokens = 0; a.tokensCheckedAt = new Date().toISOString(); });
    this.changed();
  }
  setActive(id) { this.activeId = id || ''; this.changed(); }
}
