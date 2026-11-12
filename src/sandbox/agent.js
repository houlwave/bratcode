// GET-friendly API для ИИ-агентов, умеющих только открывать URL.
// Базовый адрес: /agent/<AGENT_TOKEN>/<команда>?параметры
// Каждое действие попадает в живую ленту (events.js), которую пользователь видит в IDE.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { begin, append, finish, say, state, takeInbox, lineDiff } from './events.js'
import { createEyes } from './eyes.js'
import { createCode, syntaxCheck } from './code.js'
import { applyEdits, applyHunks, parsePatch, sha, EditError } from './edit.js'
import { helpText } from './help.js'

const MAX_OUT = 60_000
const MAX_READ = 200_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const KIND0 = { ls: 'fs', read: 'read', write: 'write', edit: 'write', mkdir: 'fs', touch: 'write', rm: 'fs', mv: 'fs', cp: 'fs', exec: 'exec', start: 'exec', logs: 'fs', ps: 'fs', stop: 'fs', curl: 'net', download: 'net', look: 'look', act: 'look', click: 'look', type: 'look', press: 'look', eval: 'look', console: 'look', shot: 'look', view: 'look', compare: 'look', frames: 'look', sheet: 'look', tiles: 'look', style: 'look', selftest: 'look', say: 'say', multiedit: 'write', patch: 'write', grep: 'fs', glob: 'fs', tree: 'fs', outline: 'fs', symbols: 'fs', refs: 'fs', diagnostics: 'fs', batch: 'exec', remember: 'fs', memory: 'fs', emulate: 'look', devices: 'look', responsive: 'look', undo: 'write', history: 'fs', sysinfo: 'mac', osascript: 'mac', screen: 'look', clipboard: 'mac', open_app: 'mac', notify: 'mac', open: 'mac' }

