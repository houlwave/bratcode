
// ─── Шаги инструментов: tool_call → tool_result ──────────────────────────────
//
// В режиме `code_sandbox` Genspark ведёт диалог двумя ролями:
//
//   role: "assistant" — текст ответа + tool_calls[N].function.{name, arguments}
//   role: "tool"      — РЕЗУЛЬТАТ инструмента. У такого сообщения
//                       message_id == tool_call_id (`toolu_…`), а content —
//                       сериализованный JSON:
//                       {"exit_code":0,"execution_time_ms":109,"outputs":[…]}
//
// Что здесь изменилось по сравнению с прошлой версией:
//
//   1) Результаты сопоставляются с вызовами по `tool_call_id`, а НЕ по порядку
//      появления. Раньше шаги матчились «первый результат — первому вызову»,
//      и стоило агенту сделать несколько вызовов подряд (а он так делает
//      всегда), как вывод приклеивался к чужому шагу.
//   2) Поддержан стриминг `session_state.outputs` через append_item: stdout
//      виден по мере выполнения команды, а не только в конце.
//   3) UploadFileWrapper распознаётся отдельно — из него достаётся карточка
//      файла (`file_wrapper_url`), ровно как это делает веб-клиент Genspark.

const TOOL_LABELS = Object.freeze({
  Bash: 'Терминал',
  BashOutput: 'Вывод команды',
  KillBash: 'Остановка процесса',
  Read: 'Чтение файла',
  Write: 'Запись файла',
  Edit: 'Правка файла',
  MultiEdit: 'Правка файла',
  NotebookRead: 'Чтение ноутбука',
  NotebookEdit: 'Правка ноутбука',
  Glob: 'Поиск файлов',
  Grep: 'Поиск по коду',
  LS: 'Список файлов',
  WebSearch: 'Поиск в интернете',
  WebFetch: 'Загрузка страницы',
  TodoWrite: 'План задач',
  Task: 'Подзадача',
  UploadFileWrapper: 'Загрузка файла',
  DownloadFileWrapper: 'Скачивание файла',
  GetServiceUrl: 'Публикация сервиса',
  ProjectBackup: 'Резервная копия',
});

const TOOL_KINDS = Object.freeze({
  Bash: 'terminal',
  BashOutput: 'terminal',
  KillBash: 'terminal',
  Read: 'file',
  NotebookRead: 'file',
  LS: 'file',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'web',
  WebFetch: 'web',
  TodoWrite: 'plan',
  Task: 'plan',
  UploadFileWrapper: 'upload',
  DownloadFileWrapper: 'upload',
  GetServiceUrl: 'web',
  // Нативные инструменты Genspark (ai_chat / super_agent).
  web_search: 'web',
  image_search: 'web',
  news_search: 'web',
  crawler: 'fetch',
  summarize_large_document: 'fetch',
  understand_images: 'file',
  analyze_media_content: 'file',
});

const MAX_PREVIEW_CHARS = 4000;
const MAX_PREVIEW_LINES = 60;
const MAX_TITLE_CHARS = 140;

function safeParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

/**
 * Достаёт строковое поле из JSON-аргументов, даже если JSON ещё НЕ дописан.
 *
 * Аргументы приезжают кусками по ~7 символов, и полноценный JSON.parse
 * проходит только в самом конце. Чтобы заголовок шага появлялся сразу,
 * при неудачном parse вытаскиваем значение регуляркой.
 */
function pickArgString(rawArgs, key) {
  const s = String(rawArgs || '');
  if (!s) return '';
  const parsed = safeParse(s);
  if (parsed && typeof parsed === 'object' && typeof parsed[key] === 'string') {
    return parsed[key];
  }
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"');
  const m = re.exec(s);
  if (!m) return '';
  try { return JSON.parse('"' + m[1] + '"'); } catch (_) { return m[1]; }
}

