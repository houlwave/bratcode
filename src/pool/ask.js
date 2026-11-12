// POST /api/agent/ask_proxy (ai_chat) -> SSE stream. Port of sse-client.js + ask-payload.js (ai_chat branch) over fetch.
import { randomUUID, randomBytes } from 'node:crypto';
import * as cfg from './config.js';
import { gsRequest } from './net.js';
import { createSseParser } from './sse-parser.js';
import { createProtocolState } from './protocol.js';
import * as toolSteps from './tool-steps.js';

export function buildPayload({ userInput, recaptchaToken = '', model, isPrivate = true, chatSessionId = null, projectId = null, history = [], dropFields = [], lastSeenEventIndex = -1, search = true } = {}) {
  const messageId = randomUUID();
  const messages = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.content)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', id: m.id || randomUUID(), content: String(m.content) }));
  const content = String(userInput || '');
  messages.push({ role: 'user', id: messageId, content, pending: true, sendStatus: 'sending', _deepDiveStateNegContent: content });
  const payload = {
    ai_chat_model: model,
    ai_chat_enable_search: !!search, // web access is what lets the model open the sandbox URL
    ai_chat_disable_personalization: true,
    use_moa_proxy: false,
    moa_models: [],
    writingContent: null,
    sas_ask_origin: 'typed',
    type: cfg.ASK_TYPE_AI_CHAT,
    project_id: projectId,
    messages,
    user_s_input: content,
    client_message_id: messageId,
    g_recaptcha_token: recaptchaToken || '',
    is_private: !!isPrivate,
    push_token: '',
    session_state: { steps: [], messages },
    last_seen_event_index: Number.isFinite(Number(lastSeenEventIndex)) ? Number(lastSeenEventIndex) : -1,
    chat_session_id: chatSessionId,
  };
  for (const f of dropFields || []) { delete payload[f]; for (const m of payload.messages) delete m[f]; }
  return payload;
}

const hex = (n) => randomBytes(n / 2).toString('hex');
function buildHeaders() {
  const h = { ...cfg.defaultHeaders(), 'content-type': 'application/json', accept: 'text/event-stream, */*', 'cache-control': 'no-cache', pragma: 'no-cache' };
  const t = hex(32), s = hex(16);
  h.traceparent = `00-${t}-${s}-01`;
  h['request-id'] = `|${t}.${s}`;
  return h;
}

/**
 * handlers: onDelta({kind,delta,text,replace}) onSteps(steps) onStatus(patch) onMeta({kind}) onEvent(ev,state)
 * returns { promise, abort, payload }
 */
