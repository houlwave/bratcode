// Надёжная правка файлов для ИИ-агента: multiedit (атомарно), patch (unified diff и "*** Begin Patch").
// Чистые функции без доступа к диску: agent.js читает/пишет файлы, здесь только вычисления и понятные ошибки.
import crypto from 'node:crypto'

export const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8)
export class EditError extends Error { constructor(msg, http = 409) { super(msg); this.http = http } }

const lineAt = (s, idx) => s.slice(0, idx).split('\n').length
const occurrences = (s, f) => { const r = []; let i = 0; while ((i = s.indexOf(f, i)) >= 0) { r.push(i); i += Math.max(1, f.length) } return r }
const quote = (t) => String(t).split('\n').slice(0, 8).map((l) => '      | ' + l.slice(0, 160)).join('\n')
const norm = (s) => s.replace(/\s+/g, ' ').trim()

// Подсказка, когда find не найден: чем отличается и где похожее место
export function similar(src, find) {
  const lines = src.split('\n'); const fl = find.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!fl.length) return null
  const first = fl[0]
  const n = fl.length
  // 1) то же, но отличаются пробелы/отступы/переводы строк
  const nf = norm(find)
  if (nf.length >= 3 && norm(src).includes(nf)) {
    const idx = lines.findIndex((l) => l.trim() === first || norm(l).includes(norm(first)))
    if (idx >= 0) return { why: 'the text exists, but whitespace (indentation / tabs / line breaks) differs', start: idx + 1, text: lines.slice(idx, idx + Math.min(n, 6)).join('\n') }
  }
  // 2) первая строка совпала, дальше отличается
  let idx = lines.findIndex((l) => l.trim() === first)
  if (idx >= 0) return { why: 'the FIRST line of your text exists, but the next lines differ', start: idx + 1, text: lines.slice(idx, idx + Math.min(n, 6)).join('\n') }
  // 3) самая похожая строка по словам
  const words = new Set(first.split(/[^\w$]+/).filter((w) => w.length > 2))
  if (words.size) {
    let best = -1, bs = 0
    lines.forEach((l, i) => { let sc = 0; for (const w of words) if (l.includes(w)) sc++; sc /= words.size; if (sc > bs) { bs = sc; best = i } })
    if (best >= 0 && bs >= 0.5) return { why: 'a similar line exists (check spelling / quotes / spaces)', start: best + 1, text: lines.slice(best, best + Math.min(n, 4)).join('\n') }
  }
  return null
}

