
// ─── Конечный автомат протокола Genspark Agent API ───────────────────────────
//
// Реализация восстановлена из реального HAR-дампа сессии (150 событий,
// POST /api/agent/ask_proxy → text/event-stream).
//
// ─── Типы событий ────────────────────────────────────────────────────────────
//
//   project_field             состояние проекта/сессии (sandbox_status, name,
//                             token_usage, status=FINISHED)
//   message_start             начало сообщения (role=assistant | tool)
//   message_field             установка целого поля (tool_calls[i], content,
//                             session_state.exit_code, …)
//   message_field_delta       СТРИМИНГ по кускам (content, tool-аргументы)
//   message_field_append_item добавление элемента в массив (outputs)
//   message_result            финальная полная версия сообщения + метаданные
//   agent_notification        keepalive — НЕ конец ответа, просто пинг
//
// ─── Правила сборки ──────────────────────────────────────────────────────────
//
//   • Текст = конкатенация всех `delta` с одинаковыми (message_id, field_name)
//     в порядке `_event_index`.
//   • `message_result.message.content` — авторитетная полная версия.
//   • Конец задачи = project_field { field_name:"status", value:"FINISHED" }.
//   • Конец сообщения = message_result._finish_reason ("stop" | "tool_calls").
//
// ─── Ключевое отличие от прошлой реализации ──────────────────────────────────
//
// Автомат отдаёт наружу ИНКРЕМЕНТАЛЬНЫЕ события (`onDelta` с кусочком текста),
// а не «полную строку целиком на каждый чанк». Раньше при каждой дельте вверх
// по IPC уезжал весь накопленный ответ, рендерер заново прогонял markdown по
// всему тексту и перерисовывал сообщение — отсюда рывки и «кривой» вывод.
// Теперь по IPC едет только приращение, а UI дописывает его в конец.

import * as toolSteps from './tool-steps.js';

/** Порядок сортировки/дедупликации событий. */
function eventIndexOf(ev) {
  const n = Number(ev && ev._event_index);
  return Number.isFinite(n) ? n : -1;
}

function isToolRole(role) {
  return role === 'tool' || role === 'function';
}

/**
 * Создаёт автомат протокола.
 *
 * @param {object} handlers
 *   onText({ messageId, delta, text })  — приращение текста ответа
 *   onReasoning({ messageId, delta, text })
 *   onSteps(steps)                      — карточки шагов изменились
 *   onStatus(patch)                     — статус проекта/песочницы
 *   onFiles(files)                      — появились файловые артефакты
 *   onFinished()                        — project status = FINISHED
 */