export function askStream(jar, opts, handlers = {}) {
  const h = handlers;
  const body = buildPayload(opts);
  const ctl = new AbortController();
  let aborted = false;

  const promise = (async () => {
    const r = await gsRequest(jar, { method: 'POST', path: cfg.ASK_PATH, headers: buildHeaders(), body, timeoutMs: 0, signal: ctl.signal, stream: true });
    h.onMeta?.({ kind: 'response', status: r.status });
    if (r.creditRedirect) { const e = new Error('CREDIT_EXHAUSTED: redirect'); e.creditExhausted = true; e.statusCode = 402; throw e; }
    if (r.status >= 400) {
      const errBody = await r.res.text().catch(() => '');
      const err = new Error('HTTP ' + r.status + ': ' + errBody.slice(0, 4000));
      err.statusCode = r.status; err.responseBody = errBody;
      if (cfg.looksCreditExhausted(errBody) || r.status === 402) err.creditExhausted = true;
      throw err;
    }

    let creditExhausted = false, creditNote = '', lastTextMsgId = '';
    const result = {
      projectId: opts.projectId || null, messageId: null, askId: null, chatSessionId: null, title: '',
      content: '', reasoning: '', steps: [], files: [], status: null, finished: false, rawEvents: 0, lastEventIndex: -1,
      model: body.ai_chat_model, usage: null, tokenUsage: null, creditExhausted: false, aborted: false,
    };
    const noteCredit = (text, strict) => {
      if (creditExhausted) return;
      if (!(strict ? cfg.looksCreditExhaustedStrict(text) : cfg.looksCreditExhausted(text))) return;
      creditExhausted = true; result.creditExhausted = true; creditNote = String(text).slice(0, 600);
      h.onMeta?.({ kind: 'credit_exhausted', text: creditNote });
    };

    const proto = createProtocolState({
      onText: ({ messageId, delta, text, replace }) => {
        result.messageId = messageId || result.messageId;
        noteCredit(String(text || '').slice(-1200), true);
        const hadText = String(result.content || '').length > 0;
        result.content = proto.assistantText();
        let out = delta;
        if (!replace && delta && hadText && messageId && messageId !== lastTextMsgId) out = '\n\n' + delta;
        if (delta || replace) lastTextMsgId = messageId || lastTextMsgId;
        h.onDelta?.({ kind: 'text', messageId, delta: out, text: replace ? result.content : text, replace: !!replace });
      },
      onReasoning: ({ messageId, delta, text, replace }) => {
        result.reasoning = proto.assistantReasoning();
        h.onDelta?.({ kind: 'reasoning', messageId, delta, text, replace: !!replace });
      },
      onSteps: (steps) => { result.steps = steps; h.onSteps?.(steps); },
      onStatus: (patch) => {
        if (patch.projectId) result.projectId = patch.projectId;
        if (patch.chatSessionId) result.chatSessionId = patch.chatSessionId;
        if (patch.title) result.title = patch.title;
        if (patch.tokenUsage) result.tokenUsage = patch.tokenUsage;
        if (patch.usage) result.usage = patch.usage;
        if (patch.status) result.status = patch.status;
        h.onStatus?.(patch);
      },
      onFinished: () => { result.finished = true; },
      onEvent: (ev, state) => {
        result.rawEvents = state.rawEvents; result.lastEventIndex = state.lastEventIndex;
        if (state.projectId && !result.projectId) result.projectId = state.projectId;
        if (state.askId) result.askId = state.askId;
        if (ev.type === 'agent_notification' || ev.type === 'error' || ev.type === 'ask_error') {
          const data = ev.notification_data || ev.data || ev.message || null;
          if (ev.notification_type !== 'keepalive' && data) noteCredit(JSON.stringify(data), false);
        }
        h.onEvent?.(ev, state);
      },
    });
    const stepsTimer = setInterval(() => { try { proto.flushSteps(); } catch { /* ignore */ } }, 120);
    const parser = createSseParser((payload) => {
      let ev; try { ev = JSON.parse(payload); } catch { return; }
      try { proto.handleEvent(ev); } catch { /* one bad event must not kill the stream */ }
    });

    const finalize = () => {
      clearInterval(stepsTimer);
      try { parser.end(); } catch { /* ignore */ }
      try { proto.flushSteps(); } catch { /* ignore */ }
      result.content = proto.assistantText(); result.reasoning = proto.assistantReasoning();
      result.steps = proto.steps(); result.files = toolSteps.collectFiles(result.steps);
      result.finished = proto.state.finished; result.lastEventIndex = proto.state.lastEventIndex;
      if (proto.state.title) result.title = proto.state.title;
      if (proto.state.projectId) result.projectId = proto.state.projectId;
      if (proto.state.chatSessionId) result.chatSessionId = proto.state.chatSessionId;
      if (proto.state.askId) result.askId = proto.state.askId;
      if (proto.state.usage) result.usage = proto.state.usage;
      if (proto.state.tokenUsage) result.tokenUsage = proto.state.tokenUsage;
    };

    try {
      const reader = r.res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        try { parser.push(Buffer.from(value)); } catch { /* ignore */ }
      }
    } catch (e) {
      finalize();
      if (aborted) { result.aborted = true; return result; }
      throw e;
    } finally { if (r.timer) clearTimeout(r.timer); }

    finalize();
    h.onMeta?.({ kind: 'end' });
    if (creditExhausted && !aborted) {
      result.content = cfg.stripCreditNotice(result.content);
      const err = new Error('CREDIT_EXHAUSTED: ' + (creditNote || 'credits exhausted'));
      err.creditExhausted = true; err.statusCode = 200; err.responseBody = creditNote; err.partialResult = result;
      throw err;
    }
    result.aborted = aborted;
    return result;
  })();

  return { promise, payload: body, abort: () => { aborted = true; try { ctl.abort(); } catch { /* ignore */ } } };
}

// ---- 422 self-heal helpers -------------------------------------------------
export function parseValidationErrors(responseBody) {
  const out = [];
  let json = null;
  try { json = JSON.parse(responseBody); } catch { const m = String(responseBody || '').match(/\{[\s\S]*\}/); if (m) { try { json = JSON.parse(m[0]); } catch { /* ignore */ } } }
  const errors = json && (json.errors || json.detail);
  if (!Array.isArray(errors)) return out;
  for (const e of errors) {
    const loc = Array.isArray(e.loc) ? e.loc : [];
    const field = loc.length ? String(loc[loc.length - 1]) : null;
    const src = (e.ctx && e.ctx.expected) || e.msg || '';
    out.push({ field, expected: [...String(src).matchAll(/'([^']+)'/g)].map((m) => m[1]), type: e.type, msg: e.msg });
  }
  return out;
}
export const findFieldError = (body, field) => parseValidationErrors(body).find((e) => e.field === field) || null;
export const findForbiddenFields = (body) => parseValidationErrors(body)
  .filter((e) => /extra/i.test(String(e.type || '')) || /extra fields|not permitted|unexpected/i.test(String(e.msg || '')))
  .map((e) => e.field).filter(Boolean);

// ---- server-side abort + project sharing ----------------------------------
export async function abortRun(jar, { projectId, askId, messageId } = {}) {
  if (!projectId && !askId) return { ok: false, reason: 'no-target' };
  const body = {}; if (projectId) body.project_id = projectId; if (askId) body.ask_id = askId; if (messageId) body.message_id = messageId;
  try {
    const r = await gsRequest(jar, { method: 'POST', path: cfg.ASK_ABORT_PATH, headers: { 'content-type': 'application/json', referer: `${cfg.ORIGIN}/agents?id=${encodeURIComponent(projectId || '')}` }, body, timeoutMs: 8000 });
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

export async function shareProject(jar, projectId) {
  if (!projectId) return { ok: false, reason: 'no-project' };
  try {
    const r = await gsRequest(jar, { method: 'POST', path: '/api/project/update', headers: { 'content-type': 'application/json', referer: `${cfg.ORIGIN}/agents?id=${encodeURIComponent(projectId)}` }, body: { id: String(projectId), is_private: false, read_permissions: [], write_permissions: [] }, timeoutMs: 30000 });
    const ok = r.status >= 200 && r.status < 300 && (!r.json || r.json.status === 0 || r.json.status === undefined);
    return { ok, status: r.status };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}
