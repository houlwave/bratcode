
/**
 * Доступность моделей AI Chat на конкретном аккаунте.
 *
 * Genspark закрывает «флагманские» модели (Claude Opus 5.x, GPT-5.x Pro …),
 * когда у аккаунта исчерпано окно лимита (~5 часов) или нет подписки.
 * Если закрытую модель всё же запросить, сервер НЕ отвечает ошибкой, а молча
 * подставляет модель по умолчанию (Claude Haiku) — ответ получается не от той
 * модели и ломает формат. Поэтому мы заранее знаем, что закрыто на аккаунте, и
 * не отправляем такие запросы на этот аккаунт.
 *
 * Источник: GET /api/quota/member_benefits →
 *   { status: 0, ai_chat: { flagship_locked, flagship_models[],
 *                           member_only_locked, member_only_models[] } }
 *
 * В accounts.json у аккаунта живут два служебных поля (в UI не показываются,
 * кроме приглушённого имени):
 *   lockedModels          — string[]  id закрытых моделей (пусто = всё открыто)
 *   modelAccessCheckedAt  — ISO       когда список обновлялся последний раз
 *
 * Аккаунт с непустым lockedModels остаётся ДОСТУПНЫМ (isAccountAvailable его не
 * трогает) — он лишь не выбирается под закрытые модели.
 *
 * Модуль чистый (без electron) — его можно тестировать напрямую.
 */

const MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/;
const MAX_LOCKED = 100;
const CLAUDE_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

/** Достаёт блок ai_chat из ответа (допускаются обёртки data / result). */
function findAiChat(json) {
  if (!json || typeof json !== 'object') return null;
  const direct = json.ai_chat;
  if (direct && typeof direct === 'object') return direct;
  for (const k of ['data', 'result']) {
    const inner = json[k];
    if (inner && typeof inner === 'object' && inner.ai_chat && typeof inner.ai_chat === 'object') {
      return inner.ai_chat;
    }
  }
  return null;
}

/**
 * Разбор ответа /api/quota/member_benefits.
 * @returns {{ ok: true, locked: string[] } | { ok: false, reason: string }}
 *   ok:false = «не знаем» — прежний список аккаунта трогать нельзя.
 */
function parseMemberBenefits(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'parse-error' };
  const status = Number(json.status);
  if (Number.isFinite(status) && status < 0) return { ok: false, reason: 'bad-status' };
  const chat = findAiChat(json);
  // Нет блока ai_chat — форма ответа незнакомая. Не «открываем всё» вслепую.
  if (!chat) return { ok: false, reason: 'no-ai-chat' };

  const list = [];
  if (chat.flagship_locked === true && Array.isArray(chat.flagship_models)) list.push(...chat.flagship_models);
  if (chat.member_only_locked === true && Array.isArray(chat.member_only_models)) list.push(...chat.member_only_models);
  const locked = [...new Set(list.filter((m) => typeof m === 'string' && MODEL_ID_RE.test(m)))].slice(0, MAX_LOCKED);
  return { ok: true, locked };
}

/**
 * Каноничный ключ модели. Учитывает разную запись id у Genspark:
 *   claude-opus-5-5 / claude-opus-5.5 / claude-opus-5-5-20260101 → claude:opus:5.5
 *   claude-4-5-haiku                                            → claude:haiku:4.5
 * Для не-Claude моделей ключ — сам id в нижнем регистре.
 * Версии НЕ смешиваются: opus 5 ≠ opus 5.5 ≠ opus 4.8.
 */
function modelKey(rawId) {
  const id = String(rawId == null ? '' : rawId).trim().toLowerCase();
  if (!id) return '';
  if (id.includes('claude')) {
    const family = CLAUDE_FAMILIES.find((f) => id.includes(f));
    if (family) {
      const nums = id.split(/[-_.]+/).filter((seg) => /^\d{1,3}$/.test(seg)); // даты (≥4 цифр) отбрасываем
      return `claude:${family}:${nums.join('.')}`;
    }
  }
  return id.replace(/-(1m|extended-cache)$/, '');
}

function lockedList(account) {
  return account && Array.isArray(account.lockedModels) ? account.lockedModels : [];
}

/** Закрыта ли модель на этом аккаунте. Пустая модель/список → false. */
function isModelLockedFor(account, modelId) {
  const list = lockedList(account);
  if (!list.length || !modelId) return false;
  const key = modelKey(modelId);
  if (!key) return false;
  return list.some((m) => modelKey(m) === key);
}

/** «Наполовину доступен»: аккаунт рабочий, но часть моделей закрыта. */
function isPartiallyAvailable(account) {
  return !!account && !account.dead && lockedList(account).length > 0;
}

/**
 * Записывает результат проверки в объект аккаунта (без записи на диск).
 * @param {object} account
 * @param {{ok:boolean, locked?:string[]}|null} access  результат fetchModelAccess
 * @returns {boolean} изменился ли набор закрытых моделей
 */
function applyModelAccess(account, access) {
  if (!account || !access || !access.ok || !Array.isArray(access.locked)) return false;
  const next = access.locked.slice().sort();
  const prev = lockedList(account).slice().sort();
  const changed = next.length !== prev.length || next.some((v, i) => v !== prev[i]);
  if (next.length) account.lockedModels = access.locked.slice();
  else delete account.lockedModels; // чистая запись в accounts.json: поле есть только при блокировке
  account.modelAccessCheckedAt = new Date().toISOString();
  return changed;
}

export {
  parseMemberBenefits,
  modelKey,
  isModelLockedFor,
  isPartiallyAvailable,
  applyModelAccess,
};
