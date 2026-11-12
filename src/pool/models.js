// Live model catalog (port of electron/genspark/models.js, without electron).
import fs from 'node:fs';
import { MODELS_CACHE_FILE } from '../paths.js';
import { MOA_PATH, MODELS_PATH, ROUTER_PATH } from './config.js';
import { gsJson } from './net.js';

// ─── Актуальный каталог моделей Genspark ─────────────────────────────────────
//
// Раньше список моделей был ЗАХАРДКОЖЕН в двух местах сразу
// (electron/genspark/config.js и src/components/ModelPicker.jsx), и их
// приходилось править руками. Как только Genspark выкатывал новую версию
// (Opus 5.5, Fable 5.1), приложение продолжало слать старый id, сервер отвечал
// 422, запускался «self-heal»-цикл подбора — отсюда и «запросы работают плохо».
//
// Теперь каталог берётся с сервера:
//
//   GET /api/moa_models_config   → модели AI Chat (MoA)
//   GET /api/models_config       → общий конфиг моделей
//   GET /api/genspark_router/models (фолбэк)
//
// Из полного ответа отбираются только семейства Claude и для КАЖДОГО
// семейства (fable / opus / sonnet / haiku) берётся САМАЯ СВЕЖАЯ версия по
// числовому сравнению. Так «последние модели» появляются в пикере сами, без
// релиза приложения.
//
// Кэш лежит в <userData>/models-cache.json и переживает перезапуск: если сеть
// недоступна или пользователь ещё не залогинен, UI показывает последний
// успешный каталог, а не пустоту.



// Семейства Claude, которые показываем. Порядок = порядок в пикере.
export const FAMILIES = Object.freeze([
  { key: 'fable', label: 'Fable', sub: 'For your toughest challenges' },
  { key: 'opus', label: 'Opus', sub: 'For complex work and everyday tasks' },
  { key: 'sonnet', label: 'Sonnet', sub: 'Most efficient for simpler tasks' },
  { key: 'haiku', label: 'Haiku', sub: 'Fastest for quick answers' },
]);

export const FAMILY_KEYS = FAMILIES.map((f) => f.key);

// Фолбэк — актуальный на момент сборки срез (из реконструкции бандлов
// Genspark, REPORT_AGENT_FLOW.md §4). Используется ТОЛЬКО пока не пришёл
// живой ответ сервера и нет кэша на диске.
export const FALLBACK_MODELS = Object.freeze([
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable', version: [5, 1] },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus', version: [5, 5] },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', family: 'sonnet', version: [5] },
  { id: 'claude-4-5-haiku', label: 'Haiku 4.5', family: 'haiku', version: [4, 5] },
]);

// ── Разбор идентификатора модели ─────────────────────────────────────────────

/**
 * Достаёт семейство и версию из id модели.
 *
 * Genspark непоследователен в именовании, версия может стоять и после, и до
 * названия семейства:
 *   claude-opus-5        → opus  [5]
 *   claude-opus-5-5      → opus  [5, 5]
 *   claude-fable-5-1     → fable [5, 1]
 *   claude-sonnet-4-6    → sonnet[4, 6]
 *   claude-4-5-haiku     → haiku [4, 5]
 *   claude-3-5-sonnet-v2 → sonnet[3, 5]
 *
 * Поэтому ищем ключевое слово семейства где угодно, а версию собираем из всех
 * числовых сегментов идентификатора.
 */
export function parseModelId(rawId) {
  const id = String(rawId || '').trim().toLowerCase();
  if (!id) return null;
  if (id.indexOf('claude') === -1) return null;

  let family = '';
  for (const key of FAMILY_KEYS) {
    if (id.includes(key)) { family = key; break; }
  }
  if (!family) return null;

  // Версия: все числовые сегменты, разделённые -, _, . Пропускаем «claude».
  const segments = id.split(/[-_.]+/).filter(Boolean);
  const version = [];
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      version.push(Number(seg));
    } else {
      // Формы вида «4.5» уже разбиты, но бывает «v2» / «5p3».
      const m = /^v?(\d+)(?:p(\d+))?$/.exec(seg);
      if (m) {
        version.push(Number(m[1]));
        if (m[2]) version.push(Number(m[2]));
      }
    }
  }
  if (!version.length) version.push(0);
  return { id: String(rawId).trim(), family, version };
}