// edits: [{find, replace, all}] или [{start, end, replace}] (замена диапазона строк, 1-based, включительно)
export function applyEdits(src0, edits, label = 'file') {
  if (!Array.isArray(edits) || !edits.length) throw new EditError('no edits given (pass edits_b64=<base64 of JSON [{"find":"..","replace":".."}]> or find1/replace1, find2/replace2 ...)', 400)
  const crlf = src0.includes('\r\n')
  let cur = crlf ? src0.replace(/\r\n/g, '\n') : src0
  const rep = []
  edits.forEach((e, k) => {
    const i = k + 1
    const fail = (m, code = 409) => { throw new EditError(`edit #${i} of ${edits.length} in ${label}: ${m}\n(nothing was changed - fix this edit and resend ALL edits)`, code) }
    let find = e.find, replace = e.replace === undefined || e.replace === null ? '' : String(e.replace)
    if (crlf) { if (find !== undefined) find = String(find).replace(/\r\n/g, '\n'); replace = replace.replace(/\r\n/g, '\n') }
    if (find === undefined && e.start !== undefined) {
      const lines = cur.split('\n'); const s = Number(e.start), en = Number(e.end === undefined ? e.start : e.end)
      const total = cur.endsWith('\n') ? lines.length - 1 : lines.length
      if (!(s >= 1 && en >= s && s <= total + 1)) fail(`bad line range ${e.start}-${e.end} (file has ${total} lines)`, 400)
      const nl = replace === '' ? [] : replace.replace(/\n$/, '').split('\n')
      lines.splice(s - 1, Math.min(en, total) - s + 1, ...nl); cur = lines.join('\n')
      rep.push(`#${i}: replaced lines ${s}-${Math.min(en, total)} with ${nl.length} line(s)`); return
    }
    if (find === undefined) fail('missing "find" (or start/end line range)', 400)
    find = String(find)
    if (find === '') { if (cur === '') { cur = replace; rep.push(`#${i}: filled empty file`); return } fail('"find" is empty', 400) }
    if (find === replace) fail('"find" and "replace" are identical - nothing to do', 400)
    const occ = occurrences(cur, find); const all = e.all === true || e.all === '1' || e.all === 'true' || e.all === 1
    if (occ.length === 0) {
      const s = similar(cur, find)
      fail('text to find was NOT found (it must match exactly, including spaces, tabs and line breaks).' + (s ? `\n    ${s.why} - at line ${s.start}:\n${quote(s.text)}\n    copy the text from /read?path=...&numbered=1 and try again` : '\n    use /grep or /read?numbered=1 to look at the real text first'), 404)
    }
    if (occ.length > 1 && !all) {
      fail(`"find" matches ${occ.length} places (lines ${occ.slice(0, 8).map((x) => lineAt(cur, x)).join(', ')}${occ.length > 8 ? ', ...' : ''}). Add more surrounding lines to make it unique, or set "all":true to replace every one.`)
    }
    const line = lineAt(cur, occ[0])
    if (all) cur = cur.split(find).join(replace)
    else cur = cur.slice(0, occ[0]) + replace + cur.slice(occ[0] + find.length)
    rep.push(`#${i}: replaced ${all ? occ.length : 1} occurrence(s), first at line ${line}`)
  })
  return { out: crlf ? cur.replace(/\n/g, '\r\n') : cur, report: rep }
}

// ---------- patch: unified diff И формат "*** Begin Patch" (apply_patch) ----------
// -> [{op:'update'|'add'|'delete', path, moveTo?, hunks:[{hint, oldStart, lines:[{t,s}]}], content[]}]
export function parsePatch(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n')
  const lines = raw.split('\n'); const files = []
  const clean = (s) => { s = s.trim().replace(/\t.*$/, '').replace(/^"(.*)"$/, '$1'); return s === '/dev/null' ? s : s.replace(/^[ab]\//, '') }
  const trimTail = (h) => { while (h.lines.length && h.lines[h.lines.length - 1].t === ' ' && h.lines[h.lines.length - 1].s === '') h.lines.pop() }
  if (/^\*\*\* Begin Patch/m.test(raw)) {
    let f = null, h = null
    for (const ln of lines) {
      let m
      if ((m = ln.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+)$/))) { f = { op: m[1].toLowerCase(), path: m[2].trim(), hunks: [], content: [] }; files.push(f); h = null; continue }
      if ((m = ln.match(/^\*\*\* Move to:\s*(.+)$/))) { if (f) f.moveTo = m[1].trim(); continue }
      if (/^\*\*\* (Begin Patch|End Patch|End of File)/.test(ln) || !f) continue
      if (f.op === 'add') { if (ln.startsWith('+')) f.content.push(ln.slice(1)); continue }
      if (f.op === 'delete') continue
      if (ln.startsWith('@@')) { h = { hint: ln.replace(/^@@\s*/, '').replace(/\s*@@\s*$/, '').trim(), oldStart: 0, lines: [] }; f.hunks.push(h); continue }
      const t = ln[0]
      if (t === ' ' || t === '+' || t === '-' || ln === '') {
        if (!h) { h = { hint: '', oldStart: 0, lines: [] }; f.hunks.push(h) }
        h.lines.push(ln === '' ? { t: ' ', s: '' } : { t, s: ln.slice(1) })
      }
    }
    files.forEach((x) => x.hunks.forEach(trimTail))
    return files
  }
  let f = null, h = null
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (ln.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) {
      const o = clean(ln.slice(4)), n = clean(lines[i + 1].slice(4)); i++
      f = { op: o === '/dev/null' ? 'add' : n === '/dev/null' ? 'delete' : 'update', path: n === '/dev/null' ? o : n, hunks: [], content: [] }
      files.push(f); h = null; continue
    }
    if (ln.startsWith('diff --git') || /^(index |new file mode|deleted file mode|similarity |rename )/.test(ln)) { if (ln.startsWith('diff --git')) h = null; continue }
    const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/)
    if (m) { if (!f) { f = { op: 'update', path: null, hunks: [], content: [] }; files.push(f) } h = { hint: m[3] || '', oldStart: Number(m[1]), lines: [] }; f.hunks.push(h); continue }
    if (!h || !f) continue
    if (ln.startsWith('\\')) continue
    const t = ln[0]
    if (t === ' ' || t === '+' || t === '-') h.lines.push({ t, s: ln.slice(1) })
    else if (ln === '') h.lines.push({ t: ' ', s: '' })
  }
  files.forEach((x) => { x.hunks.forEach(trimTail); if (x.op === 'add') x.content = x.hunks.flatMap((hh) => hh.lines.filter((l) => l.t === '+').map((l) => l.s)) })
  return files
}