export function createAgent({ ROOT, PORT, safe, relOf, token, serveFile, proxy, readBody, stateDir, backups = null, extra = {} }) {
  const KIND = { ...KIND0, ...(extra.kinds || {}) }
  const STATE = stateDir || path.join(path.dirname(ROOT), '.agent-state')
  const LOGDIR = path.join(STATE, 'logs')
  const SHOTS = path.join(STATE, 'shots')
  fs.mkdirSync(LOGDIR, { recursive: true })
  // Браузер (look/act/shot/eval) грузим лениво: без playwright-core остальные команды работают,
  // а браузерные отвечают понятной ошибкой вместо падения сервера на старте.
  let browser = null, browserErr = null
  async function getBrowser() {
    if (browser) return browser
    if (!browserErr) {
      try { browser = (await import('./browser.js')).createBrowser({ shotsDir: SHOTS }) } catch (e) { browserErr = e }
    }
    if (!browser) throw new Error('browser tools (look/act/shot/eval) are unavailable: playwright-core is not installed')
    return browser
  }
  const eyes = createEyes({ SHOTS, safe, relOf, getBrowser, PORT, token })
  const procs = new Map()
  const DEFCWD = extra.defaultCwd || '/'
  const codeTools = createCode({ ROOT, safe, relOf, defaultPath: DEFCWD })

  // ---- память проекта: заметки лежат РЯДОМ с рабочей папкой (не часть проекта, не синхронизируются) ----
  const MEMDIR = path.join(STATE, 'memory'), MEMFILE = path.join(MEMDIR, 'notes.md')
  const readNotes = () => { try { return fs.readFileSync(MEMFILE, 'utf8').trim() } catch { return '' } }
  const writeNotes = (t) => { fs.mkdirSync(MEMDIR, { recursive: true }); fs.writeFileSync(MEMFILE, t ? t.replace(/\s+$/, '') + '\n' : '') }
  const shownNotes = () => { const t = readNotes(); return t.length > 3000 ? '...' + t.slice(-3000) : t }

  const b64 = (s) => Buffer.from(String(s).replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const val = (p, k) => (p[k + '_b64'] !== undefined ? b64(p[k + '_b64']).toString('utf8') : p[k])
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  const tail = (file, n) => { try { return fs.readFileSync(file, 'utf8').split('\n').slice(-n - 1).join('\n') } catch { return '' } }

  function runCmd(cmd, cwd, timeoutMs, it) {
    return new Promise((resolve) => {
      const c = spawn('bash', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TERM: 'dumb', CI: '1', NO_COLOR: '1', WORKSPACE: ROOT } })
      let buf = '', truncated = false, timedOut = false, killed = false, done = false
      const add = (d) => { const s = String(d); if (buf.length < MAX_OUT) buf += s; else truncated = true; if (it) append(it, s) }
      c.stdout.on('data', add); c.stderr.on('data', add)
      const finishRun = (code, sig) => {
        if (done) return; done = true; clearTimeout(timer)
        try { c.stdout.destroy(); c.stderr.destroy() } catch {}
        resolve({ code: killed ? 'killed' : timedOut ? 'timeout' : code, signal: sig, output: buf.slice(0, MAX_OUT), truncated })
      }
      const kill = () => { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
      if (it) state.active.set(it.id, () => { killed = true; kill(); setTimeout(() => finishRun(null), 300) })
      const timer = setTimeout(() => { timedOut = true; kill(); setTimeout(() => finishRun(null), 300) }, timeoutMs)
      c.on('exit', (code, sig) => setTimeout(() => finishRun(code, sig), 250))
      c.on('error', (e) => { buf += String(e); finishRun(-1) })
    })
  }

  async function listDir(abs, depth, maxDepth, out, prefix) {
    const ents = await fsp.readdir(abs, { withFileTypes: true })
    ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    for (const e of ents) {
      if (out.length >= 500) return
      const full = path.join(abs, e.name)
      if (e.isDirectory()) {
        out.push(`${prefix}${e.name}/`)
        if (depth < maxDepth && !['node_modules', '.git'].includes(e.name)) await listDir(full, depth + 1, maxDepth, out, prefix + '  ')
      } else { let size = 0; try { size = (await fsp.stat(full)).size } catch {}; out.push(`${prefix}${e.name}  (${size} B)`) }
    }
  }

  // ---------- помощники правки файлов ----------
  const SYNTAX_EXT = /\.(json|m?js|cjs|py|sh|bash)$/i
  async function syntaxLine(abs, text) {
    if (!SYNTAX_EXT.test(abs)) return { line: '', res: null }
    if (text === undefined) { try { text = await fsp.readFile(abs, 'utf8') } catch { return { line: '', res: null } } }
    if (text.length > 400_000) return { line: '', res: null }
    const r = await syntaxCheck(abs, text)
    if (!r) return { line: '', res: null }
    if (r.ok) return { line: `\nSYNTAX: OK${r.note ? ` (${r.note})` : ''}`, res: r }
    return { line: `\nSYNTAX ERROR in ${relOf(abs)}: ${r.msg}\n(the file IS written - fix it now: /read?path=${relOf(abs)}&numbered=1 then /edit or /multiedit)`, res: r }
  }
  const nLines = (t) => (t === '' ? 0 : t.endsWith('\n') ? t.split('\n').length - 1 : t.split('\n').length)
  function checkSha(p, text, label) {
    if (!p.expect_sha) return
    const now = text === null ? 'missing' : sha(text)
    if (String(p.expect_sha).trim() !== now) throw new EditError(`${label} was changed since you read it (sha now ${now}, you expected ${p.expect_sha}). Nothing was written. /read it again (numbered=1) and redo the change.`, 409)
  }
  function parseEdits(p) {
    let e = p.edits
    if (p.edits_b64 !== undefined) e = b64(p.edits_b64).toString('utf8')
    if (typeof e === 'string') { try { e = JSON.parse(e) } catch (err) { throw new EditError('"edits" is not valid JSON: ' + err.message + ' (send edits_b64=<base64 of [{"find":"..","replace":".."}]>)', 400) } }
    if (e && !Array.isArray(e) && typeof e === 'object') e = e.edits && Array.isArray(e.edits) ? e.edits : [e]
    if (Array.isArray(e)) {
      return e.map((x) => {
        const o = { ...x }
        if (o.find_b64 !== undefined) o.find = b64(o.find_b64).toString('utf8')
        if (o.replace_b64 !== undefined) o.replace = b64(o.replace_b64).toString('utf8')
        return o
      })
    }
    const out = []
    for (let i = 1; i <= 50; i++) {
      const f = val(p, 'find' + i)
      if (f !== undefined) out.push({ find: f, replace: val(p, 'replace' + i) ?? '', all: p['all' + i] })
      else if (p['start' + i] !== undefined) out.push({ start: p['start' + i], end: p['end' + i], replace: val(p, 'replace' + i) ?? '' })
    }
    if (out.length) return out
    const f = val(p, 'find')
    if (f !== undefined) return [{ find: f, replace: val(p, 'replace') ?? '', all: p.all }]
    if (p.start !== undefined) return [{ start: p.start, end: p.end, replace: val(p, 'replace') ?? '' }]
    return []
  }

  // patch paths: with &root=/folder they are relative to it; otherwise absolute stays absolute, relative -> project folder
  const patchPath = (rootDir, p0) => (rootDir ? safe(path.join(safe(rootDir), String(p0).replace(/^\/+/, ''))) : safe(p0))

  // ---------- batch: список команд ----------
  const BATCH_MAX = 20
  function batchItems(p) {
    let c = p.cmds
    if (p.cmds_b64 !== undefined) c = b64(p.cmds_b64).toString('utf8')
    if (typeof c === 'string' && /^\s*\[/.test(c)) { try { c = JSON.parse(c) } catch {} }
    if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? { line: x } : { obj: x }))
    if (typeof c !== 'string') return []
    return c.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => ({ line: l }))
  }

  const parseSteps = (p) => {
    const raw = (val(p, 'steps') ?? (p.sel ? `click:${p.sel}` : '')) || ''
    return raw.split('\n').flatMap((l) => (/^\s*(eval|keys|type|fill):/i.test(l) ? [l] : l.split('|'))).map((s) => s.trim()).filter(Boolean)
  }

  const handle = async function handle(req, res, url) {
    const m = url.pathname.match(/^\/agent(?:\/([^/]+))?(\/.*)?$/)
    const tk = m && m[1]
    let rest = (m && m[2]) || ''
    const qTok = url.searchParams.get('token')
    let authed = false
    if (tk === token) authed = true
    else if (qTok === token) { authed = true; rest = (tk ? '/' + tk : '') + rest }
    if (!authed) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('401: agent token required. Use /agent/<token>/help') }

    const proto = (req.headers['x-forwarded-proto'] || (/^(127\.0\.0\.1|localhost)(:|$)/.test(String(req.headers.host || '')) ? 'http' : 'https')).split(',')[0]
    const base = `${proto}://${req.headers.host}/agent/${token}`
    const [cmd, ...restSeg] = rest.replace(/^\/+/, '').split('/')
    const subPath = restSeg.join('/')

    const p = Object.fromEntries(url.searchParams.entries()); delete p.token
    if (req.method === 'POST') {
      const raw = (await readBody(req)).toString()
      p.__raw = raw
      try { Object.assign(p, JSON.parse(raw)) } catch { try { Object.assign(p, Object.fromEntries(new URLSearchParams(raw))) } catch {} }
    }

    // мягкие псевдонимы параметров: ИИ часто путает имена
    const FS_CMDS = ['write', 'read', 'edit', 'multiedit', 'outline', 'mkdir', 'rm', 'ls']
    if (FS_CMDS.includes(cmd) && p.path === undefined) for (const k of ['file', 'filename', 'filepath', 'name', 'p']) if (p[k] !== undefined) { p.path = p[k]; break }
    if (cmd === 'write' && p.content === undefined && p.content_b64 === undefined) for (const k of ['text', 'body', 'data', 'code', 'contents', 'source', 'c']) if (p[k] !== undefined) { p.content = p[k]; break }
    if (cmd === 'write' && req.method === 'POST' && p.content === undefined && p.content_b64 === undefined && p.__raw && !/^\s*[{]/.test(p.__raw) && !/^[\w.\-]+=/.test(p.__raw)) p.content = p.__raw
    const rawBody = p.__raw
    delete p.__raw
    const got = () => Object.keys(p).filter((k) => k !== 'format').map((k) => `${k}(${String(p[k]).length})`).join(', ') || 'no parameters'

    // --- служебные маршруты без записи в ленту ---
    if (cmd === '' || cmd === 'help' || cmd === 'docs') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(helpText(base, ROOT, { topic: p.topic || p.t, level: p.level, notes: shownNotes(), extra: { ...(extra.help || {}), cwd: DEFCWD, platform: process.platform } })) }
    if (cmd === 'files') { try { return serveFile(req, res, safe(decodeURIComponent('/' + subPath))) } catch { res.writeHead(403); return res.end('forbidden') } }
    if (cmd === 'proxy') { const u = new URL(req.url, 'http://x'); u.pathname = '/proxy/' + subPath; return proxy(req, res, u) }
    if (cmd === 'shots') {
      const f = path.join(SHOTS, path.basename(subPath))
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no such screenshot') }
      return serveFile(req, res, f, { type: /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/png' })
    }

    // --- пауза от пользователя ---
    if (state.paused) {
      for (let i = 0; i < 40 && state.paused; i++) await sleep(500)
      if (state.paused) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '10' }); return res.end('PAUSED: the user paused you from the IDE. Wait ~30 seconds and repeat this same request.') }
    }

    // --- подтверждение чувствительных действий (Side B / demure) ---
    if (extra.confirm && extra.sensitive && extra.sensitive.has(cmd)) {
      let ok = true
      try { ok = await extra.confirm(cmd, { ...p }) } catch { ok = false }
      if (!ok) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(`DENIED: the user did not approve "${cmd}" (or did not answer in time). Do NOT retry it silently - ask the user in your reply what they want instead.`) }
    }

    // --- элемент ленты ---
    const title = (() => {
      const v = (k) => val(p, k) || ''
      switch (cmd) {
        case 'exec': case 'start': return '$ ' + v('cmd')
        case 'write': case 'touch': return `${p.append && cmd === 'write' ? 'append' : cmd} ${p.path || ''}`
        case 'mv': case 'cp': return `${cmd} ${p.from || ''} → ${p.to || ''}`
        case 'curl': return 'curl ' + (p.url || `:${p.port || 8000}${p.path || '/'}`)
        case 'look': case 'shot': return `${cmd} ` + (p.file || p.url || (p.port ? `:${p.port}${p.path || '/'}` : '(current page)')) + (p.device ? ` [${p.device}]` : p.mobile === '1' ? ' [mobile]' : '') + (p.dark === '1' ? ' [dark]' : '') + (p.net ? ` [${p.net}]` : '')
        case 'act': case 'click': case 'type': case 'press': return `${cmd} ` + (cmd === 'press' ? p.key : parseSteps(p).join('  →  ') || '')
        case 'eval': return 'eval ' + v('js').slice(0, 120)
        case 'download': return `download ${p.url || ''} → ${p.path || ''}`
        case 'logs': case 'stop': return `${cmd} ${p.name || ''}`
        case 'view': return 'view ' + (p.file || p.url || '') + (p.crop ? ' crop ' + p.crop : '')
        case 'compare': return 'compare ' + (p.a || p.file || '') + '  vs  ' + (p.b || p.file2 || p.url || '')
        case 'frames': return 'frames ' + (p.file || p.url || '')
        case 'tiles': return 'tiles ' + (p.file || p.url || '') + ' ' + (p.cols || 2) + 'x' + (p.rows || 2)
        case 'style': return 'style ' + (p.a || p.file || '') + '  vs  ' + (p.b || p.file2 || p.url || '')
        case 'sheet': return 'sheet ' + (p.dir || p.files || '')
        case 'multiedit': return `multiedit ${p.path || ''}`
        case 'patch': return 'patch ' + (p.root || '')
        case 'grep': return 'grep ' + (p.pattern ?? p.q ?? p.query ?? p.regex ?? p.text ?? '') + (p.path ? ' in ' + p.path : '')
        case 'glob': return 'glob ' + (p.pattern ?? p.glob ?? p.q ?? p.name ?? '')
        case 'symbols': case 'refs': return `${cmd} ` + (p.q ?? p.name ?? p.query ?? '')
        case 'batch': { let n = 0; try { n = batchItems(p).length } catch {} return `batch (${n} commands)` }
        case 'remember': return 'remember ' + (val(p, 'text') || '').slice(0, 80)
        case 'responsive': return 'responsive ' + (p.file || p.url || (p.port ? `:${p.port}${p.path || '/'}` : '(current page)'))
        case 'selftest': return 'selftest'
        case 'say': return 'say'
        default:
          if (extra.titles && extra.titles[cmd]) return extra.titles[cmd](p, v)
          return `${cmd} ${p.path || ''}`.trim()
      }
    })()
    const it = begin(KIND[cmd] || 'fs', title, { cmd, path: p.path || p.file || undefined })

    function R(text, obj, code = 200, extra = {}) {
      const ok = code < 400 && obj?.ok !== false
      if (!it.out && cmd !== 'say') it.out = String(text).slice(0, 2500)
      finish(it, ok, extra)
      const msgs = takeInbox()
      if (msgs.length) { text += `\n\n>>> NEW MESSAGE FROM THE USER (read and follow it): ${msgs.join(' | ')}`; if (obj) obj.user_messages = msgs }
      const hdr = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
      if (p.format === 'json') { res.writeHead(code, { ...hdr, 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(obj ?? { text })) }
      res.writeHead(code, { ...hdr, 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text)
    }
    const fail = (msg, code = 400) => { it.out = msg; return R(`ERROR: ${msg}\n(command list: ${base}/help)`, { ok: false, error: msg }, code) }

    // --- браузер ---
    const targetUrl = () => {
      if (p.url) return p.url
      if (p.file) return `http://127.0.0.1:${PORT}/agent/${token}/files${safe(p.file).split('/').map(encodeURIComponent).join('/')}`
      if (p.port) return `http://127.0.0.1:${Number(p.port)}${p.path || '/'}`
      return ''
    }
    // параметры эмуляции из запроса -> объект для B.emulate (или null)
    const emuOpts = () => {
      const o = {}; let any = false
      if (p.reset === '1' || p.reset === 'true') { o.reset = true; any = true }
      if (p.device !== undefined) { o.device = p.device; any = true }
      else if (p.mobile === '1') { o.device = 'iPhone 14'; any = true }
      else if (p.mobile === '0') { o.device = 'desktop'; any = true }
      for (const k of ['dark', 'reduced', 'net', 'lang', 'tz', 'dpr']) if (p[k] !== undefined) { o[k] = p[k]; any = true }
      return any ? o : null
    }
    async function browse({ steps = [], doLook = true, brief = false, forceOpen = false, shotOpts = null } = {}) {
      const B = await getBrowser()
      return B.locked(async () => {
        const eo = emuOpts()
        if (eo) await B.emulate(eo)
        const w = Number(p.w) || 0, h = Number(p.h) || 0
        const page = await B.ensure(w || undefined, h || undefined)
        const target = targetUrl()
        const hasPage = page.url() !== 'about:blank'
        if (target && (forceOpen || !hasPage || p.open === '1' || cmd === 'look' || cmd === 'shot')) await B.goto(target)
        else if (!hasPage) throw new Error('no page is open yet: pass file=/path.html, port=8000 or url=https://...')
        else if (w && h) await page.waitForTimeout(250)
        const stepLog = steps.length ? await B.runSteps(steps) : []
        let name = null, report = ''
        if (doLook) {
          const L = await B.look({ full: p.full, brief: brief ? '1' : p.brief, shotOpts })
          name = L.name; report = L.text((n) => `${base}/shots/${n}`)
        }
        return { stepLog, name, report }
      })
    }
    const failedStep = (r) => r.stepLog.some((s) => /FAILED/.test(s))

    try {
      switch (cmd) {
        case 'say': { say(val(p, 'text') || ''); return R('OK shown to the user', { ok: true }) }
        case 'ls': {
          const abs = safe(p.path || DEFCWD); const depth = Math.min(4, Number(p.depth ?? 0) || 0)
          const st = await fsp.stat(abs)
          if (!st.isDirectory()) return R(`${relOf(abs)}  (${st.size} B)`, { ok: true, file: true, size: st.size })
          const out = []; await listDir(abs, 0, depth, out, '')
          return R(`${relOf(abs)}/\n` + (out.join('\n') || '(empty)') + (out.length >= 500 ? '\n...[truncated at 500 entries]' : ''), { ok: true, entries: out })
        }
        case 'read': {
          const abs = safe(p.path); const st = await fsp.stat(abs)
          if (st.isDirectory()) return fail('path is a directory, use ls')
          const buf = await fsp.readFile(abs)
          if (buf.subarray(0, 8000).includes(0)) return R(`(binary file, ${st.size} B)`, { ok: true, binary: true, size: st.size })
          const full = buf.toString('utf8'); let text = full; let trunc = ''; let header = ''
          const fsha = sha(full), total = nLines(full)
          if (p.start || p.end || p.numbered) {
            const lines = full.split('\n'); if (full.endsWith('\n')) lines.pop()
            const s = Math.max(1, Number(p.start) || 1); const e = Math.min(lines.length, Number(p.end) || lines.length)
            if (s > lines.length && lines.length) return fail(`start=${s} is beyond the end of the file (${lines.length} lines)`, 400)
            text = lines.slice(s - 1, e).map((l, i) => (p.numbered ? `${s + i}: ${l}` : l)).join('\n')
            header = `# ${relOf(abs)}  lines ${s}-${e} of ${total}  sha ${fsha}${p.numbered ? '  (the "N: " prefixes are NOT part of the file)' : ''}\n`
          }
          if (text.length > MAX_READ) { text = text.slice(0, MAX_READ); trunc = `\n...[truncated at ${MAX_READ} chars; use start/end]` }
          it.out = text.slice(0, 1500) + (text.length > 1500 ? '\n…' : '')
          return R(header + text + trunc, { ok: true, content: text, size: st.size, lines: total, sha: fsha, truncated: !!trunc })
        }
        case 'write': case 'touch': {
          if (!p.path) return fail(`missing "path" (e.g. path=/app/index.html). Received: ${got()}`)
          const abs = safe(p.path); if (abs === ROOT) return fail('path is the root')
          if (backups) await backups.save(abs, cmd)
          const hasContent = p.content_b64 !== undefined || p.content !== undefined
          // touch и write без content: создаём пустой файл (если он уже есть — не трогаем), а не отвечаем ошибкой.
          // Иначе агент, у которого content выпал из URL, зацикливается на одной и той же ошибке.
          if (cmd === 'touch' || !hasContent) {
            await fsp.mkdir(path.dirname(abs), { recursive: true })
            let existed = true
            try { await fsp.access(abs) } catch { existed = false; await fsp.writeFile(abs, '') }
            const size = (await fsp.stat(abs)).size
            const note = cmd === 'touch' || existed ? '' : `\nNOTE: no "content"/"content_b64" parameter arrived (got: ${got()}), so an EMPTY file was created. If you meant to write text, repeat the request with content_b64=<base64 of the text>.`
            if (!existed && note) it.out = 'создан пустой файл (параметр content не пришёл)'
            return R(`OK ${existed ? 'exists' : 'created empty file'} ${relOf(abs)} (${size} B)${note}`, { ok: true, path: relOf(abs), size, created: !existed }, 200, { path: relOf(abs) })
          }
          const content = p.content_b64 !== undefined ? b64(p.content_b64) : Buffer.from(p.content, 'utf8')
          await fsp.mkdir(path.dirname(abs), { recursive: true })
          let before = null
          try { const old = await fsp.readFile(abs); if (old.length < 300_000 && !old.subarray(0, 4000).includes(0)) before = old.toString('utf8') } catch {}
          if (p.expect_sha) checkSha(p, before, relOf(abs))
          const append2 = p.append === '1' || p.append === 'true'
          if (append2) await fsp.appendFile(abs, content); else await fsp.writeFile(abs, content)
          const size = (await fsp.stat(abs)).size
          let diff
          if (content.length < 300_000 && !content.subarray(0, 4000).includes(0)) diff = lineDiff(before, append2 ? (before ?? '') + content.toString('utf8') : content.toString('utf8'))
          let sxl = { line: '', res: null }, finalText
          if (SYNTAX_EXT.test(abs) && size < 400_000) { finalText = append2 ? await fsp.readFile(abs, 'utf8') : content.toString('utf8'); sxl = await syntaxLine(abs, finalText) }
          return R(`OK ${append2 ? 'appended' : 'wrote'} ${content.length} bytes -> ${relOf(abs)} (file size now ${size} B${finalText !== undefined ? ', sha ' + sha(finalText) : ''})\npreview: ${base}/files${relOf(abs)}${append2 && sxl.res && !sxl.res.ok ? '\n(NOTE: with append=1 the file may be incomplete until the last chunk is written)' : ''}${sxl.line}`, { ok: true, path: relOf(abs), size, syntax: sxl.res }, 200, { path: relOf(abs), diff })
        }
        case 'edit': case 'multiedit': {
          if (!p.path) return fail('missing "path" (e.g. path=/app/a.js)', 400)
          const abs = safe(p.path)
          const edits = parseEdits(p)
          if (backups && !(p.dry === '1' || p.dry === 'true')) await backups.save(abs, cmd)
          if (!edits.length) return fail(cmd === 'edit' ? 'missing "find" (and "replace"); or start/end line range; or several edits: /multiedit' : 'no edits: send edits_b64=<base64 of JSON [{"find":"old","replace":"new"}]> or find1/replace1, find2/replace2 ...', 400)
          const src = await fsp.readFile(abs, 'utf8')
          checkSha(p, src, relOf(abs))
          const { out, report } = applyEdits(src, edits, relOf(abs))
          if (p.dry === '1' || p.dry === 'true') return R(`DRY RUN ok: ${edits.length} edit(s) would apply to ${relOf(abs)} (nothing written)\n${report.map((r) => '  ' + r).join('\n')}`, { ok: true, dry: true, report })
          await fsp.writeFile(abs, out)
          const sx = await syntaxLine(abs, out)
          return R(`OK ${edits.length} edit(s) applied to ${relOf(abs)}  (${nLines(out)} lines, sha ${sha(out)})\n${report.map((r) => '  ' + r).join('\n')}${sx.line}`, { ok: true, edits: edits.length, replaced: edits.length, report, sha: sha(out), syntax: sx.res }, 200, { path: relOf(abs), diff: lineDiff(src, out) })
        }
        case 'patch': {
          let text = val(p, 'patch') ?? val(p, 'diff')
          if (text === undefined && rawBody && !/^\s*\{/.test(rawBody) && !/^[\w.\-]+=/.test(rawBody)) text = rawBody
          if (!text || !String(text).trim()) return fail('no patch: send patch_b64=<base64 of a unified diff or "*** Begin Patch" text> (or POST it as the request body)', 400)
          const files = parsePatch(text)
          if (!files.length) return fail('could not find any file in the patch. Expected a unified diff ("--- a/file", "+++ b/file", "@@ -1,3 +1,4 @@") or "*** Begin Patch / *** Update File: /path / ... / *** End Patch"', 400)
          const rootDir = p.root ? String(p.root).replace(/\/+$/, '') : ''
          const state = new Map(), order = [], rep = []
          const getText = async (abs) => { if (state.has(abs)) return state.get(abs); try { return await fsp.readFile(abs, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
          for (const f of files) {
            if (!f.path) throw new EditError('a hunk has no file name (missing "--- a/file" / "+++ b/file" lines)', 400)
            const abs = patchPath(rootDir, f.path); const label = relOf(abs)
            if (f.op === 'add') {
              const cur = await getText(abs)
              if (cur !== null && cur !== '' && p.force !== '1') throw new EditError(`${label}: the patch creates this file but it already exists (add &force=1 to overwrite, or use "Update File")`, 409)
              state.set(abs, f.content.join('\n') + (f.content.length ? '\n' : '')); order.push(abs); rep.push(`${label}: created (${f.content.length} lines)`)
            } else if (f.op === 'delete') {
              const cur = await getText(abs); if (cur === null) throw new EditError(`${label}: cannot delete - file not found`, 404)
              state.set(abs, null); order.push(abs); rep.push(`${label}: deleted`)
            } else {
              const cur = await getText(abs); if (cur === null) throw new EditError(`${label}: file not found (the patch updates it). Check the path with /glob?pattern=${path.basename(label)}${rootDir ? '' : ' or pass &root=/folder'}`, 404)
              if (!state.has(abs)) checkSha(p, cur, label)
              const r = applyHunks(cur, f.hunks, label)
              const dest = f.moveTo ? patchPath(rootDir, f.moveTo) : abs
              if (dest !== abs) { state.set(abs, null); state.set(dest, r.out); order.push(abs, dest) } else { state.set(abs, r.out); order.push(abs) }
              rep.push(`${label}${dest !== abs ? ' -> ' + relOf(dest) : ''}: ${r.report.join('; ')}`)
            }
          }
          const uniq = [...new Set(order)]
          if (p.dry === '1' || p.dry === 'true') return R(`DRY RUN ok: patch would change ${uniq.length} file(s) (nothing written)\n${rep.map((r) => '  ' + r).join('\n')}`, { ok: true, dry: true, report: rep })
          const done = []; let firstDiff = null, firstPath
          if (backups) { const g = 'patch' + Date.now() + Math.random(); for (const abs of uniq) await backups.save(abs, 'patch', g) }
          for (const abs of uniq) {
            const v = state.get(abs)
            if (v === null) { await fsp.rm(abs, { force: true }); continue }
            let before = null; try { before = await fsp.readFile(abs, 'utf8') } catch {}
            await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, v)
            if (!firstDiff && v.length < 300_000) { firstDiff = lineDiff(before, v); firstPath = relOf(abs) }
            done.push(abs)
          }
          const syn = []
          for (const abs of done) { const sx = await syntaxLine(abs, state.get(abs)); if (sx.res && !sx.res.ok) syn.push(`SYNTAX ERROR in ${relOf(abs)}: ${sx.res.msg}`) }
          const tail = syn.length ? `\n${syn.join('\n')}\n(files ARE written - fix the syntax now)` : done.some((a) => SYNTAX_EXT.test(a)) ? '\nSYNTAX: OK' : ''
          return R(`OK patch applied: ${uniq.length} file(s)\n${rep.map((r) => '  ' + r).join('\n')}${tail}`, { ok: true, files: uniq.map(relOf), report: rep, syntax_errors: syn.length }, 200, { path: firstPath, diff: firstDiff })
        }
        // ---------- навигация по коду ----------
        case 'grep': case 'glob': case 'tree': case 'outline': case 'symbols': case 'refs': case 'diagnostics': {
          let text = await codeTools[cmd](p)
          if (text.length > MAX_OUT) text = text.slice(0, MAX_OUT) + '\n...[output cut; narrow the request]'
          return R(text, { ok: true, text })
        }
        // ---------- память проекта ----------
        case 'remember': {
          const t = String(val(p, 'text') ?? val(p, 'note') ?? '').replace(/\s+/g, ' ').trim()
          if (!t) return fail('missing "text" (remember?text=How%20to%20run%20tests%3A%20npm%20test)')
          if (t.length > 1200) return fail('note too long (max 1200 chars): keep one short fact per note')
          const cur = readNotes(); const day = new Date().toISOString().slice(0, 10)
          if (cur.split('\n').some((l) => l.replace(/^- \[[\d-]+\] /, '') === t)) return R(`OK already remembered:\n${shownNotes()}`, { ok: true, duplicate: true })
          let next = (cur ? cur + '\n' : '') + `- [${day}] ${t}`
          if (next.length > 20000) next = next.split('\n').slice(-Math.ceil(next.split('\n').length * 0.7)).join('\n')
          writeNotes(next)
          return R(`OK remembered (${next.split('\n').length} note(s) in total). They appear at the top of ${base}/help in every new session.`, { ok: true, notes: next.split('\n') })
        }
        case 'memory': {
          if (p.clear === '1') { writeNotes(''); return R('OK all notes deleted', { ok: true }) }
          if (p.forget) {
            const w = String(p.forget).toLowerCase(); const lines = readNotes().split('\n').filter(Boolean)
            const keep = lines.filter((l) => !l.toLowerCase().includes(w)); writeNotes(keep.join('\n'))
            return R(`OK deleted ${lines.length - keep.length} note(s) containing "${p.forget}"; ${keep.length} left`, { ok: true, removed: lines.length - keep.length })
          }
          const n = readNotes()
          return R(n ? `PROJECT NOTES:\n${n}` : '(no notes yet. Save facts for the next session: ' + base + '/remember?text=...)', { ok: true, notes: n.split('\n').filter(Boolean) })
        }
        // ---------- batch ----------
        case 'batch': {
          let items; try { items = batchItems(p) } catch (e) { return fail('bad "cmds": ' + e.message) }
          if (!items.length) return fail('no commands. Example: batch?cmds_b64=<base64 of lines like:  read?path=/a.js  /  grep?pattern=foo&path=/src >  (one command per line)')
          if (items.length > BATCH_MAX) return fail(`too many commands (${items.length}); max ${BATCH_MAX} per batch - split it`)
          const each = Math.min(60000, Math.max(500, Number(p.each) || 6000)); const cont = p.continue === '1' || p.continue === 'true'
          const outs = []; const results = []; let bad = 0, ran = 0
          for (let i = 0; i < items.length; i++) {
            let name = '', sp = new URLSearchParams()
            const it0 = items[i]
            try {
              if (it0.line !== undefined) {
                let line = it0.line.trim()
                const mm = line.match(/^https?:\/\/[^/]+\/agent\/[^/]+\/(.*)$/); if (mm) line = mm[1]
                const u = new URL('http://x/' + line.replace(/^\/+/, '')); name = u.pathname.replace(/^\/+/, ''); sp = u.searchParams
              } else {
                const o = { ...it0.obj }; name = String(o.command || o.name || '')
                delete o.command; delete o.name
                for (const [k, v] of Object.entries(o)) sp.set(k, typeof v === 'string' ? v : JSON.stringify(v))
              }
            } catch { name = '' }
            const head = `[${i + 1}/${items.length}] ${name || '?'}${[...sp.keys()].length ? '?' + [...sp.entries()].map(([k, v]) => `${k}=${v.length > 50 ? v.slice(0, 47) + '...' : v}`).join('&').slice(0, 160) : ''}`
            if (!name || /^(batch|shot|help|docs|files|proxy|shots)$/.test(name)) { outs.push(`${head}\nERROR: ${name ? `"${name}" is not allowed inside a batch` : 'cannot parse this line (expected: command?param=value&param2=value)'}`); results.push({ cmd: name, ok: false }); bad++; if (!cont) break; continue }
            sp.delete('format'); sp.delete('token')
            const u = new URL(`http://x/agent/${token}/${name}`); sp.forEach((v, k) => u.searchParams.set(k, v))
            let code = 0, body = ''
            const fres = { writeHead(c) { code = c }, end(d) { body += d ? String(d) : '' }, setHeader() {}, write(d) { body += String(d) } }
            await handle({ method: 'GET', headers: req.headers, url: u.pathname + u.search }, fres, u)
            ran++; const ok = code < 400 && !/^ERROR:/.test(body)
            if (!ok) bad++
            const t = body.length > each ? body.slice(0, each) + `\n...[shortened to ${each} chars; run this command alone to see everything]` : body
            outs.push(`${head}  ->  ${ok ? 'OK' : 'FAILED (HTTP ' + code + ')'}\n${t.replace(/\n+$/, '')}`); results.push({ cmd: name, ok, status: code })
            if (!ok && !cont) { if (i < items.length - 1) outs.push(`--- stopped after the first failure; ${items.length - 1 - i} command(s) NOT run (use &continue=1 to run all) ---`); break }
          }
          const text = `BATCH: ${ran} of ${items.length} command(s) run, ${bad ? bad + ' failed' : 'all OK'}\n\n` + outs.join('\n\n')
          return R(text.length > MAX_OUT * 2 ? text.slice(0, MAX_OUT * 2) + '\n...[batch output cut]' : text, { ok: !bad, results, text }, 200)
        }
        case 'mkdir': { const abs = safe(p.path); await fsp.mkdir(abs, { recursive: true }); return R(`OK created ${relOf(abs)}/`, { ok: true }) }
        case 'rm': { const abs = safe(p.path); if (abs === ROOT) return fail('refusing to delete root'); if (backups) await backups.save(abs, 'rm'); await fsp.rm(abs, { recursive: true, force: true }); return R(`OK deleted ${relOf(abs)}`, { ok: true }) }
        case 'mv': { const a = safe(p.from), b = safe(p.to); if (backups) { const g = 'mv' + Date.now() + Math.random(); await backups.save(b, 'mv', g); await backups.save(a, 'mv', g) } await fsp.mkdir(path.dirname(b), { recursive: true }); await fsp.rename(a, b); return R(`OK ${relOf(a)} -> ${relOf(b)}`, { ok: true }) }
        case 'cp': { const a = safe(p.from), b = safe(p.to); if (backups) await backups.save(b, 'cp'); await fsp.mkdir(path.dirname(b), { recursive: true }); await fsp.cp(a, b, { recursive: true }); return R(`OK copied to ${relOf(b)}`, { ok: true }) }
        case 'exec': {
          const command = val(p, 'cmd'); if (!command) return fail('missing "cmd" (or "cmd_b64")')
          const cwd = safe(p.cwd || DEFCWD); const t = Math.min(300, Math.max(1, Number(p.timeout) || 60)) * 1000
          const r = await runCmd(command, cwd, t, it)
          const note = r.code === 'timeout' ? ` (killed after ${t / 1000}s; for servers use /start)` : r.code === 'killed' ? ' (stopped by the user from the IDE)' : ''
          const text = `${r.output}${r.output && !r.output.endsWith('\n') ? '\n' : ''}${r.truncated ? '...[output truncated]\n' : ''}--- exit code: ${r.code}${note} ---`
          return R(text, { ok: r.code === 0, exit_code: r.code, output: r.output, truncated: r.truncated }, 200, { exit: r.code })
        }
        case 'start': {
          const command = val(p, 'cmd'); if (!command) return fail('missing "cmd"')
          const name = (p.name || 'p' + (procs.size + 1)).replace(/[^\w.-]/g, '_')
          const old = procs.get(name); if (old && alive(old.pid)) return fail(`process "${name}" already running (pid ${old.pid}); /stop it first`, 409)
          const log = path.join(LOGDIR, name + '.log'); const fd = fs.openSync(log, 'w')
          const c = spawn('bash', ['-c', command], { cwd: safe(p.cwd || DEFCWD), detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', WORKSPACE: ROOT } })
          c.unref(); procs.set(name, { pid: c.pid, cmd: command, log, started: Date.now() })
          await sleep(1500)
          const first = tail(log, 30); it.out = `[${name}] pid=${c.pid} running=${alive(c.pid)}\n${first}`
          return R(`OK started "${name}" pid=${c.pid} running=${alive(c.pid)}\n--- first output ---\n${first}\n--- next: ${base}/logs?name=${name} | ${base}/look?port=<port> | stop: ${base}/stop?name=${name}`, { ok: true, name, pid: c.pid, running: alive(c.pid) })
        }
        case 'logs': { const e = procs.get(p.name); if (!e) return fail('unknown process name; see /ps', 404); const l = tail(e.log, Number(p.tail) || 80); return R(`[${p.name}] running=${alive(e.pid)}\n` + l, { ok: true, running: alive(e.pid), log: l }) }
        case 'ps': { const l = [...procs].map(([n, e]) => ({ name: n, pid: e.pid, running: alive(e.pid), cmd: e.cmd })); return R(l.map((e) => `${e.name}  pid=${e.pid}  ${e.running ? 'running' : 'exited'}  ${e.cmd}`).join('\n') || '(no background processes)', { ok: true, processes: l }) }
        case 'stop': { const e = procs.get(p.name); if (!e) return fail('unknown process name', 404); try { process.kill(-e.pid, 'SIGTERM') } catch {}; return R(`OK stopped "${p.name}"`, { ok: true }) }
        case 'curl': {
          const target = p.url || `http://127.0.0.1:${Number(p.port) || 8000}${p.path || '/'}`
          const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000)
          const init = { method: (p.method || 'GET').toUpperCase(), signal: ctl.signal, redirect: 'follow' }
          if (p.body !== undefined && init.method !== 'GET') init.body = p.body
          const r = await fetch(target, init).catch((e) => { throw new Error('request failed: ' + e.message) }); clearTimeout(to)
          const ct = r.headers.get('content-type') || ''; const buf = Buffer.from(await r.arrayBuffer())
          const isText = /text|json|xml|javascript|svg/.test(ct) || !buf.subarray(0, 2000).includes(0)
          const body = isText ? buf.toString('utf8').slice(0, MAX_OUT) : `(binary ${buf.length} B)`
          return R(`HTTP ${r.status}  content-type: ${ct}  size: ${buf.length} B\n\n${body}${buf.length > MAX_OUT && isText ? '\n...[truncated]' : ''}`, { ok: r.ok, status: r.status, contentType: ct, body })
        }
        case 'download': {
          if (!p.url || !p.path) return fail('need "url" and "path"')
          const abs = safe(p.path); if (backups) await backups.save(abs, 'download'); const r = await fetch(p.url, { redirect: 'follow' })
          if (!r.ok) return fail('download failed: HTTP ' + r.status, 502)
          await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, Buffer.from(await r.arrayBuffer()))
          return R(`OK saved ${relOf(abs)} (${(await fsp.stat(abs)).size} B)`, { ok: true })
        }

        // ---------- браузер ----------
        case 'look': {
          const r = await browse({ forceOpen: true })
          return R(r.report, { ok: true, screenshot: `${base}/shots/${r.name}`, report: r.report }, 200, { shot: r.name })
        }
        case 'shot': {
          const r = await browse({ forceOpen: !!targetUrl() || p.open === '1', brief: true, shotOpts: { selector: p.selector || p.sel, clip: p.clip ? p.clip.split(',').map(Number) : null, full: p.full === '1' } })
          const buf = await fsp.readFile(path.join(SHOTS, r.name))
          finish(it, true, { shot: r.name }); it.out = 'screenshot'
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); return res.end(buf)
        }
        case 'act': case 'click': case 'type': case 'press': {
          let steps = parseSteps(p)
          if (cmd === 'type') steps = [`type:${p.sel}=${val(p, 'text') ?? ''}`]
          if (cmd === 'press') steps = [`press:${p.key}`]
          if (!steps.length) return fail('no steps. Example: act?steps=click:%23btn|text:%23display')
          const r = await browse({ steps, brief: p.brief !== '0' })
          const text = `STEPS:\n${r.stepLog.map((s) => '  ' + s).join('\n')}\n\n${r.report}`
          return R(text, { ok: !failedStep(r), steps: r.stepLog, screenshot: `${base}/shots/${r.name}`, report: r.report }, 200, { shot: r.name })
        }
        case 'eval': {
          const js = val(p, 'js'); if (!js) return fail('missing "js" (or "js_b64")')
          const B2 = await getBrowser()
          const out = await B2.locked(async () => {
            const page = await B2.ensure(); if (page.url() === 'about:blank') throw new Error('no page is open yet: use /look?file=... first')
            const res2 = await B2.evalJs(js); const logs = B2.freshLogs()
            return res2 + (logs.length ? '\n--- console during eval ---\n' + logs.map((l) => `[${l.k}] ${l.s}`).join('\n') : '')
          })
          return R(out, { ok: true, result: out })
        }
        case 'console': {
          const B3 = await getBrowser()
          const out = await B3.locked(async () => B3.freshLogs())
          return R(out.length ? out.map((l) => `[${l.k}] ${l.s}`).join('\n') : '(no new console/network messages)', { ok: true, logs: out })
        }
        case 'devices': {
          const B4 = await getBrowser()
          return R(B4.devicesText() + `\nUse: ${base}/look?file=/index.html&device=iPhone%2014   |   &dark=1  &net=slow3g  &lang=de-DE  &tz=Asia/Tokyo  &reduced=1  &reset=1`, { ok: true })
        }
        case 'emulate': {
          const B5 = await getBrowser()
          const eo = emuOpts()
          const out = await B5.locked(async () => { let re = false; if (eo) re = await B5.emulate(eo); return { re, line: B5.emuLine() } })
          return R(`OK emulation: ${out.line || 'none (desktop, defaults)'}${out.re ? '\n(browser context was recreated; the page is reopened by the next /look)' : ''}\nIt stays on for the next look/act/shot calls. Clear: ${base}/emulate?reset=1`, { ok: true, emulation: out.line })
        }
        case 'responsive': {
          const B6 = await getBrowser()
          const sizes = String(p.sizes || '375x667,768x1024,1280x800').split(/[,|\s]+/).map((x) => x.match(/^(\d{2,4})x(\d{2,4})$/)).filter(Boolean).slice(0, 6).map((m) => [Number(m[1]), Number(m[2])])
          if (!sizes.length) return fail('bad "sizes": use e.g. sizes=375x667,768x1024,1280x800')
          const schemes = p.dark === 'both' ? ['light', 'dark'] : p.dark === '1' ? ['dark'] : ['light']
          const eo = emuOpts(); if (eo) { delete eo.device; delete eo.dark }
          const rows = []
          await B6.locked(async () => {
            if (eo && Object.keys(eo).length) await B6.emulate(eo)
            const page = await B6.ensure(sizes[0][0], sizes[0][1])
            const target = targetUrl()
            if (target) await B6.goto(target); else if (page.url() === 'about:blank') throw new Error('no page is open yet: pass file=/path.html, port=8000 or url=https://...')
            for (const sc of schemes) for (const [w, h] of sizes) {
              await B6.setView(w, h, sc); await page.waitForTimeout(300)
              const L = await B6.look({ brief: '1', full: p.full })
              rows.push({ w, h, sc, name: L.name, issues: L.a.issues })
            }
            await B6.applyLive()
          })
          let sheetText = '', sheetShot = ''
          try {
            const r = await eyes.sheet({ files: rows.map((r2) => r2.name).join('|'), cols: String(Math.min(3, sizes.length)) }, base)
            sheetShot = r.names && r.names[0]; sheetText = r.text.split('\n').slice(0, 2).join('\n')
          } catch (e) { sheetText = 'contact sheet failed: ' + e.message }
          const bad = rows.filter((r2) => r2.issues.length)
          const L2 = [`RESPONSIVE CHECK: ${rows.length} view(s) - ${bad.length ? bad.length + ' with layout problems' : 'no layout problems detected'}`]
          for (const r2 of rows) {
            L2.push(`  ${String(r2.w + 'x' + r2.h).padEnd(9)} ${r2.sc.padEnd(5)} ${r2.issues.length ? r2.issues.length + ' problem(s)' : 'ok'}   screenshot: ${base}/shots/${r2.name}`)
            for (const i of r2.issues.slice(0, 6)) L2.push(`      ! ${i}`)
          }
          if (sheetText) L2.push('', sheetText)
          L2.push(`Fix problems (smallest width first), then run /responsive again. One size in detail: ${base}/look?w=<w>&h=<h>`)
          return R(L2.join('\n'), { ok: true, views: rows.map((r2) => ({ w: r2.w, h: r2.h, scheme: r2.sc, issues: r2.issues, screenshot: `${base}/shots/${r2.name}` })) }, 200, sheetShot ? { shot: sheetShot } : {})
        }
        // ---------- «глаза»: картинки и видео ----------
        case 'selftest': {
          const r = await eyes.selftest(base)
          return R(r.text, { ok: !r.bad, problems: r.bad, report: r.text }, 200)
        }
        case 'view': case 'compare': case 'sheet': case 'frames': case 'tiles': case 'style': {
          const r = await eyes[cmd](p, base)
          const shot = r.names && r.names[0]
          return R(r.text, { ok: true, report: r.text, images: (r.names || []).map((n) => `${base}/shots/${n}`), ...(r.extra || {}) }, 200, shot ? { shot } : {})
        }
        default: {
          const ext = extra.commands && extra.commands[cmd]
          if (!ext) return fail(`unknown command "${cmd}"`, 404)
          const r = await ext(p, { base, it, val, safe, relOf, ROOT, say })
          const text = typeof r === 'string' ? r : (r && r.text) || ''
          const obj = typeof r === 'string' ? { ok: true, text } : { ok: true, ...r }
          return R(text, obj, 200, (r && r.extra) || {})
        }
      }
    } catch (e) {
      const code = e.http || (e.code === 403 ? 403 : e.code === 'ENOENT' ? 404 : 500)
      return fail((e.code === 'ENOENT' ? 'not found: ' + (p.path || p.from || '') : e.message) + (e.code && e.code !== 403 && !e.http ? ` [${e.code}]` : ''), code)
    }
  }
  handle.shotsDir = SHOTS
  handle.closeBrowser = () => { try { if (browser) browser.close() } catch {} }
  return handle
}