/** Сравнение версий как списков чисел: [5,5] > [5] > [4,6]. */
export function compareVersion(a, b) {
  const va = Array.isArray(a) ? a : [];
  const vb = Array.isArray(b) ? b : [];
  const n = Math.max(va.length, vb.length);
  for (let i = 0; i < n; i += 1) {
    const x = Number(va[i] || 0);
    const y = Number(vb[i] || 0);
    if (x !== y) return x - y;
  }
  return 0;
}

/** Человеческая подпись: opus + [5,5] → «Opus 5.5». */
export function labelFor(family, version, serverLabel) {
  const fam = FAMILIES.find((f) => f.key === family);
  const base = (fam && fam.label) || (family ? family[0].toUpperCase() + family.slice(1) : 'Claude');
  const ver = (Array.isArray(version) ? version : []).filter((n) => Number.isFinite(n));
  if (!ver.length) {
    // Если версии нет — доверяем подписи сервера, она обычно осмысленная.
    return String(serverLabel || base).replace(/^claude\s+/i, '');
  }
  return `${base} ${ver.join('.')}`;
}

// ── Извлечение моделей из произвольного JSON-ответа ──────────────────────────

/**
 * Серверные ответы различаются по форме: где-то `{ models: [...] }`, где-то
 * `{ data: { models: [...] } }`, где-то список лежит глубже. Поэтому вместо
 * жёсткого пути рекурсивно собираем все объекты, у которых есть поле с id
 * модели (`name` в терминах Genspark — это и есть picker value, см.
 * REPORT_AGENT_FLOW.md §4).
 */
export function harvestModels(node, out, depth) {
  if (!node || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (typeof item === 'string') {
        const parsed = parseModelId(item);
        if (parsed) out.push({ id: parsed.id, family: parsed.family, version: parsed.version, serverLabel: '', apiModel: '', gated: false, disabled: false });
      } else {
        harvestModels(item, out, depth + 1);
      }
    }
    return out;
  }
  if (typeof node !== 'object') return out;

  const idRaw = node.name || node.model || node.model_name || node.id || node.value;
  if (typeof idRaw === 'string' && idRaw.toLowerCase().includes('claude')) {
    const parsed = parseModelId(idRaw);
    if (parsed) {
      out.push({
        id: parsed.id,
        family: parsed.family,
        version: parsed.version,
        serverLabel: String(node.display_name || node.label || node.title || node.description || '').trim(),
        apiModel: String(node.api_model || '').trim(),
        // Скрытые за фиче-флагом записи сервер отдаёт, но показывать их нельзя:
        // picker посерел бы, а запрос вернул бы 403 (см. комментарий про gk_flag
        // в бандле Genspark).
        gated: !!(node.gk_flag || node.gkFlag),
        disabled: node.enabled === false || node.available === false || node.deprecated === true,
      });
    }
  }

  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v && typeof v === 'object') harvestModels(v, out, depth + 1);
  }
  return out;
}

/**
 * Сводит «сырой» урожай в финальный каталог: по одной (самой свежей) модели
 * на семейство в основном списке + все остальные версии в «More models».
 */
export function buildCatalog(rawList) {
  const byFamily = new Map();
  const seen = new Set();
  const all = [];

  for (const m of rawList || []) {
    if (!m || !m.id) continue;
    if (m.disabled) continue;
    // Fable на Genspark приходит за фиче-флагом (gk_flag), но аккаунтам с
    // доступом он работает. Раньше флаг выкидывал Fable из каталога целиком.
    if (m.gated && m.family !== 'fable') continue;
    const key = m.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = {
      id: m.id,
      family: m.family,
      version: m.version,
      label: labelFor(m.family, m.version, m.serverLabel),
    };
    all.push(entry);

    const cur = byFamily.get(m.family);
    if (!cur || compareVersion(entry.version, cur.version) > 0) {
      byFamily.set(m.family, entry);
    }
  }

  // Основной список — строго в порядке FAMILIES, с подписью-описанием.
  const primary = [];
  for (const fam of FAMILIES) {
    const best = byFamily.get(fam.key);
    if (best) primary.push(Object.assign({}, best, { sub: fam.sub }));
  }

  const primaryIds = new Set(primary.map((m) => m.id));
  // Остальные версии — по убыванию, внутри семейства, в том же порядке семейств.
  const more = all
    .filter((m) => !primaryIds.has(m.id))
    .sort((a, b) => {
      const fa = FAMILY_KEYS.indexOf(a.family);
      const fb = FAMILY_KEYS.indexOf(b.family);
      if (fa !== fb) return fa - fb;
      return compareVersion(b.version, a.version);
    });

  return { primary, more };
}


