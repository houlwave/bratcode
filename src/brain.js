// The brain: wires pool + runner + sandbox + telegram + recaptcha into one object the TUI talks to.
// Everything here is invisible to the user: no servers, tunnels or browsers to start by hand.
import { AccountStore } from './pool/accounts.js';
import { Pool } from './pool/pool.js';
import { Runner } from './pool/runner.js';
import { Recaptcha } from './pool/recaptcha.js';
import { resolveModelId } from './pool/models.js';
import { createSandbox } from './sandbox/server.js';
import { createTelegramAgent } from './telegram/agent.js';
import { TgService } from './telegram/client.js';
import { readSettings } from './paths.js';

const PREMINT_GAP_MS = 3000;

/**
 * @param {object} o
 * @param {string} [o.cwd]
 * @param {AccountStore} [o.store]
 * @param {TgService} [o.tgService]   injectable for tests
 * @param {boolean} [o.recaptcha]     false = never open the invisible browser
 * @param {boolean} [o.tunnel]        false = local-only sandbox
 * @param {Function} [o.settings]     () => ({ model, preferredAccountId })
 * @param {object} [o.poolOptions]
 */
export async function createBrain(o = {}) {
  const store = o.store || new AccountStore();
  const pool = new Pool({ store, ...(o.poolOptions || {}) });
  const recaptcha = o.recaptcha === false ? null : new Recaptcha({ store });
  const tg = createTelegramAgent(o.tgService || new TgService());
  const getSettings = o.settings || readSettings;
  const brain = { store, pool, recaptcha, tg, onConfirm: null, sandbox: null, runner: null };

  // Side B (demure) asks before sensitive actions; the UI plugs its approval card in here.
  const sandbox = await createSandbox({
    cwd: o.cwd || process.cwd(),
    tunnel: o.tunnel,
    telegram: tg,
    confirm: (cmd, params) => (brain.onConfirm ? brain.onConfirm(cmd, params) : true),
  });
  const runner = new Runner({ pool, recaptcha, sandbox, getSettings });
  brain.sandbox = sandbox;
  brain.runner = runner;

  let lastPremint = 0;
  /** balance trigger #1 (the user started typing) + warm up the invisible captcha token for the likely account */
  brain.onTyping = () => {
    pool.onTyping();
    const now = Date.now();
    if (!recaptcha || now - lastPremint < PREMINT_GAP_MS) return;
    lastPremint = now;
    try {
      const s = getSettings() || {};
      const acc = pool.pick({ model: resolveModelId(s.model), preferredId: s.preferredAccountId || '' });
      if (acc) recaptcha.premint(acc.id);
    } catch { /* never break typing */ }
  };

  /** background balance check at launch, so the status line is true from the first frame */
  brain.warm = () => (store.list().length ? pool.refreshAll().catch(() => []) : Promise.resolve([]));

  brain.close = async () => {
    try { if (runner.busy) runner.stop(); } catch { /* ignore */ }
    await Promise.allSettled([
      runner.settle(),
      tg.service.close(),
      sandbox.stop(),
      recaptcha ? recaptcha.close() : null,
    ]);
  };
  return brain;
}
