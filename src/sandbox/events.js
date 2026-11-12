// Шина событий агента: таймлайн действий (как в opencode), стрим в IDE по SSE/poll.
import { EventEmitter } from 'node:events'

export const bus = new EventEmitter()
bus.setMaxListeners(100)
export const timeline = []          // последние действия
export const msgLog = []            // кольцевой буфер сообщений (poll-фолбэк)
export const state = { paused: false, seq: 0, itemSeq: 0, active: new Map(), inbox: [], lastActivity: 0 }
const MAX_OUT = 30_000
const SEND_OUT = 6_000
const priv = new WeakMap()          // служебные поля (таймеры/буфер), не попадают в JSON

// публичная копия элемента (без служебных полей, вывод обрезан)
const pub = (it) => ({ ...it, out: it.out.length > SEND_OUT ? '…' + it.out.slice(-SEND_OUT) : it.out })

function push(m) {
  m.seq = ++state.seq
  state.lastActivity = Date.now()
  msgLog.push(m); if (msgLog.length > 1500) msgLog.shift()
  bus.emit('msg', m)
}

export function begin(kind, title, extra = {}) {
  const it = { id: ++state.itemSeq, t: Date.now(), kind, title: String(title).slice(0, 600), status: 'running', out: '', ...extra }
  priv.set(it, { buf: '', timer: null })
  timeline.push(it); if (timeline.length > 150) timeline.shift()
  push({ ev: 'item', item: pub(it) })
  return it
}
// стриминг вывода: копим и отправляем пачками раз в 120мс
export function append(it, text) {
  if (!text) return
  if (it.out.length < MAX_OUT) it.out += text.slice(0, MAX_OUT - it.out.length)
  const p = priv.get(it) || (priv.set(it, { buf: '', timer: null }), priv.get(it))
  p.buf += text
  if (!p.timer) p.timer = setTimeout(() => flush(it), 120)
}
function flush(it) {
  const p = priv.get(it); if (!p) return
  clearTimeout(p.timer); p.timer = null
  if (p.buf) { push({ ev: 'append', id: it.id, text: p.buf.slice(-8000) }); p.buf = '' }
}
export function finish(it, ok, extra = {}) {
  flush(it)
  Object.assign(it, { status: ok ? 'ok' : 'err', ms: Date.now() - it.t }, extra)
  state.active.delete(it.id)
  push({ ev: 'item', item: pub(it) })
  return it
}
export function update(it, extra) { Object.assign(it, extra); push({ ev: 'item', item: pub(it) }) }
export function say(text) { const it = begin('say', 'say'); it.out = String(text).slice(0, 4000); return finish(it, true) }
export function setPaused(v) { state.paused = !!v; push({ ev: 'paused', paused: state.paused }) }
export const snapshot = () => ({ ev: 'snapshot', items: timeline.slice(-100).map(pub), paused: state.paused, seq: state.seq })
export function clearTimeline() { timeline.length = 0; push({ ev: 'cleared' }) }
export function killAll() {
  let n = 0
  for (const [, kill] of state.active) { try { kill(); n++ } catch {} }
  return n
}
// сообщение от пользователя агенту: будет доставлено в ответе на его следующую команду
export function userMessage(text) {
  const it = begin('user', 'user', { pending: true }); it.out = String(text).slice(0, 2000)
  finish(it, true)
  state.inbox.push({ it, text: it.out })
  return it
}
export function takeInbox() {
  const m = state.inbox.splice(0)
  for (const x of m) update(x.it, { pending: false, delivered: Date.now() })
  return m.map((x) => x.text)
}

// ---------- построчный diff (LCS), для write/edit ----------
export function lineDiff(before, after, ctx = 3, maxLines = 500) {
  const a = before === null ? [] : before.split('\n'), b = after.split('\n')
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const ma = a.slice(s, ea), mb = b.slice(s, eb)
  let mid = []
  if (ma.length * mb.length <= 1_000_000) {
    const n = ma.length, m = mb.length
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ma[i] === mb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    let i = 0, j = 0
    while (i < n && j < m) {
      if (ma[i] === mb[j]) { mid.push([' ', ma[i]]); i++; j++ }
      else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push(['-', ma[i++]])
      else mid.push(['+', mb[j++]])
    }
    while (i < n) mid.push(['-', ma[i++]])
    while (j < m) mid.push(['+', mb[j++]])
  } else { mid = [...ma.map((x) => ['-', x]), ...mb.map((x) => ['+', x])] }
  const ops = [...a.slice(0, s).map((x) => [' ', x]), ...mid, ...a.slice(ea).map((x) => [' ', x])]
  let added = 0, removed = 0
  for (const [k] of ops) { if (k === '+') added++; else if (k === '-') removed++ }
  // оставляем контекст вокруг изменений
  const keep = new Uint8Array(ops.length)
  ops.forEach(([k], i) => { if (k !== ' ') for (let d = -ctx; d <= ctx; d++) if (ops[i + d]) keep[i + d] = 1 })
  const lines = []; let skipped = 0
  ops.forEach((o, i) => {
    if (keep[i]) { if (skipped) { lines.push(['…', `${skipped} неизменённых строк`]); skipped = 0 } lines.push(o) } else skipped++
  })
  const total = lines.length
  return { added, removed, isNew: before === null, lines: lines.slice(0, maxLines), more: Math.max(0, total - maxLines) }
}

export function killItem(id) {
  const k = state.active.get(Number(id)); if (!k) return false
  try { k() } catch {}
  return true
}
