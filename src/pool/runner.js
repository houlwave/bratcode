// Runner: one user prompt -> ONE continuous ai_chat request that drives the computer through the sandbox URL.
//  - picks an account with an open model + positive balance (live-verified when the cache is doubtful)
//  - seamless handoff to the next account when credits run out mid-answer (same project, "continue" prompt)
//  - text typed while the agent works goes to the sandbox inbox (NOT a new request)
//  - balance refresh trigger #2: right after every request
import { EventEmitter } from 'node:events';
import * as cfg from './config.js';
import { askStream, findFieldError, findForbiddenFields, shareProject, abortRun } from './ask.js';
import { resolveModelId, learnIds, parseModelId, compareVersion } from './models.js';
import { isAccountAvailable } from './accounts.js';
import { shiftSteps } from './tool-steps.js';

export const CONTINUE_PROMPT = 'Продолжай. Не говори о том что я попросил продолжить, просто делай дальше';
export const MAX_CONTINUATIONS = 12;
const PREFLIGHT_STALE_MS = 10 * 60 * 1000;

/** The text ai_chat receives. It must send the model to the sandbox URL and keep it working there. */
export function buildAgentPrompt({ task, helpUrl, cwd = '', platform = process.platform, continuing = false, carryTail = '' }) {
  const os = platform === 'darwin' ? 'macOS' : platform;
  if (!helpUrl) {
    // plain chat (no sandbox): a continuation must still be a continuation, never the task again from scratch
    return continuing ? `${CONTINUE_PROMPT}\n\n(task in progress: ${String(task).slice(0, 400)})${carryTail ? `\n\nYour last words before the interruption:\n${carryTail}` : ''}` : String(task);
  }
  const head = `You control the user's REAL computer (${os}${cwd ? ', project folder ' + cwd : ''}) with plain GET requests.
1. FIRST open this URL and read it fully: ${helpUrl}
2. Then do the task below ONLY by opening command URLs from that guide (read, write, edit, exec, grep, look, tg_*, osascript ...). Open one URL after another inside THIS single run; read every answer before the next step.
3. After every answer, if it ends with ">>> NEW MESSAGE FROM THE USER", that is a live instruction from the user: read it and follow it immediately.
4. Do not stop at a plan - perform the work, verify it (run / test / look), and finish with a short report for the user in the user's language.`;
  if (continuing) return `${CONTINUE_PROMPT}\n\n${head}\n\nTHE TASK (already in progress, do not restart from scratch - check the current state first, e.g. ${helpUrl.replace(/\/help.*$/, '')}/history):\n${task}${carryTail ? `\n\nYour last words before the interruption:\n${carryTail}` : ''}`;
  return `${head}\n\nTHE TASK:\n${task}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Runner extends EventEmitter {
  constructor({ pool, recaptcha = null, sandbox = null, getSettings = () => ({}), maxContinuations = MAX_CONTINUATIONS } = {}) {
    super();
    this.pool = pool; this.recaptcha = recaptcha; this.sandbox = sandbox; this.getSettings = getSettings;
    this.maxContinuations = maxContinuations;
    this.cur = null;
    this.pending = new Set(); // background balance refreshes
    this.history = [];
  }

  get busy() { return !!this.cur; }

  /** await all background work (balance refreshes) - used by tests and on quit */
  async settle() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  _bg(p) { if (!p) return; const q = Promise.resolve(p).catch(() => {}).finally(() => this.pending.delete(q)); this.pending.add(q); }

  /** user hit Enter. Idle -> start a run. Busy -> goes to the inbox of the current run. */
  send(text, opts = {}) {
    const t = String(text || '').trim();
    if (!t) return { kind: 'empty' };
    if (this.cur) {
      if (this.sandbox) this.sandbox.pushMessage(t);
      this.cur.extra.push(t);
      this.emit('inbox', { text: t });
      return { kind: 'inbox' };
    }
    const promise = this.ask({ text: t, ...opts });
    promise.catch(() => {});
    return { kind: 'run', promise };
  }

  stop() {
    const r = this.cur; if (!r) return false;
    r.aborted = true;
    try { r.abort?.(); } catch { /* ignore */ }
    if (r.projectId && r.accId) this._bg(abortRun(this.pool.store.jar(r.accId), { projectId: r.projectId, askId: r.askId }));
    try { this.sandbox?.killAll(); } catch { /* ignore */ }
    return true;
  }

  async ask({ text, model, preferredId = '', history = [] } = {}) {
    if (this.cur) throw new Error('a run is already active');
    const pool = this.pool;
    const settings = this.getSettings() || {};
    const wantModel = resolveModelId(model || settings.model);
    const run = { aborted: false, abort: null, projectId: null, askId: null, accId: '', extra: [], t0: Date.now() };
    this.cur = run;
    // the model needs the PUBLIC url of the sandbox: wait for the invisible tunnel (returns at once if it is up / off)
    if (this.sandbox && typeof this.sandbox.ready === 'function') { try { await this.sandbox.ready(); } catch { /* local url is the fallback */ } }
    const emit = (ev, d) => this.emit(ev, d);
    const dev = (l, t) => pool.dev(l, t);
    let acc = null;
    try {
      // ---- pick
      const pref = preferredId || settings.preferredAccountId || '';
      const picked = await pool.pickForModel({ model: wantModel, preferredId: pref });
      acc = picked.acc;
      if (!acc) {
        const err = new Error(picked.modelLocked ? `model ${wantModel} is locked on every account (limit window). Try another model: /model` : 'no usable account. Add one: /accounts');
        err.code = picked.modelLocked ? 'model-locked' : 'no-account';
        throw err;
      }
      // ---- preflight: doubtful cached balance -> ask live BEFORE sending
      {
        const cached = acc.tokens == null ? null : Number(acc.tokens);
        const checked = acc.tokensCheckedAt ? Date.parse(acc.tokensCheckedAt) : 0;
        const stale = !checked || Date.now() - checked > PREFLIGHT_STALE_MS;
        if ((cached !== null && cached < cfg.MIN_USABLE_TOKENS) || stale) {
          const pre = await pool.refreshBalance(acc.id);
          if (!pre.ok) {
            dev('warn', `preflight: "${acc.name}" unusable (${pre.reason})`);
            if (!pref) { const better = await pool.findLive({ excludeIds: [acc.id], max: 12, model: wantModel }); if (better) { dev('ok', `preflight swap: "${acc.name}" -> "${better.name}"`); acc = better; } }
          }
        }
      }
      pool.setActive(acc.id); run.accId = acc.id;
      emit('account', { id: acc.id, name: acc.name });

      // ---- loop (self-heal / handoff / rotate)
      const exhausted = new Set();
      const dropFields = [];
      let model_ = wantModel, projectId = null, chatSessionId = null;
      let carryText = '', carryReasoning = '', carrySteps = [];
      let continuations = 0, rotations = 0, guard = 0;
      const startText = String(text);
      let currentText = buildAgentPrompt({ task: startText, helpUrl: this.sandbox ? this.sandbox.helpUrl() : '', cwd: this.sandbox?.cwd });

      while (guard++ < this.maxContinuations * 2 + 12) {
        if (run.aborted) return { ok: false, aborted: true, content: carryText };
        const jar = pool.store.jar(acc.id);
        let token = '';
        try { token = (await this.recaptcha?.getFreshToken('ask', acc.id)) || ''; } catch { token = ''; }
        if (run.aborted) return { ok: false, aborted: true, content: carryText };

        dev('info', `send: ai_chat · ${model_} · "${acc.name}"${token ? '' : ' (no recaptcha token)'}`);
        let live = null;
        const stream = askStream(jar, { userInput: currentText, recaptchaToken: token, model: model_, chatSessionId, projectId, history, dropFields }, {
          onDelta: (d) => emit('chunk', { kind: d.kind, delta: d.delta, replace: !!d.replace, text: d.replace ? d.text : undefined, accountId: acc.id }),
          onSteps: (steps) => emit('steps', { steps: carrySteps.concat(shiftSteps(steps, carryText)), accountId: acc.id }),
          onStatus: (p) => { if (p.projectId) { projectId = p.projectId; run.projectId = p.projectId; } if (p.chatSessionId) chatSessionId = p.chatSessionId; emit('status', p); },
          onMeta: (m) => { if (m.kind === 'credit_exhausted') dev('warn', `"${acc.name}": credits exhausted`); },
          onEvent: (ev, st) => { live = st; if (st.askId) run.askId = st.askId; },
        });
        run.abort = stream.abort;
        let result = null, err = null;
        try { result = await stream.promise; } catch (e) { err = e; }
        // ===== balance trigger #2: right after the request (any outcome)
        this._bg(pool.afterRequest(acc.id));
        if (run.aborted) return { ok: false, aborted: true, content: carryText };

        if (!err) {
          if (result.projectId) projectId = result.projectId;
          const content = carryText ? (result.content ? carryText + '\n\n' + result.content : carryText) : result.content;
          const reasoning = carryReasoning ? carryReasoning + '\n\n' + (result.reasoning || '') : (result.reasoning || '');
          const steps = carrySteps.concat(shiftSteps(result.steps || [], carryText));
          const out = { ok: true, content, reasoning, steps, projectId, accountId: acc.id, accountName: acc.name, model: model_, handoffs: continuations, ms: Date.now() - run.t0, usage: result.usage, finished: result.finished, extraDelivered: run.extra.length - (this.sandbox ? this.sandbox.pendingInbox() : 0) };
          this.history.push({ role: 'user', content: startText }, { role: 'assistant', content });
          emit('done', out);
          return out;
        }

        // ---------- failures
        const partial = err.partialResult;
        if (err.creditExhausted) {
          if (partial) {
            const got = cfg.stripCreditNotice(partial.content || '');
            if (got) carryText = carryText ? carryText + '\n\n' + got : got;
            if (partial.reasoning) carryReasoning = carryReasoning ? carryReasoning + '\n\n' + partial.reasoning : partial.reasoning;
            if (partial.steps?.length) carrySteps = carrySteps.concat(shiftSteps(partial.steps, carryText));
            if (partial.projectId) projectId = partial.projectId;
          }
          exhausted.add(acc.id); pool.markExhausted(acc.id);
          if (continuations >= this.maxContinuations) { dev('warn', `handoff limit (${this.maxContinuations})`); throw Object.assign(new Error('credits exhausted on too many accounts'), { code: 'handoff-limit', partial: carryText }); }
          if (projectId) await shareProject(jar, projectId);
          const next = await pool.findLive({ excludeIds: [...exhausted], max: 12, model: model_ });
          if (!next) throw Object.assign(new Error('all accounts are out of credits. Add one: /accounts'), { code: 'no-credits', partial: carryText });
          const prev = acc.name; acc = next; pool.setActive(acc.id); run.accId = acc.id; continuations++;
          currentText = buildAgentPrompt({ task: startText, helpUrl: this.sandbox ? this.sandbox.helpUrl() : '', cwd: this.sandbox?.cwd, continuing: true, carryTail: carryText.slice(-600) });
          dev('ok', `seamless handoff: "${prev}" -> "${acc.name}" (#${continuations}), project ${projectId || 'new'}`);
          emit('account', { id: acc.id, name: acc.name, handoff: true });
          emit('chunk', { kind: 'text', replace: true, text: carryText, delta: '', accountId: acc.id });
          continue;
        }

        const body = err.responseBody || '';
        if (err.statusCode === 422 && body) {
          const modelErr = findFieldError(body, 'ai_chat_model');
          if (modelErr && modelErr.expected.length) {
            learnIds(modelErr.expected);
            const want = parseModelId(model_);
            const same = modelErr.expected.map(parseModelId).filter((p) => p && want && p.family === want.family).sort((a, b) => compareVersion(b.version, a.version));
            const fixed = (same[0] && same[0].id) || modelErr.expected[0];
            if (fixed && fixed !== model_) { dev('info', `422: model ${model_} -> ${fixed}`); model_ = fixed; continue; }
          }
          const bad = findForbiddenFields(body).filter((f) => !dropFields.includes(f));
          if (bad.length) { dropFields.push(...bad); dev('info', `422: dropping fields ${bad.join(', ')}`); continue; }
        }

        // A challenge is not an expired session or a credit problem. Do not replay
        // the prompt across the pool (or retry an unexpected successful response).
        if (err.code === 'cloudflare-challenge' || err.code === 'invalid-stream-response' || err.code === 'browser-session-unavailable') throw err;

        // network / server error -> rotate to the next account
        dev('warn', `"${acc.name}": ${String(err.message).slice(0, 160)}`);
        exhausted.add(acc.id);
        if (++rotations > 6) throw err;
        if (projectId) await shareProject(jar, projectId);
        const q = pool.rotationQueue({ excludeIds: [...exhausted], model: model_ });
        if (!q.length) throw err;
        acc = q[0]; pool.setActive(acc.id); run.accId = acc.id;
        if (projectId) currentText = buildAgentPrompt({ task: startText, helpUrl: this.sandbox ? this.sandbox.helpUrl() : '', continuing: true, carryTail: carryText.slice(-600) });
        projectId = null; chatSessionId = null; // private project of the previous owner
        emit('account', { id: acc.id, name: acc.name, rotated: true });
      }
      throw new Error('too many attempts');
    } catch (e) {
      emit('failed', e);
      throw e;
    } finally {
      this.cur = null;
      this.pool.setActive(acc ? acc.id : '');
    }
  }
}