function basename(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

function clamp(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function firstLine(s) {
  return String(s || '').split('\n')[0].trim();
}

/**
 * Заголовок шага — одна строка для свёрнутой карточки.
 *
 * Приоритет: `description` (его пишет сама модель) → осмысленный аргумент
 * (команда / файл / паттерн / URL) → просто имя инструмента.
 */
function buildTitle(toolName, rawArgs) {
  const tool = String(toolName || '').trim();
  const desc = pickArgString(rawArgs, 'description');
  if (desc) return clamp(desc.trim(), MAX_TITLE_CHARS);

  const label = TOOL_LABELS[tool] || tool || 'Шаг';
  const command = pickArgString(rawArgs, 'command');
  const filePath = pickArgString(rawArgs, 'file_path')
    || pickArgString(rawArgs, 'path')
    || pickArgString(rawArgs, 'notebook_path')
    || pickArgString(rawArgs, 'sandbox_file_path');
  const pattern = pickArgString(rawArgs, 'pattern');
  const url = pickArgString(rawArgs, 'url');
  const query = pickArgString(rawArgs, 'query');

  if (command) return clamp(firstLine(command), MAX_TITLE_CHARS);
  if (filePath) return clamp(label + ' · ' + basename(filePath), MAX_TITLE_CHARS);
  if (pattern) return clamp(label + ' · ' + pattern, MAX_TITLE_CHARS);
  if (url) return clamp(label + ' · ' + url, MAX_TITLE_CHARS);
  if (query) return clamp(label + ' · ' + query, MAX_TITLE_CHARS);
  return label;
}

/** Файл из ответа UploadFileWrapper (одиночный или элемент files[]). */
function fileFromWrapper(d) {
  if (!d || typeof d !== 'object') return null;
  const url = typeof d.file_wrapper_url === 'string' ? d.file_wrapper_url.trim() : '';
  if (!url) return null;
  return {
    url,
    fileName: String(d.filename || basename(d.sandbox_file_path) || 'file'),
    mime: String(d.content_type || ''),
    sizeLabel: String(d.file_size || ''),
    sandboxPath: String(d.sandbox_file_path || ''),
  };
}

/** Все файлы из payload: { file_wrapper_url } и/или { files: [...] }. */
function filesFromWrapper(d) {
  const out = [];
  if (!d || typeof d !== 'object') return out;
  const one = fileFromWrapper(d);
  if (one) out.push(one);
  if (Array.isArray(d.files)) {
    for (const f of d.files) {
      const x = fileFromWrapper(f);
      if (x && !out.some((o) => o.url === x.url)) out.push(x);
    }
  }
  return out;
}

/**
 * Нормализует payload результата инструмента в человекочитаемый текст.
 *
 * Genspark отдаёт результат по-разному:
 *   {"exit_code":0,"outputs":[{"name":"stdout","text":"…"}]}   ← Bash
 *   {"status":"success","file_wrapper_url":"…"}                ← UploadFileWrapper
 *   {"content":"…"} / просто строка                            ← Read/Grep
 */
function normalizeToolOutput(raw) {
  const out = {
    text: '', exitCode: null, durationMs: null, file: null, files: [], error: '',
  };

  let data = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = safeParse(trimmed);
      data = parsed === null ? trimmed : parsed;
    } else {
      data = trimmed;
    }
  }

  if (typeof data === 'string') {
    out.text = data;
  } else if (Array.isArray(data)) {
    out.text = data.map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object') return String(x.text || x.content || x.output || '');
      return '';
    }).filter(Boolean).join('\n');
  } else if (data && typeof data === 'object') {
    if (Number.isFinite(Number(data.exit_code))) out.exitCode = Number(data.exit_code);
    if (Number.isFinite(Number(data.execution_time_ms))) out.durationMs = Number(data.execution_time_ms);

    // Артефакт: файл залит в хранилище и доступен по короткой ссылке.
    {
      const fl = filesFromWrapper(data);
      if (fl.length) { out.files = fl; out.file = fl[0]; }
    }

    const chunks = [];
    if (Array.isArray(data.outputs)) {
      for (const o of data.outputs) {
        if (!o) continue;
        if (typeof o === 'string') { chunks.push(o); continue; }
        const txt = String(o.text || o.content || o.output || '');
        if (!txt) continue;
        const name = String(o.name || '').toLowerCase();
        chunks.push(name === 'stderr' ? '[stderr] ' + txt : txt);
      }
    }
    if (!chunks.length) {
      const direct = data.content || data.text || data.output || data.result || data.stdout;
      if (typeof direct === 'string') chunks.push(direct);
      else if (direct != null) chunks.push(JSON.stringify(direct, null, 2));
    }
    if (typeof data.error === 'string' && data.error) {
      out.error = data.error;
      if (!chunks.length) chunks.push(data.error);
    }
    out.text = chunks.join('\n');
  }

  out.text = String(out.text || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return out;
}