export function applyHunks(src0, hunks, label = 'file') {
  const crlf = src0.includes('\r\n')
  const lines = (crlf ? src0.replace(/\r\n/g, '\n') : src0).split('\n')
  const eqs = [(a, b) => a === b, (a, b) => a.trimEnd() === b.trimEnd(), (a, b) => a.trim() === b.trim()]
  let minPos = 0; const rep = []
  hunks.forEach((h, k) => {
    const old = h.lines.filter((l) => l.t !== '+').map((l) => l.s)
    const adds = h.lines.filter((l) => l.t === '+').length, dels = h.lines.filter((l) => l.t === '-').length
    const endIdx = lines.length - (lines[lines.length - 1] === '' ? 1 : 0)
    let pos = -1, fuzz = 0
    if (!old.length) { pos = h.oldStart ? Math.min(endIdx, Math.max(minPos, h.oldStart)) : endIdx }
    else {
      let from = minPos
      if (h.hint) { const hi = lines.findIndex((l, ix) => ix >= minPos && (l.trim() === h.hint || l.includes(h.hint))); if (hi >= 0) from = hi }
      const want = h.oldStart ? h.oldStart - 1 : from
      for (let f = 0; f < eqs.length && pos < 0; f++) {
        let best = -1, bd = 1e9
        for (let i = from; i + old.length <= lines.length; i++) {
          let ok = true; for (let j = 0; j < old.length; j++) if (!eqs[f](lines[i + j], old[j])) { ok = false; break }
          if (ok) { const d = Math.abs(i - want); if (d < bd) { bd = d; best = i } }
        }
        if (best >= 0) { pos = best; fuzz = f }
      }
    }
    if (pos < 0) {
      const key = (old.find((x) => x.trim().length >= 6) || old[0] || '').trim(); let near = ''
      if (key) { const ni = lines.findIndex((l) => l.includes(key.slice(0, 30))); if (ni >= 0) near = `\n    the closest text in the file is at line ${ni + 1}:\n${quote(lines.slice(ni, ni + Math.min(old.length, 6)).join('\n'))}` }
      throw new EditError(`hunk #${k + 1} of ${hunks.length} in ${label}: the context/removed lines were NOT found in the file.\n    looking for:\n${quote(old.join('\n'))}${near}\n(nothing was changed - re-read the file with /read?numbered=1 and make the patch from the real text)`)
    }
    const out = []; let oi = 0
    for (const l of h.lines) { if (l.t === ' ') out.push(lines[pos + oi++]); else if (l.t === '-') oi++; else out.push(l.s) }
    lines.splice(pos, old.length, ...out)
    minPos = pos + out.length
    rep.push(`hunk #${k + 1}: applied at line ${pos + 1} (+${adds} -${dels})${fuzz ? ' [matched ignoring whitespace differences]' : ''}`)
  })
  const res = lines.join('\n')
  return { out: crlf ? res.replace(/\n/g, '\r\n') : res, report: rep }
}