// ── disk cache ─────────────────────────────────────────────
function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, 'utf8'));
    if (!data || !Array.isArray(data.primary) || !data.primary.length) return null;
    return data;
  } catch { return null; }
}
function writeCache(catalog) {
  try { fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify({ ...catalog, fetchedAt: new Date().toISOString() }, null, 2), { mode: 0o600 }); } catch { /* ignore */ }
}

let liveCatalog = null;
let lastFetchAt = 0;
let inFlight = null;
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

const fallbackCatalog = () => {
  const fb = buildCatalog(FALLBACK_MODELS.map((m) => ({ ...m, serverLabel: m.label })));
  fb.source = 'fallback';
  return fb;
};

/** Fetch the catalog with the session of `jar` (an account). Falls back to disk cache, then built-in list. */
export async function fetchCatalog(jar, opts = {}) {
  const now = Date.now();
  if (!opts.force && liveCatalog && now - lastFetchAt < REFRESH_INTERVAL_MS) return liveCatalog;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const raw = [];
    if (jar) {
      for (const p of [MOA_PATH, MODELS_PATH, ROUTER_PATH]) {
        try {
          const r = await gsJson(jar, p, { timeoutMs: 15000 });
          if (r && r.json && Number(r.json.status) !== -5) harvestModels(r.json, raw, 0);
        } catch { /* next endpoint */ }
        const fams = new Set(raw.map((m) => m.family));
        if (FAMILY_KEYS.every((k) => fams.has(k))) break;
      }
    }
    if (raw.length) {
      const catalog = buildCatalog(raw);
      if (catalog.primary.length) { catalog.source = 'server'; liveCatalog = catalog; lastFetchAt = Date.now(); writeCache(catalog); return catalog; }
    }
    const cached = readCache();
    if (cached) { liveCatalog = { primary: cached.primary, more: cached.more || [], source: 'cache' }; lastFetchAt = Date.now(); return liveCatalog; }
    liveCatalog = fallbackCatalog();
    return liveCatalog;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

export function currentCatalog() {
  if (liveCatalog) return liveCatalog;
  const cached = readCache();
  if (cached) { liveCatalog = { primary: cached.primary, more: cached.more || [], source: 'cache' }; return liveCatalog; }
  return fallbackCatalog();
}
export const knownIds = () => { const c = currentCatalog(); return c.primary.concat(c.more || []).map((m) => m.id); };
export const latestOf = (family) => { const hit = currentCatalog().primary.find((m) => m.family === family); return hit ? hit.id : ''; };
export const defaultModelId = () => latestOf('opus') || (currentCatalog().primary[0] || {}).id || 'claude-opus-5';

/** Old/stale id -> freshest version of the same family (exact ids from "more" are kept). */
export function resolveModelId(rawId) {
  const raw = String(rawId == null ? '' : rawId).trim();
  const c = currentCatalog();
  const all = c.primary.concat(c.more || []);
  if (!raw) return defaultModelId();
  if (all.some((m) => m.id === raw)) return raw;
  const parsed = parseModelId(raw);
  if (parsed) { const latest = latestOf(parsed.family); if (latest) return latest; }
  return defaultModelId();
}

export function learnIds(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(parseModelId).filter(Boolean);
  if (!list.length) return false;
  const c = currentCatalog();
  const before = JSON.stringify(c.primary.map((m) => m.id));
  const raw = c.primary.concat(c.more || []).map((m) => ({ id: m.id, family: m.family, version: m.version, serverLabel: m.label, gated: false, disabled: false }));
  for (const m of list) raw.push({ id: m.id, family: m.family, version: m.version, serverLabel: '', gated: false, disabled: false });
  const next = buildCatalog(raw);
  next.source = c.source || 'server';
  liveCatalog = next;
  const changed = JSON.stringify(next.primary.map((m) => m.id)) !== before;
  if (changed) writeCache(next);
  return changed;
}
export function invalidate() { liveCatalog = null; lastFetchAt = 0; }
