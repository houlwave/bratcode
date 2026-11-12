// Навигация по коду для ИИ-агента: grep / glob / tree / outline / symbols / refs / diagnostics + проверка синтаксиса.
// Всё возвращает текст с лимитами и подсказкой, как сузить запрос. Без внешних зависимостей.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.wrangler', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'coverage', '_attachments', '.agent-logs', '.agent-shots', '.agent-memory'])
const MAX_FILE = 1_500_000
const CODE_EXT = /\.(m?[jt]sx?|cjs|vue|svelte|py|go|rs|java|kt|cs|swift|dart|scala|c|h|cpp|hpp|cc|rb|php|sh|bash|css|scss|less|md|html?|sql|json|ya?ml|toml|txt|xml|svg)$/i
const isBinary = (buf) => buf.subarray(0, 8000).includes(0)

// ---------- glob ----------
export function globToRe(g) {
  let re = '', i = 0, depth = 0
  while (i < g.length) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue } re += '.*'; i += 2; continue }
      re += '[^/]*'; i++
    } else if (c === '?') { re += '[^/]'; i++ }
    else if (c === '{') { re += '(?:'; depth++; i++ }
    else if (c === '}' && depth) { re += ')'; depth--; i++ }
    else if (c === ',' && depth) { re += '|'; i++ }
    else { re += c.replace(/[.+^$()|[\]\\]/g, '\\$&'); i++ }
  }
  return new RegExp('^' + re + '$', 'i')
}
function splitSpec(spec) { // запятая/пробел, но не внутри {}
  const out = []; let cur = '', d = 0
  for (const c of String(spec)) { if (c === '{') d++; if (c === '}') d = Math.max(0, d - 1); if ((c === ',' || /\s/.test(c)) && !d) { if (cur) out.push(cur); cur = '' } else cur += c }
  if (cur) out.push(cur); return out
}
// -> null (всё подходит) или функция (относительныйПуть) => bool
export function matcher(spec) {
  if (!spec) return null
  const pos = [], neg = []
  for (let s of splitSpec(spec)) {
    const n = s.startsWith('!'); if (n) s = s.slice(1)
    s = s.replace(/^\.?\//, '')
    const slash = s.includes('/')
    const re = globToRe(s)
    const t = (rel) => (slash ? re.test(rel) : re.test(rel.split('/').pop()))
    ;(n ? neg : pos).push(t)
  }
  return (rel) => (pos.length ? pos.some((f) => f(rel)) : true) && !neg.some((f) => f(rel))
}

// ---------- символы ----------
const LANGS = {
  js: [
    ['class', /^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/],
    ['function', /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/],
    ['const-fn', /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/],
    ['interface', /^(\s*)(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/],
    ['type', /^(\s*)(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/],
    ['enum', /^(\s*)(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/],
    ['const', /^()(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/],
    ['method', /^(\s{2,})(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\*?[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/],
  ],
  py: [['class', /^(\s*)class\s+(\w+)/], ['function', /^(\s*)(?:async\s+)?def\s+(\w+)/]],
  go: [['function', /^()func\s+(?:\([^)]*\)\s*)?(\w+)/], ['type', /^()type\s+(\w+)/]],
  rs: [['function', /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)/], ['struct', /^(\s*)(?:pub\s+)?struct\s+(\w+)/], ['enum', /^(\s*)(?:pub\s+)?enum\s+(\w+)/], ['trait', /^(\s*)(?:pub\s+)?trait\s+(\w+)/], ['impl', /^(\s*)impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?(\w+)/]],
  java: [['class', /^(\s*)(?:[\w@]+\s+)*(?:class|interface|enum|record|struct|object|protocol)\s+(\w+)/], ['function', /^(\s*)(?:(?:public|private|protected|static|final|override|suspend|fun|func|async)\s+)+[\w<>\[\],.? ]*?\s*(\w+)\s*\([^;]*\)\s*(?:throws [\w, .]+)?\s*\{?\s*$/]],
  c: [['function', /^()(?:[\w*]+\s+)+\**(\w+)\s*\([^;]*\)\s*\{?\s*$/], ['struct', /^()(?:typedef\s+)?(?:struct|class|enum)\s+(\w+)/]],
  rb: [['class', /^(\s*)(?:class|module)\s+([\w:]+)/], ['function', /^(\s*)def\s+(?:self\.)?([\w?!]+)/]],
  php: [['class', /^(\s*)(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/], ['function', /^(\s*)(?:(?:public|private|protected|static)\s+)*function\s+&?(\w+)/]],
  sh: [['function', /^()(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/], ['function', /^()function\s+([A-Za-z_][\w-]*)/]],
  css: [['rule', /^()([.#@][\w-]+(?:[ ,>+~:.#][^{]*)?)\s*\{/]],
  md: [['heading', /^()(#{1,6})\s+(.+?)\s*#*\s*$/]],
  html: [['heading', /^(\s*)<h([1-6])[^>]*>(.*)$/i], ['id', /^(\s*)<(?:section|main|header|footer|nav|form|dialog)\b[^>]*\bid="([^"]+)"/i]],
}
export const langOf = (file) => {
  const e = path.extname(file).slice(1).toLowerCase()
  if (/^(m?[jt]sx?|cjs|vue|svelte)$/.test(e)) return 'js'
  if (e === 'py') return 'py'
  if (e === 'go') return 'go'
  if (e === 'rs') return 'rs'
  if (/^(java|kt|cs|swift|dart|scala)$/.test(e)) return 'java'
  if (/^(c|h|cpp|hpp|cc)$/.test(e)) return 'c'
  if (e === 'rb') return 'rb'
  if (e === 'php') return 'php'
  if (/^(sh|bash)$/.test(e)) return 'sh'
  if (/^(css|scss|less)$/.test(e)) return 'css'
  if (e === 'md') return 'md'
  if (/^html?$/.test(e)) return 'html'
  return ''
}
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'function', 'await', 'typeof', 'new', 'throw', 'with', 'do', 'try', 'super', 'import', 'require', 'describe', 'it', 'test'])

export function extractSymbols(text, lang) {
  const defs = LANGS[lang]; if (!defs) return []
  const lines = text.split('\n'); const out = []
  let inBlock = false, fence = false
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (lang === 'js') {
      if (inBlock) { if (ln.includes('*/')) inBlock = false; continue }
      const t = ln.trimStart(); if (t.startsWith('/*') && !t.includes('*/')) { inBlock = true; continue }
      if (t.startsWith('//') || t.startsWith('*')) continue
    }
    if (lang === 'md' && /^\s*(```|~~~)/.test(ln)) { fence = !fence; continue }
    if (fence || ln.length > 400) continue
    for (const [kind, re] of defs) {
      const m = ln.match(re); if (!m) continue
      let name = m[2], k = kind
      if (lang === 'md') { name = m[3]; k = 'h' + m[2].length }
      else if (lang === 'html' && kind === 'heading') { name = m[3].replace(/<[^>]+>/g, '').trim(); k = 'h' + m[2] }
      else if (lang === 'html') { name = '#' + m[2]; k = 'section' }
      if (!name || NOT_NAMES.has(name)) continue
      if (kind === 'method' && /^(\s{2,})(if|for|while|switch|catch|return)\b/.test(ln)) continue
      if (kind === 'const-fn') k = 'function'
      out.push({ kind: k, name, line: i + 1, indent: (m[1] || '').replace(/\t/g, '  ').length, sig: ln.trim().slice(0, 110) })
      break
    }
  }
  for (let i = 0; i < out.length; i++) { // конец символа: до следующего с тем же или меньшим отступом
    let end = lines.length
    for (let j = i + 1; j < out.length; j++) if (out[j].indent <= out[i].indent) { end = out[j].line - 1; break }
    while (end > out[i].line && !lines[end - 1].trim()) end--
    out[i].end = end
  }
  return out
}

// ---------- быстрая проверка синтаксиса (для write/edit/patch и /diagnostics) ----------
const run = (cmd, args, ms = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: ms, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, notFound: err && err.code === 'ENOENT', stdout: String(stdout || ''), stderr: String(stderr || ''), err }))
})
// -> null (не проверяем) | {ok:true,note?} | {ok:false,msg}
export async function syntaxCheck(abs, text) {
  const ext = path.extname(abs).toLowerCase()
  try {
    if (ext === '.json') {
      try { JSON.parse(text) } catch (e) {
        const m = String(e.message).match(/position (\d+)/); let where = ''
        if (m) { const pos = Number(m[1]); const pre = text.slice(0, pos).split('\n'); where = ` at line ${pre.length}, column ${pre[pre.length - 1].length + 1}` }
        return { ok: false, msg: `invalid JSON${where}: ${String(e.message).split('\n')[0]}` }
      }
      return { ok: true }
    }
    if (/^\.(js|mjs|cjs)$/.test(ext)) {
      let r = await run(process.execPath, ['--check', abs], 8000)
      let viaTmp = false
      if (!r.ok && ext === '.js' && /Cannot use import statement|Unexpected token 'export'|import\.meta|await is only valid/i.test(r.stderr)) {
        // файл - ES-модуль без "type":"module": проверяем как .mjs во временном файле
        const tmp = path.join(os.tmpdir(), `chk-${process.pid}-${Date.now()}.mjs`)
        try { await fsp.writeFile(tmp, text); r = await run(process.execPath, ['--check', tmp], 8000); viaTmp = true } finally { fsp.rm(tmp, { force: true }).catch(() => {}) }
      }
      if (r.ok) return { ok: true, note: viaTmp ? 'checked as ES module' : undefined }
      const msg = r.stderr.split('\n').filter(Boolean)
      const loc = msg.find((l) => /:\d+$/.test(l)) || ''
      const err = msg.find((l) => /Error:/.test(l)) || msg[0] || 'syntax error'
      const code = msg[msg.indexOf(loc) + 1] || ''
      const line = loc.match(/:(\d+)$/)
      return { ok: false, msg: `${err.trim()}${line ? ` (line ${line[1]})` : ''}${code ? `\n      ${code.trim().slice(0, 140)}` : ''}` }
    }
    if (ext === '.py') {
      const r = await run('python3', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf8").read(),sys.argv[1])', abs], 8000)
      if (r.notFound) return null
      if (r.ok) return { ok: true }
      const l = r.stderr.trim().split('\n'); const loc = l.find((x) => /line \d+/.test(x)) || ''
      return { ok: false, msg: `${l[l.length - 1] || 'syntax error'}${loc ? ' ' + loc.trim() : ''}` }
    }
    if (/^\.(sh|bash)$/.test(ext)) {
      const r = await run('bash', ['-n', abs], 5000); if (r.ok) return { ok: true }
      return { ok: false, msg: r.stderr.trim().split('\n')[0] }
    }
  } catch { return null }
  return null
}

export function createCode({ ROOT, safe, relOf, defaultPath = '/' }) {
  const DEF = defaultPath
  const rel = (abs) => relOf(abs)
  const E = (msg, http = 400) => Object.assign(new Error(msg), { http })
  const num = (v, d, a, b) => { const n = Number(v); return Math.min(b, Math.max(a, Number.isFinite(n) && v !== undefined && v !== '' ? n : d)) }
  const flag = (v) => v === '1' || v === 'true' || v === 'yes' || v === true

  // обход файлов с лимитами -> { files:[{abs,rel,size,mtime}], stopped, base }
  async function walk(startAbs, { include, all = false, maxFiles = 20000, ms = 8000, onlyCode = false } = {}) {
    const t0 = Date.now(); const files = []; let stopped = ''
    async function rec(dir, prefix) {
      if (stopped) return
      let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
      ents.sort((a, b) => a.name.localeCompare(b.name))
      for (const e of ents) {
        if (stopped) return
        if (files.length >= maxFiles) { stopped = `stopped after ${maxFiles} files`; return }
        if (Date.now() - t0 > ms) { stopped = `stopped after ${ms / 1000}s`; return }
        const abs = path.join(dir, e.name); const r = prefix + e.name
        if (e.isDirectory()) {
          if (!all && (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github'))) continue
          await rec(abs, r + '/')
        } else if (e.isFile()) {
          if (onlyCode && !CODE_EXT.test(e.name)) continue
          if (include && !include(r)) continue
          let st; try { st = await fsp.stat(abs) } catch { continue }
          files.push({ abs, rel: r, size: st.size, mtime: st.mtimeMs })
        }
      }
    }
    const st = await fsp.stat(startAbs)
    if (st.isFile()) return { files: [{ abs: startAbs, rel: path.basename(startAbs), size: st.size, mtime: st.mtimeMs }], stopped, base: path.dirname(startAbs) }
    await rec(startAbs, '')
    return { files, stopped, base: startAbs }
  }
  const display = (startAbs, f) => { let isFile = false; try { isFile = fs.statSync(startAbs).isFile() } catch {} if (isFile) return rel(startAbs); const b = rel(startAbs); return (b === '/' ? '' : b) + '/' + f.rel }

  // ---------- grep ----------
  async function grep(p) {
    const pat = p.pattern ?? p.q ?? p.query ?? p.regex ?? p.text
    if (pat === undefined || pat === '') throw E('missing "pattern" (grep?pattern=TODO&path=/src&glob=*.js)')
    const startAbs = safe(p.path || DEF)
    const fixed = flag(p.fixed) || flag(p.literal), ic = flag(p.i) || flag(p.ignorecase) || p.case === 'insensitive'
    let re
    try { re = new RegExp(fixed ? String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : String(pat), ic ? 'i' : '') } catch (e) { throw E(`bad regular expression: ${e.message} (add &fixed=1 to search for the text literally)`) }
    const ctx = num(p.context ?? p.ctx ?? p.C, 0, 0, 10), maxM = num(p.max, 100, 1, 1000)
    const w = await walk(startAbs, { include: matcher(p.glob || p.include), all: flag(p.all) })
    const t0 = Date.now(); const L = []; let matches = 0, filesHit = 0, searched = 0, shownTotal = 0, capped = false
    const listOnly = flag(p.files) || flag(p.l), countOnly = flag(p.count); const counts = []
    for (const f of w.files) {
      if (f.size > MAX_FILE) continue
      let buf; try { buf = await fsp.readFile(f.abs) } catch { continue }
      if (isBinary(buf)) continue
      searched++
      const lines = buf.toString('utf8').split('\n'); const hits = []
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i)
      if (!hits.length) continue
      filesHit++; matches += hits.length
      counts.push([display(startAbs, f), hits.length])
      if (listOnly || countOnly || capped) continue
      L.push(display(startAbs, f))
      let last = -1
      for (const h of hits) {
        if (shownTotal >= maxM) { capped = true; break }
        const from = Math.max(last + 1, h - ctx), to = Math.min(lines.length - 1, h + ctx)
        if (ctx && last >= 0 && from > last + 1) L.push('  --')
        for (let k = from; k <= to; k++) L.push(`  ${k + 1}${k === h ? ':' : '-'} ${lines[k].slice(0, 220)}`)
        last = to; shownTotal++
      }
    }
    const head = `GREP ${fixed ? 'text' : 'regex'} "${pat}" in ${rel(startAbs)}${p.glob ? ` (glob ${p.glob})` : ''}${ic ? ' [ignore case]' : ''}  ->  ${matches} match(es) in ${filesHit} file(s)   [searched ${searched} files, ${Date.now() - t0}ms${w.stopped ? ', ' + w.stopped : ''}]`
    if (!matches) return head + '\n(nothing found. Try: &i=1 ignore case | &fixed=1 literal text | &all=1 include node_modules/hidden | a shorter pattern)'
    if (listOnly) return head + '\n' + counts.map(([f, c]) => `${f}  (${c})`).join('\n')
    if (countOnly) return head + '\n' + counts.sort((a, b) => b[1] - a[1]).map(([f, c]) => `${String(c).padStart(5)}  ${f}`).join('\n')
    return head + '\n' + L.join('\n') + (capped ? `\n...[output limited to ${maxM} matches; narrow it with &path=, &glob=, or raise &max=]` : '')
  }

  // ---------- glob ----------
  async function glob(p) {
    const g = p.pattern ?? p.glob ?? p.q ?? p.name
    if (!g) throw E('missing "pattern" (glob?pattern=**/*.test.js&path=/src)')
    const startAbs = safe(p.path || DEF); const m = matcher(g)
    const w = await walk(startAbs, { include: m, all: flag(p.all) })
    const byTime = p.sort === 'mtime' || p.sort === 'new'
    const files = w.files.slice().sort((a, b) => (byTime ? b.mtime - a.mtime : a.rel.localeCompare(b.rel)))
    const max = num(p.max, 300, 1, 2000)
    return `GLOB "${g}" in ${rel(startAbs)}  ->  ${files.length} file(s)${w.stopped ? ' [' + w.stopped + ']' : ''}${byTime ? ' (newest first)' : ''}\n` + (files.slice(0, max).map((f) => `${display(startAbs, f)}  (${f.size} B)`).join('\n') || '(no files match)') + (files.length > max ? `\n...[${files.length - max} more; raise &max=]` : '')
  }

  // ---------- tree ----------
  async function tree(p) {
    const startAbs = safe(p.path || DEF); const depth = num(p.depth, 3, 0, 8), max = num(p.max, 250, 20, 1500)
    const all = flag(p.all), lines = flag(p.lines); const out = []; let truncated = false
    async function count(dir) { let n = 0; let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }) } catch { return 0 } for (const e of ents) { if (e.isDirectory()) { if (n > 5000) return n; n += await count(path.join(dir, e.name)) } else n++ } return n }
    async function rec(dir, d, prefix) {
      let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
      ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
      for (const e of ents) {
        if (out.length >= max) { truncated = true; return }
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (!all && (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github'))) { out.push(`${prefix}${e.name}/  [skipped: ${await count(full)} files; &all=1 to show]`); continue }
          out.push(`${prefix}${e.name}/${d >= depth ? ` [${await count(full)} files]` : ''}`)
          if (d < depth) await rec(full, d + 1, prefix + '  ')
        } else {
          let extra = ''
          try { const st = await fsp.stat(full); extra = `  ${st.size} B`; if (lines && st.size < 400_000 && CODE_EXT.test(e.name)) { const b = await fsp.readFile(full); if (!isBinary(b)) extra += `, ${b.toString('utf8').split('\n').length} lines` } } catch {}
          out.push(`${prefix}${e.name}${extra}`)
        }
      }
    }
    const st = await fsp.stat(startAbs); if (!st.isDirectory()) return `${rel(startAbs)}  (${st.size} B)`
    await rec(startAbs, 0, '  ')
    return `TREE ${rel(startAbs)}/  (depth ${depth})\n` + (out.join('\n') || '  (empty)') + (truncated ? `\n...[truncated at ${max} entries; use &path= for a subfolder, &depth=, &max=]` : '')
  }

  // ---------- outline ----------
  async function outline(p) {
    if (!p.path) throw E('missing "path" (outline?path=/src/app.js)')
    const abs = safe(p.path); const st = await fsp.stat(abs)
    if (st.isDirectory()) throw E('path is a directory: use /tree, or /symbols?path=<dir>')
    const buf = await fsp.readFile(abs); if (isBinary(buf)) return `${rel(abs)}: binary file (${st.size} B)`
    const text = buf.toString('utf8'); const lang = langOf(abs); const total = text.split('\n').length
    if (!lang) return `OUTLINE ${rel(abs)}  (${total} lines)\n(no outline for this file type; use /read?path=...&start=1&end=60&numbered=1 or /grep)`
    const syms = extractSymbols(text, lang)
    const L = [`OUTLINE ${rel(abs)}  (${total} lines, ${lang})   read a part: /read?path=${rel(abs)}&start=<line>&end=<line>&numbered=1`]
    if (!syms.length) L.push('(no top-level definitions found)')
    for (const s of syms) L.push(`${String(s.line).padStart(5)}  ${'  '.repeat(Math.min(4, Math.floor(s.indent / 2)))}${s.kind.padEnd(8)} ${s.sig}${s.end > s.line ? `   [${s.line}-${s.end}]` : ''}`)
    return L.join('\n')
  }

  // ---------- symbols ----------
  async function symbols(p) {
    const q = String(p.q ?? p.name ?? p.query ?? '').trim(); const startAbs = safe(p.path || DEF)
    const kind = p.kind ? String(p.kind).toLowerCase() : ''; const exact = flag(p.exact)
    const w = await walk(startAbs, { include: matcher(p.glob), all: flag(p.all), onlyCode: true })
    const res = []; let scanned = 0
    for (const f of w.files) {
      const lang = langOf(f.abs); if (!lang || lang === 'md' || f.size > MAX_FILE) continue
      let buf; try { buf = await fsp.readFile(f.abs) } catch { continue }
      if (isBinary(buf)) continue
      scanned++
      for (const s of extractSymbols(buf.toString('utf8'), lang)) {
        if (kind && s.kind !== kind) continue
        if (q && !(exact ? s.name === q : s.name.toLowerCase().includes(q.toLowerCase()))) continue
        res.push({ ...s, file: display(startAbs, f) })
      }
    }
    const max = num(p.max, 80, 1, 500)
    return `SYMBOLS ${q ? `matching "${q}"` : '(all)'}${kind ? ` kind=${kind}` : ''} in ${rel(startAbs)}  ->  ${res.length} found  [scanned ${scanned} files${w.stopped ? ', ' + w.stopped : ''}]\n` +
      (res.slice(0, max).map((s) => `${s.file}:${s.line}  ${s.kind.padEnd(8)} ${s.sig}`).join('\n') || '(none; try a shorter name, or &all=1)') + (res.length > max ? `\n...[${res.length - max} more; narrow with &glob=/&kind=/&path= or &max=]` : '') +
      (res.length ? '\nnext: /outline?path=<file>  |  /read?path=<file>&start=<line>&end=<line>&numbered=1  |  /refs?name=<name>' : '')
  }

  // ---------- refs ----------
  async function refs(p) {
    const name = String(p.name ?? p.q ?? p.symbol ?? '').trim()
    if (!name) throw E('missing "name" (refs?name=createAgent&path=/src)')
    if (/[^\w$.]/.test(name)) throw E('"name" must be an identifier (letters, digits, _ $); for arbitrary text use /grep')
    const startAbs = safe(p.path || DEF); const re = new RegExp('(?<![\\w$])' + name.replace(/[$.]/g, '\\$&') + '(?![\\w$])')
    const w = await walk(startAbs, { include: matcher(p.glob), all: flag(p.all), onlyCode: true })
    const byFile = new Map(); let defs = 0, uses = 0, scanned = 0
    for (const f of w.files) {
      if (f.size > MAX_FILE) continue
      let buf; try { buf = await fsp.readFile(f.abs) } catch { continue }
      if (isBinary(buf)) continue
      scanned++
      const text = buf.toString('utf8'); if (!re.test(text)) continue
      const lines = text.split('\n'); const lang = langOf(f.abs)
      const defLines = new Set(lang ? extractSymbols(text, lang).filter((s) => s.name === name).map((s) => s.line) : [])
      const items = []
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue
        const t = lines[i].trimStart(); const isDef = defLines.has(i + 1)
        const kind = isDef ? 'def' : /^(\/\/|#|\*|\/\*|<!--)/.test(t) ? 'comment' : /^(import|from|export\s+\{|const\s+\{.*\}\s*=\s*require|require\()/.test(t) ? 'import' : 'use'
        if (isDef) defs++; else if (kind !== 'comment') uses++
        items.push(`  ${i + 1}: [${kind}] ${lines[i].trim().slice(0, 170)}`)
      }
      if (items.length) byFile.set(display(startAbs, f), items)
    }
    const max = num(p.max, 120, 1, 1000); const L = []; let shown = 0
    for (const [f, items] of byFile) { if (shown >= max) break; L.push(f); for (const it of items) { if (shown++ >= max) break; L.push(it) } }
    return `REFS "${name}" in ${rel(startAbs)}  ->  ${defs} definition(s), ${uses} use(s) in ${byFile.size} file(s)  [scanned ${scanned}${w.stopped ? ', ' + w.stopped : ''}]\n` + (L.join('\n') || '(not found anywhere; check the spelling with /symbols?q=' + name.slice(0, 6) + ')') + (shown >= max ? '\n...[truncated; narrow with &path=/&glob=]' : '')
  }

  // ---------- diagnostics ----------
  async function diagnostics(p) {
    const startAbs = safe(p.path || DEF); const st = await fsp.stat(startAbs)
    const w = await walk(startAbs, { include: matcher(p.glob), all: flag(p.all), maxFiles: 400, onlyCode: true })
    const L = []; let checked = 0, bad = 0
    for (const f of w.files) {
      if (!/\.(json|m?js|cjs|py|sh|bash)$/i.test(f.abs) || f.size > MAX_FILE) continue
      let text; try { text = await fsp.readFile(f.abs, 'utf8') } catch { continue }
      const r = await syntaxCheck(f.abs, text); if (!r) continue
      checked++
      if (!r.ok) { bad++; L.push(`  ERROR ${display(startAbs, f)}: ${r.msg}`) }
    }
    return `DIAGNOSTICS ${rel(startAbs)}${st.isDirectory() ? '/' : ''}: syntax check of ${checked} file(s) (.js .mjs .cjs .json .py .sh): ${bad ? bad + ' with errors' : 'all OK'}${w.stopped ? ' [' + w.stopped + ']' : ''}\n` + L.join('\n') + (L.length ? '\n' : '') + "NOTE: this is a SYNTAX check only (not types/lint). For TypeScript/JSX run the project's own tools via /exec (npx tsc --noEmit, npm run build, npm test)."
  }

  return { grep, glob, tree, outline, symbols, refs, diagnostics, walk }
}
