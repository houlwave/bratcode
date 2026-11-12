// Live balance / user / model-access probes (port of electron/genspark/balance.js).
import { BALANCE_PATH, USER_PATH, MEMBER_BENEFITS_PATH } from './config.js';
import { gsJson, isNotLogin } from './net.js';
import { parseMemberBenefits } from './model-access.js';

const safeReq = async (jar, path, timeoutMs) => {
  try { return { res: await gsJson(jar, path, { timeoutMs }) }; }
  catch (e) { return { err: (e && e.message) || String(e) }; }
};

export async function fetchBalance(jar, timeoutMs = 20000) {
  const { res, err } = await safeReq(jar, BALANCE_PATH, timeoutMs);
  if (err) return { ok: false, reason: 'request-error', error: err };
  const json = res.json;
  if (!json) return { ok: false, reason: 'parse-error', body: String(res.text || '').slice(0, 200) };
  if (isNotLogin(json)) return { ok: false, reason: 'not-login', dead: true };
  const balance = Number(json.data && json.data.balance);
  if (!Number.isFinite(balance)) return { ok: false, reason: 'bad-balance', body: String(res.text || '').slice(0, 200) };
  return { ok: true, tokens: balance };
}

export const nameFromEmail = (email) => {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  const local = (at > 0 ? s.slice(0, at) : s).trim();
  return !local || local.includes('*') ? '' : local;
};

export async function fetchUserInfo(jar, timeoutMs = 20000) {
  const { res, err } = await safeReq(jar, USER_PATH, timeoutMs);
  if (err) return { ok: false, reason: 'request-error', error: err };
  const json = res.json;
  if (!json) return { ok: false, reason: 'parse-error' };
  if (isNotLogin(json)) return { ok: false, reason: 'not-login', dead: true };
  const data = json.data || {};
  const cogen = data.cogen || data.user || {};
  const email = String(cogen.email || data.email || '').trim();
  if (!email) return { ok: false, reason: 'no-email' };
  return { ok: true, email, name: nameFromEmail(email), plan: String(cogen.plan || '') };
}

export async function fetchModelAccess(jar, timeoutMs = 15000) {
  const { res, err } = await safeReq(jar, MEMBER_BENEFITS_PATH, timeoutMs);
  if (err) return { ok: false, reason: 'request-error', error: err };
  const json = res.json;
  if (!json) return { ok: false, reason: 'parse-error' };
  if (isNotLogin(json)) return { ok: false, reason: 'not-login', dead: true };
  return parseMemberBenefits(json);
}
