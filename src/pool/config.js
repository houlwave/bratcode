// Genspark endpoints, headers, credit-exhaustion detection. (port of electron/genspark/config.js, no electron)
export let ORIGIN = process.env.BRATCODE_ORIGIN || 'https://www.genspark.ai';
export function setOrigin(o) { ORIGIN = String(o).replace(/\/+$/, ''); }

export const ASK_PATH = '/api/agent/ask_proxy';
export const ASK_ABORT_PATH = '/api/agent/ask_abort';
export const BALANCE_PATH = '/api/payment/get_credit_balance';
export const USER_PATH = '/api/user';
export const MEMBER_BENEFITS_PATH = '/api/quota/member_benefits';
export const MOA_PATH = '/api/moa_models_config';
export const MODELS_PATH = '/api/models_config';
export const ROUTER_PATH = '/api/genspark_router/models';

export const ASK_TYPE_AI_CHAT = 'ai_chat';
export const MIN_USABLE_TOKENS = 1;

export function defaultHeaders() {
  const origin = ORIGIN;
  let tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { /* ignore */ }
  return {
    accept: '*/*',
    'accept-language': 'ru,en-US;q=0.9,en;q=0.8',
    'content-type': 'application/json',
    origin,
    referer: origin + '/',
    priority: 'u=1, i',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'x-timezone': tz,
  };
}

export const CREDIT_EXHAUSTED_PATTERNS = [
  /fromurl=credit_exhausted/i, /credit[_\s-]?exhausted/i,
  /баланс\s+кредитов\s+отрицательн/i, /отрицательный\s+баланс/i, /этот\s+запуск\s+остановлен/i,
  /запуск\s+(был\s+)?остановлен[\s\S]{0,80}пополн/i, /пожалуйста,?\s+пополните/i, /пополните,?\s+чтобы\s+продолжить/i,
  /недостаточно\s+кредитов/i, /использовали\s+все\s+свои\s+кредиты/i, /израсходовали\s+все\s+(свои\s+)?кредиты/i,
  /кредиты\s+закончились/i, /закончились\s+кредиты/i,
  /your\s+credit\s+balance\s+is\s+negative/i, /credit\s+balance\s+is\s+negative/i, /negative\s+credit\s+balance/i,
  /this\s+run\s+(has\s+been\s+|was\s+)?stopped/i, /run\s+(has\s+been\s+|was\s+)?stopped[\s\S]{0,80}(top\s*-?\s*up|upgrade|recharge)/i,
  /please\s+(top\s*-?\s*up|recharge|upgrade)\s+to\s+continue/i, /used\s+(up\s+)?all\s+(of\s+)?your\s+credits/i,
  /insufficient\s+credits?/i, /out\s+of\s+credits/i, /credits?\s+(have\s+)?run\s+out/i, /no\s+credits\s+(left|remaining)/i,
  /quota\s+exceeded/i,
];
export const CREDIT_STRICT_PATTERNS = [
  /баланс\s+кредитов\s+отрицательн/i, /отрицательный\s+баланс\s+кредит/i, /этот\s+запуск\s+остановлен/i,
  /пополните,?\s+чтобы\s+продолжить/i, /credit\s+balance\s+is\s+negative/i, /negative\s+credit\s+balance/i,
  /this\s+run\s+(has\s+been\s+|was\s+)?stopped/i, /please\s+(top\s*-?\s*up|recharge|upgrade)\s+to\s+continue/i,
  /fromurl=credit_exhausted/i, /insufficient\s+credits?/i, /out\s+of\s+credits/i, /недостаточно\s+кредитов/i,
];

export const looksCreditExhausted = (text) => { const t = String(text || ''); return !!t && CREDIT_EXHAUSTED_PATTERNS.some((re) => re.test(t)); };
export function looksCreditExhaustedStrict(text) {
  const t = String(text || '');
  if (!t) return false;
  if (CREDIT_STRICT_PATTERNS.some((re) => re.test(t))) return true;
  return t.length <= 600 && CREDIT_EXHAUSTED_PATTERNS.some((re) => re.test(t));
}
export function stripCreditNotice(text) {
  const t = String(text || '');
  if (!t) return '';
  const kept = [];
  for (const line of t.split('\n')) {
    if (!line.trim()) { kept.push(line); continue; }
    if (/^\s*[*\-]?\s*\[?upgrade\]?\s*(\(.*\))?\s*$/i.test(line)) continue;
    if (/^\s*[*\-]?\s*\[?(обновить|пополнить)(\s+(план|баланс|тариф))?\]?\s*$/i.test(line)) continue;
    if (!CREDIT_EXHAUSTED_PATTERNS.some((re) => re.test(line))) { kept.push(line); continue; }
    // the notice may share a line with real text: drop only the offending sentences
    const rest = line.split(/(?<=[.!?])\s+/).filter((s) => !CREDIT_EXHAUSTED_PATTERNS.some((re) => re.test(s)));
    if (rest.length) kept.push(rest.join(' '));
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// cookie that proves a logged-in Genspark session
const IGNORE_RE = /^(x-ms-|cpim|csrf|_ga|_gid|_gat|_gcl|_fbp|_fbc|_gtag|_ym_|_hj|__utm|ajs_|mp_|amplitude_|intercom-)/i;
export function hasAuthCookie(cookies) {
  return (cookies || []).some((c) => {
    const dom = String(c.domain || '').toLowerCase();
    if (!(dom === 'genspark.ai' || dom === '.genspark.ai' || dom === 'www.genspark.ai' || dom.endsWith('.www.genspark.ai'))) return false;
    if (IGNORE_RE.test(String(c.name || '').toLowerCase())) return false;
    return String(c.value || '').length >= 4;
  });
}