/** Обрезает вывод до разумного размера для карточки. */
function previewOf(text) {
  let t = String(text || '');
  if (!t) return { preview: '', truncated: false, totalLines: 0 };
  const lines = t.split('\n');
  const totalLines = lines.length;
  let truncated = false;

  if (lines.length > MAX_PREVIEW_LINES) {
    const head = lines.slice(0, MAX_PREVIEW_LINES - 10).join('\n');
    const tail = lines.slice(-8).join('\n');
    t = head + '\n…\n' + tail;
    truncated = true;
  }
  if (t.length > MAX_PREVIEW_CHARS) {
    t = t.slice(0, MAX_PREVIEW_CHARS) + '…';
    truncated = true;
  }
  return { preview: t, truncated, totalLines };
}

/** Текст из «живых» outputs (пока инструмент ещё выполняется). */
function textFromOutputs(outputs) {
  if (!Array.isArray(outputs) || !outputs.length) return '';
  const chunks = [];
  for (const o of outputs) {
    if (!o) continue;
    if (typeof o === 'string') { chunks.push(o); continue; }
    const txt = String(o.text || o.content || o.output || '');
    if (!txt) continue;
    const name = String(o.name || '').toLowerCase();
    chunks.push(name === 'stderr' ? '[stderr] ' + txt : txt);
  }
  return chunks.join('\n').replace(/\r\n/g, '\n');
}

/**
 * Собирает карточку шага.
 *
 * @param {object} call  { id, name, args }                  — из assistant-части
 * @param {object} res   { content, sessionState, done }     — tool-часть, либо null
 * @param {number} index порядковый номер шага
 */
function buildStep(call, res, index) {
  const tool = String((call && call.name) || '').trim();
  const rawArgs = String((call && call.args) || '');
  const argsObj = safeParse(rawArgs);

  const step = {
    id: String((call && call.id) || '') || `step-${index}`,
    index: Number(index) || 0,
    tool,
    kind: TOOL_KINDS[tool] || 'generic',
    label: TOOL_LABELS[tool] || tool || 'Шаг',
    title: buildTitle(tool, rawArgs),
    status: 'pending',
    command: pickArgString(rawArgs, 'command') || '',
    filePath: pickArgString(rawArgs, 'file_path')
      || pickArgString(rawArgs, 'path')
      || pickArgString(rawArgs, 'notebook_path')
      || pickArgString(rawArgs, 'sandbox_file_path')
      || '',
    pattern: pickArgString(rawArgs, 'pattern') || '',
    url: pickArgString(rawArgs, 'url') || '',
    // Запрос поиска (web_search / WebSearch) — нужен для подписи строки.
    query: pickArgString(rawArgs, 'query') || pickArgString(rawArgs, 'q') || '',
    // description пишет сама модель — это «человеческий» заголовок шага.
    desc: (pickArgString(rawArgs, 'description') || '').trim(),
    // Позиция шага в склеенном тексте ответа (см. collectSteps): по ней
    // рендерер вставляет группу шагов МЕЖДУ абзацами, как в Claude.
    textOffset: 0,
    textAnchor: '',
    args: argsObj && typeof argsObj === 'object' ? argsObj : null,
    preview: '',
    truncated: false,
    totalLines: 0,
    exitCode: null,
    durationMs: null,
    file: null,
    failed: false,
    error: '',
  };

  // Вызов ещё стримится (аргументы не дописаны) — шаг «готовится».
  if (!res) {
    step.status = (call && call.complete) ? 'running' : 'pending';
  }

  if (res) {
    // Пока инструмент выполняется, сервер шлёт outputs по кускам — показываем
    // их сразу, не дожидаясь message_result.
    const liveOutputs = res.sessionState && Array.isArray(res.sessionState.outputs)
      ? res.sessionState.outputs
      : null;

    let norm;
    if (res.done && typeof res.content === 'string' && res.content) {
      norm = normalizeToolOutput(res.content);
    } else {
      norm = {
        text: textFromOutputs(liveOutputs),
        exitCode: null,
        durationMs: null,
        file: null,
        error: '',
      };
    }

    // session_state надёжнее, чем частичный разбор content.
    const ss = res.sessionState || {};
    if (Number.isFinite(Number(ss.exit_code))) norm.exitCode = Number(ss.exit_code);
    if (Number.isFinite(Number(ss.execution_time_ms))) norm.durationMs = Number(ss.execution_time_ms);
    if (!norm.text && liveOutputs) norm.text = textFromOutputs(liveOutputs);
    {
      const fl = filesFromWrapper(ss);
      const have = Array.isArray(norm.files) ? norm.files : [];
      for (const f of fl) if (!have.some((h) => h.url === f.url)) have.push(f);
      norm.files = have;
      if (!norm.file && have.length) norm.file = have[0];
    }

    const pv = previewOf(norm.text);
    step.preview = pv.preview;
    step.truncated = pv.truncated;
    step.totalLines = pv.totalLines;
    step.exitCode = norm.exitCode;
    step.durationMs = norm.durationMs;
    step.file = norm.file;
    step.files = Array.isArray(norm.files) && norm.files.length ? norm.files : (norm.file ? [norm.file] : []);
    step.error = norm.error;
    step.failed = (norm.exitCode != null && norm.exitCode !== 0) || !!norm.error;
    step.status = res.done ? (step.failed ? 'failed' : 'done') : 'running';
  }

  // У команды без description заголовок — сама команда; если её ещё не
  // прислали, но шаг уже бежит, не оставляем пустую строку.
  if (!step.title) step.title = step.label;

  return step;
}