function createProtocolState(handlers) {
  const h = handlers || {};

  const state = {
    projectId: null,
    askId: null,
    chatSessionId: null,
    chatSessionName: '',
    title: '',
    sandboxId: '',
    // Code-песочница: {"3000": {url, host, sandbox_id}} — появляется после GetServiceUrl.
    activeServices: null,
    sandboxStatus: '',
    codeName: '',
    status: null,
    finished: false,
    tokenUsage: null,
    gensparkGit: null,
    // messages[message_id] = { id, role, toolCallId, content, reasoning,
    //                          toolCalls, sessionState, done, finishReason }
    messages: Object.create(null),
    order: [],
    // Последнее assistant-сообщение, в которое льётся текст.
    currentAssistantId: null,
    rawEvents: 0,
    lastEventIndex: -1,
    // Защита от повторной обработки одного и того же события: сервер при
    // переподключении может прислать хвост заново (last_seen_event_index).
    seenIndices: new Set(),
  };

  /** Получить (или завести) сообщение по id. */
  const ensureMessage = (rawId, role, toolCallId) => {
    const id = String(rawId || '');
    if (!id) return null;
    let msg = state.messages[id];
    if (!msg) {
      // Если роль не пришла — выводим её из формы id: `toolu_…` всегда tool.
      let inferred = role || '';
      if (!inferred && /^toolu[_-]/i.test(id)) inferred = 'tool';
      msg = {
        id,
        role: inferred || 'assistant',
        toolCallId: toolCallId || (/^toolu[_-]/i.test(id) ? id : null),
        content: '',
        reasoning: '',
        toolCalls: Object.create(null),
        sessionState: Object.create(null),
        done: false,
        finishReason: null,
      };
      state.messages[id] = msg;
      state.order.push(id);
    }
    if (role && msg.role !== role) msg.role = role;
    if (toolCallId && !msg.toolCallId) msg.toolCallId = toolCallId;
    return msg;
  };

  let stepsDirty = false;
  const markStepsDirty = () => { stepsDirty = true; };

  // URL артефактов, о которых потребитель уже знает. Без этого каждый
  // flushSteps переотправлял ВЕСЬ список файлов заново, и в UI один и тот
  // же report.csv появлялся столько раз, сколько было пересборок шагов.
  const announcedFiles = new Set();

  /** Пересборка карточек шагов — вызывается не чаще, чем нужно. */
  const flushSteps = () => {
    if (!stepsDirty) return;
    stepsDirty = false;
    let steps = [];
    try { steps = toolSteps.collectSteps(state); }
    catch (_) { return; } // шаги — украшение, их сбой не должен рушить поток
    state.steps = steps;
    if (h.onSteps) h.onSteps(steps);
    if (h.onFiles) {
      // Отдаём только НОВЫЕ файлы — приращением, как и текст.
      const fresh = toolSteps.collectFiles(steps)
        .filter((f) => f && f.url && !announcedFiles.has(f.url));
      if (fresh.length) {
        for (const f of fresh) announcedFiles.add(f.url);
        h.onFiles(fresh);
      }
    }
  };

  /** Разбор `tool_calls[N]` и `tool_calls[N].function.arguments`. */
  const toolCallIndex = (fieldName) => {
    const m = /^tool_calls\[(\d+)\]/.exec(String(fieldName || ''));
    return m ? Number(m[1]) : null;
  };

  /** `session_state.foo.bar` → записать в msg.sessionState по пути. */
  const setSessionStatePath = (target, pathStr, value) => {
    const parts = String(pathStr || '').split('.').filter(Boolean);
    if (!parts.length) return;
    let cur = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const k = parts[i];
      if (!cur[k] || typeof cur[k] !== 'object') cur[k] = Object.create(null);
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
  };

  // ── Обработчики отдельных типов событий ────────────────────────────────

  const onProjectField = (ev) => {
    const field = String(ev.field_name || '');
    const value = ev.field_value;

    if (ev.id && !state.projectId) state.projectId = ev.id;

    switch (field) {
      case 'status': {
        state.status = value;
        if (String(value).toUpperCase() === 'FINISHED') {
          state.finished = true;
          if (h.onFinished) h.onFinished();
        }
        if (h.onStatus) h.onStatus({ status: value });
        return;
      }
      case 'name':
      case 'title': {
        const t = String(value || '').trim();
        if (t) {
          state.title = t;
          if (h.onStatus) h.onStatus({ title: t });
        }
        return;
      }
      case 'session_state.sandbox_status': {
        state.sandboxStatus = String(value || '');
        // Пустая строка = песочница готова. Это важный сигнал для UI:
        // «поднимаю окружение» сменяется на обычное «думаю».
        if (h.onStatus) h.onStatus({ sandboxStatus: state.sandboxStatus });
        return;
      }
      case 'session_state.sandbox_id':
        state.sandboxId = String(value || '');
        if (h.onStatus) h.onStatus({ sandboxId: state.sandboxId });
        return;
      case 'session_state.active_services': {
        // Может прийти объектом или JSON-строкой.
        let services = value;
        if (typeof services === 'string') {
          try { services = JSON.parse(services); } catch (_) { services = null; }
        }
        state.activeServices = (services && typeof services === 'object') ? services : null;
        if (h.onStatus) h.onStatus({ activeServices: state.activeServices, sandboxId: state.sandboxId });
        return;
      }
      case 'session_state.meta.code_name':
        state.codeName = String(value || '');
        return;
      case 'session_state.current_chat_session_id':
        state.chatSessionId = String(value || '');
        if (h.onStatus) h.onStatus({ chatSessionId: state.chatSessionId });
        return;
      case 'session_state.current_chat_session_name':
        state.chatSessionName = String(value || '');
        return;
      case 'session_state.token_usage':
        state.tokenUsage = value;
        if (h.onStatus) h.onStatus({ tokenUsage: value });
        return;
      case 'session_state.genspark_git':
        state.gensparkGit = value;
        return;
      default:
        return;
    }
  };

  const onMessageStart = (ev) => {
    const role = ev.role || 'assistant';
    const msg = ensureMessage(ev.message_id, role, ev.tool_call_id);
    if (!msg) return;
    msg.done = false;
    if (ev.ask_id) state.askId = ev.ask_id;
    if (ev.project_id) state.projectId = ev.project_id;
    if (!isToolRole(role)) {
      // Новое assistant-сообщение: дальнейший текст течёт в него.
      state.currentAssistantId = msg.id;
    } else {
      // Начал выполняться инструмент — карточка должна стать «running».
      markStepsDirty();
      flushSteps();
    }
  };

  const onMessageFieldDelta = (ev) => {
    const msg = ensureMessage(ev.message_id);
    if (!msg) return;
    const field = String(ev.field_name || '');
    const delta = ev.delta == null ? '' : String(ev.delta);

    if (field === 'content') {
      // В tool-сообщении content — это сериализованный JSON вывода
      // инструмента. В чат его лить нельзя: он уходит в карточку шага.
      msg.content += delta;
      if (isToolRole(msg.role)) {
        markStepsDirty();
        return;
      }
      if (!delta) return;
      if (h.onText) h.onText({ messageId: msg.id, delta, text: msg.content });
      return;
    }

    if (field === 'reasoning_delta' || field === 'reasoning_content') {
      msg.reasoning += delta;
      if (isToolRole(msg.role)) return;
      if (!delta) return;
      if (h.onReasoning) {
        h.onReasoning({ messageId: msg.id, delta, text: msg.reasoning });
      }
      return;
    }

    if (field.startsWith('tool_calls[') && field.endsWith('.function.arguments')) {
      const idx = toolCallIndex(field);
      if (idx == null) return;
      const call = msg.toolCalls[idx] || { id: '', name: '', args: '', complete: false };
      call.args = (call.args || '') + delta;
      msg.toolCalls[idx] = call;
      markStepsDirty();
    }
  };

  const onMessageField = (ev) => {
    const msg = ensureMessage(ev.message_id);
    if (!msg) return;
    const field = String(ev.field_name || '');
    const value = ev.field_value;

    if (field === 'content' && typeof value === 'string') {
      if (isToolRole(msg.role)) {
        msg.content = value;
        markStepsDirty();
        return;
      }
      // Фиксация полного content. Отдаём наверх только «хвост», которого
      // ещё не видел UI, — иначе текст продублируется.
      const prev = msg.content || '';
      msg.content = value;
      if (value.length > prev.length && value.startsWith(prev)) {
        const tail = value.slice(prev.length);
        if (tail && h.onText) {
          h.onText({ messageId: msg.id, delta: tail, text: value });
        }
      } else if (value !== prev && h.onText) {
        // Расхождение (редко): просим UI заменить текст сообщения целиком.
        h.onText({ messageId: msg.id, delta: '', text: value, replace: true });
      }
      return;
    }

    if (field === 'reasoning_content' && typeof value === 'string') {
      if (isToolRole(msg.role)) return;
      const prev = msg.reasoning || '';
      msg.reasoning = value;
      if (h.onReasoning && value !== prev) {
        const tail = value.startsWith(prev) ? value.slice(prev.length) : '';
        h.onReasoning({
          messageId: msg.id,
          delta: tail,
          text: value,
          replace: !tail,
        });
      }
      return;
    }

    if (/^tool_calls\[\d+\]$/.test(field) && value && typeof value === 'object') {
      const idx = toolCallIndex(field);
      if (idx == null) return;
      const fn = value.function || {};
      const call = msg.toolCalls[idx] || { id: '', name: '', args: '', complete: false };
      if (typeof value.id === 'string' && value.id) call.id = value.id;
      if (typeof fn.name === 'string' && fn.name) call.name = fn.name;
      // `arguments: null` — норма для стартового объекта: аргументы придут
      // дельтами. Перезаписываем только если строка не короче накопленной.
      if (typeof fn.arguments === 'string'
          && fn.arguments.length >= String(call.args || '').length) {
        call.args = fn.arguments;
      }
      msg.toolCalls[idx] = call;
      markStepsDirty();
      return;
    }

    if (field.startsWith('session_state.')) {
      setSessionStatePath(msg.sessionState, field.slice('session_state.'.length), value);
      markStepsDirty();
    }
  };

  const onMessageFieldAppendItem = (ev) => {
    const msg = ensureMessage(ev.message_id);
    if (!msg) return;
    const field = String(ev.field_name || '');
    if (!field.startsWith('session_state.')) return;
    const path = field.slice('session_state.'.length);
    const parts = path.split('.').filter(Boolean);
    let cur = msg.sessionState;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const k = parts[i];
      if (!cur[k] || typeof cur[k] !== 'object') cur[k] = Object.create(null);
      cur = cur[k];
    }
    const leaf = parts[parts.length - 1];
    if (!Array.isArray(cur[leaf])) cur[leaf] = [];
    cur[leaf].push(ev.field_value);
    markStepsDirty();
  };

  const onMessageResult = (ev) => {
    const payload = ev.message || {};
    const role = payload.role || '';
    const id = payload.id || payload.message_id || ev.message_id;
    const msg = ensureMessage(id, role, payload.tool_call_id);
    if (!msg) return;

    const ss = payload.session_state;
    if (ss && typeof ss === 'object') {
      for (const [k, v] of Object.entries(ss)) msg.sessionState[k] = v;
      if (typeof ss._finish_reason === 'string') msg.finishReason = ss._finish_reason;
      if (typeof ss._llm_model === 'string') state.model = ss._llm_model;
      if (ss._llm_usage) state.usage = ss._llm_usage;
    }

    if (Array.isArray(payload.tool_calls)) {
      payload.tool_calls.forEach((tc, i) => {
        if (!tc) return;
        const call = msg.toolCalls[i] || { id: '', name: '', args: '', complete: false };
        if (typeof tc.id === 'string' && tc.id) call.id = tc.id;
        const fn = tc.function || {};
        if (typeof fn.name === 'string' && fn.name) call.name = fn.name;
        if (typeof fn.arguments === 'string'
            && fn.arguments.length >= String(call.args || '').length) {
          call.args = fn.arguments;
        }
        call.complete = true;
        msg.toolCalls[i] = call;
      });
    }
    // Все вызовы этого сообщения объявлены — аргументы больше не растут.
    for (const k of Object.keys(msg.toolCalls)) msg.toolCalls[k].complete = true;

    msg.done = true;

    if (isToolRole(role)) {
      if (typeof payload.content === 'string') msg.content = payload.content;
      markStepsDirty();
      flushSteps();
      return;
    }

    // Авторитетная полная версия текста: досылаем недостающий хвост.
    if (typeof payload.content === 'string') {
      const prev = msg.content || '';
      const full = payload.content;
      if (full.length > prev.length && full.startsWith(prev)) {
        const tail = full.slice(prev.length);
        msg.content = full;
        if (tail && h.onText) h.onText({ messageId: msg.id, delta: tail, text: full });
      } else if (full !== prev && full.length >= prev.length) {
        msg.content = full;
        if (h.onText) h.onText({ messageId: msg.id, delta: '', text: full, replace: true });
      }
    }
    if (typeof payload.reasoning_content === 'string' && payload.reasoning_content) {
      msg.reasoning = payload.reasoning_content;
      if (h.onReasoning) {
        h.onReasoning({
          messageId: msg.id, delta: '', text: msg.reasoning, replace: true,
        });
      }
    }

    markStepsDirty();
    flushSteps();
    if (h.onMessageDone) {
      h.onMessageDone({ messageId: msg.id, finishReason: msg.finishReason });
    }
  };

  /** Обработать одно разобранное событие. */
  const handleEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return;

    // Дедупликация по _event_index: при докачке хвоста сервер может
    // повторить уже обработанные события.
    const idx = eventIndexOf(ev);
    if (idx >= 0) {
      if (state.seenIndices.has(idx)) return;
      state.seenIndices.add(idx);
      if (idx > state.lastEventIndex) state.lastEventIndex = idx;
    }

    state.rawEvents += 1;
    if (ev.project_id && !state.projectId) state.projectId = ev.project_id;

    switch (ev.type) {
      case 'project_start':
        state.projectId = ev.id || state.projectId;
        if (h.onStatus) h.onStatus({ projectId: state.projectId });
        break;
      case 'project_field':
        onProjectField(ev);
        break;
      case 'message_start':
        onMessageStart(ev);
        break;
      case 'message_field_delta':
        onMessageFieldDelta(ev);
        break;
      case 'message_field':
        onMessageField(ev);
        break;
      case 'message_field_append_item':
        onMessageFieldAppendItem(ev);
        break;
      case 'message_result':
        onMessageResult(ev);
        break;
      case 'agent_notification':
        // keepalive — соединение живо, данных нет. Это НЕ конец ответа.
        if (h.onNotification) h.onNotification(ev);
        break;
      default:
        break;
    }

    if (h.onEvent) h.onEvent(ev, state);
  };

  return {
    state,
    handleEvent,
    /** Применить накопленные изменения шагов (вызывать по таймеру/в конце). */
    flushSteps: () => { flushSteps(); },
    markStepsDirty,
    /** Склеенный текст ответа: только assistant-сообщения, по порядку. */
    assistantText() {
      const parts = [];
      for (const id of state.order) {
        const m = state.messages[id];
        if (!m || isToolRole(m.role)) continue;
        const c = String(m.content || '');
        if (c) parts.push(c);
      }
      return parts.join('\n\n');
    },
    assistantReasoning() {
      const parts = [];
      for (const id of state.order) {
        const m = state.messages[id];
        if (!m || isToolRole(m.role)) continue;
        const r = String(m.reasoning || '');
        if (r) parts.push(r);
      }
      return parts.join('\n\n');
    },
    steps() {
      try { return toolSteps.collectSteps(state); } catch (_) { return []; }
    },
  };
}

export { createProtocolState, eventIndexOf };