/**
 * Собирает список шагов из состояния протокола.
 *
 * @param {object} state состояние из protocol.js: { messages, order }
 */
function collectSteps(state) {
  if (!state || !Array.isArray(state.order)) return [];

  // Индекс результатов по tool_call_id — это и есть правильный «ключ связи».
  const resultsById = new Map();
  for (const key of state.order) {
    const msg = state.messages[key];
    if (!msg || msg.role !== 'tool') continue;
    const id = String(msg.toolCallId || msg.id || '');
    if (!id) continue;
    resultsById.set(id, msg);
  }

  const steps = [];
  let index = 0;
  // Длина склеенного текста ответа ровно так, как его склеивает
  // protocol.assistantText(): непустые content через '\n\n'.
  let textLen = 0;
  let anchor = '';
  for (const key of state.order) {
    const msg = state.messages[key];
    if (!msg) continue;
    if (msg.role === 'tool' || msg.role === 'function') continue;
    const content = String(msg.content || '');
    if (content) {
      textLen += (textLen > 0 ? 2 : 0) + content.length;
      const trimmed = content.replace(/\s+$/, '');
      anchor = trimmed.slice(-80);
    }
    if (msg.role !== 'assistant') continue;
    const calls = msg.toolCalls || {};
    const indices = Object.keys(calls)
      .map(Number)
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    for (const i of indices) {
      const call = calls[i];
      if (!call || !(call.name || call.args)) continue;
      const res = call.id ? (resultsById.get(String(call.id)) || null) : null;
      const st = buildStep(call, res, index);
      st.textOffset = textLen;
      st.textAnchor = anchor;
      steps.push(st);
      index += 1;
    }
  }
  return steps;
}

/** Все файловые артефакты, созданные инструментами за ответ. */
function collectFiles(steps) {
  const out = [];
  const seen = new Set();
  for (const s of steps || []) {
    if (!s) continue;
    const list = Array.isArray(s.files) && s.files.length ? s.files : (s.file ? [s.file] : []);
    for (const f of list) {
      if (!f || !f.url || seen.has(f.url)) continue;
      seen.add(f.url);
      out.push(f);
    }
  }
  return out;
}

/**
 * Короткая подпись текущего шага для «мигающего лого».
 * Берём последний выполняющийся шаг, иначе последний вообще.
 */
function currentStepTitle(steps) {
  const list = Array.isArray(steps) ? steps : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const s = list[i];
    if (s && (s.status === 'running' || s.status === 'pending') && s.title) return s.title;
  }
  const last = list[list.length - 1];
  return (last && last.title) || '';
}

/**
 * Сдвигает textOffset шагов на длину уже накопленного текста (подхват
 * ответа другим аккаунтом: его текст дописывается после carryText).
 */
function shiftSteps(steps, baseText) {
  const list = Array.isArray(steps) ? steps : [];
  const base = String(baseText || '');
  if (!base || !list.length) return list;
  const add = base.length + 2;
  return list.map((s) => (s ? { ...s, textOffset: (Number(s.textOffset) || 0) + add } : s));
}

export {
  shiftSteps,
  TOOL_LABELS,
  TOOL_KINDS,
  pickArgString,
  buildTitle,
  normalizeToolOutput,
  previewOf,
  buildStep,
  collectSteps,
  collectFiles,
  currentStepTitle,
};
