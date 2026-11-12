// Headless-браузер для ИИ-агента: открыть страницу, "увидеть" её (текстовый отчёт + скриншот),
// кликать/вводить/выполнять JS. Один общий браузер, закрывается после простоя.
// Надёжность: КАЖДАЯ операция ограничена по времени; если что-то зависло - браузер убивается и
// поднимается заново (раньше одна зависшая операция навсегда блокировала очередь и /look "висел").
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, devices } from 'playwright-core'
import { labMain } from './lab.js'
import { findBrowserExecutable } from '../paths.js'

const HOME = os.homedir()
const ROOTS = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/home/user/.pw-browsers', path.join(HOME, '.pw-browsers'), path.join(HOME, '.cache/ms-playwright'), '/ms-playwright'].filter(Boolean)
export function findExe() {
  const shared = findBrowserExecutable()
  if (shared) return shared
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH
  for (const root of ROOTS) {
    let dirs = []
    try { dirs = fs.readdirSync(root).sort().reverse() } catch { continue }
    for (const d of dirs) {
      const cands = d.startsWith('chromium_headless_shell') ? [path.join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), path.join(root, d, 'chrome-linux', 'headless_shell')]
        : /^chromium-\d+/.test(d) ? [path.join(root, d, 'chrome-linux64', 'chrome'), path.join(root, d, 'chrome-linux', 'chrome')] : []
      for (const e of cands) if (fs.existsSync(e)) return e
    }
  }
  for (const e of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(e)) return e
  return undefined
}

export const withTimeout = (p, ms, label) => {
  let t
  return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`TIMEOUT after ${Math.round(ms / 1000)}s: ${label}`)), ms) })]).finally(() => clearTimeout(t))
}

// превращает сырую ошибку запуска в понятную подсказку для агента
export function launchHint(e) {
  const m = String(e && e.message || e)
  if (/error while loading shared libraries|libatk|libnss|libgbm|libasound|cannot open shared object/i.test(m)) {
    return 'Chromium cannot start: system libraries are missing. FIX: run  sudo npx playwright-core install-deps chromium  (or reinstall: curl -fsSL https://raw.githubusercontent.com/houlwave/bratcode/main/install.sh | bash), then retry /selftest. Raw: ' + m.split('\n').find((l) => /shared libraries|lib\w+\.so/.test(l))
  }
  if (/Executable doesn't exist|no such file|ENOENT|not found/i.test(m) || !findExe()) {
    return 'Chromium is not installed. FIX: install Google Chrome / Brave, or run: PLAYWRIGHT_BROWSERS_PATH=~/.bratcode-data/browsers npx playwright-core install chromium-headless-shell ; retry /selftest.'
  }
  return 'Chromium failed to start: ' + m.split('\n')[0]
}

export function createBrowser({ shotsDir }) {
  fs.mkdirSync(shotsDir, { recursive: true })
  let browser = null, page = null, idle = null, vp = { width: 1280, height: 800 }
  let ctx = null, cdp = null, pendingUrl = '', netWasSet = false
  const EMU0 = { device: '', dark: null, reduced: false, net: '', lang: '', tz: '', dpr: 0 }
  let emu = { ...EMU0 }
  let logs = [], cursor = 0
  let chain = Promise.resolve()
  let epoch = 0
  // Очередь операций с общим таймаутом. Если операция не уложилась - убиваем браузер (самолечение),
  // очередь освобождается, следующая операция стартует с чистого листа.
  const locked = (fn, ms = 45000, label = 'browser operation') => {
    const run = () => withTimeout(fn(), ms, label).catch(async (e) => { if (/^TIMEOUT/.test(e.message)) await hardKill(); throw e })
    const r = chain.then(run, run)
    chain = r.catch(() => {})
    return r
  }
  async function hardKill() {
    epoch++
    clearTimeout(idle)
    const b = browser; browser = null; page = null; ctx = null; cdp = null
    try { b?.process?.()?.kill('SIGKILL') } catch {}
    try { await withTimeout(b?.close() ?? 0, 3000, 'close') } catch {}
  }
  async function close() {
    clearTimeout(idle)
    const b = browser; browser = null; page = null; ctx = null; cdp = null
    try { await withTimeout(b?.close() ?? 0, 4000, 'close') } catch { try { b?.process?.()?.kill('SIGKILL') } catch {} }
  }
  async function launch() {
    const exe = findExe()
    const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--force-color-profile=srgb']
    try { return await withTimeout(chromium.launch({ executablePath: exe, args, timeout: 20000 }), 25000, 'launching Chromium') }
    catch (e) { const err = new Error(launchHint(e)); err.launch = true; throw err }
  }
  async function ensure(w, h) {
    if (!browser || !browser.isConnected()) {
      browser = await launch()
      const my = browser
      browser.on('disconnected', () => { if (browser === my) { browser = null; page = null; ctx = null; cdp = null } })
    }
    let justMade = false
    if (!page || page.isClosed()) {
      justMade = true
      if (ctx) { try { await ctx.close() } catch {} }
      const dev = emu.device && devices[emu.device] ? devices[emu.device] : null
      const co = { ...(dev || {}), viewport: vp, ignoreHTTPSErrors: true }
      delete co.defaultBrowserType
      if (emu.dpr) co.deviceScaleFactor = emu.dpr
      if (emu.lang) co.locale = emu.lang
      if (emu.tz) co.timezoneId = emu.tz
      ctx = await browser.newContext(co); cdp = null
      page = await ctx.newPage()
      page.setDefaultTimeout(5000)
      page.on('console', (m) => logs.push({ k: m.type() === 'error' ? 'console.error' : m.type() === 'warning' ? 'console.warn' : 'console.log', s: m.text().slice(0, 300) }))
      page.on('pageerror', (e) => logs.push({ k: 'JS-ERROR', s: String(e.message).slice(0, 300) }))
      page.on('requestfailed', (r) => logs.push({ k: 'net-fail', s: `${r.method()} ${r.url()} ${r.failure()?.errorText || ''}`.slice(0, 300) }))
      page.on('response', (r) => { if (r.status() >= 400) logs.push({ k: 'http-' + r.status(), s: r.url().slice(0, 300) }) })
      page.on('dialog', (d) => { logs.push({ k: 'dialog', s: `${d.type()}: ${d.message()}` }); d.dismiss().catch(() => {}) })
    }
    if (w && h && (w !== vp.width || h !== vp.height)) { vp = { width: w, height: h }; await page.setViewportSize(vp) }
    clearTimeout(idle); idle = setTimeout(close, 120_000)
    if (justMade) {
      await applyLive()
      if (pendingUrl) { const u = pendingUrl; pendingUrl = ''; try { await goto(u) } catch {} }   // устройство сменилось -> открываем ту же страницу заново
    }
    return page
  }

  // ---- эмуляция ----
  const NETS = { offline: { offline: true }, slow3g: { latency: 400, down: 50 * 1024, up: 50 * 1024 }, '3g': { latency: 150, down: 200 * 1024, up: 100 * 1024 }, '4g': { latency: 40, down: 1500 * 1024, up: 750 * 1024 }, fast: null, none: null, off: null }
  async function applyLive() {
    if (!page || page.isClosed()) return
    await page.emulateMedia({ colorScheme: emu.dark === null ? null : emu.dark ? 'dark' : 'light', reducedMotion: emu.reduced ? 'reduce' : null }).catch(() => {})
    if (!emu.net && !netWasSet) return
    const n = NETS[emu.net] || null
    try {
      await ctx.setOffline(!!(n && n.offline))
      cdp = cdp || await ctx.newCDPSession(page)
      await cdp.send('Network.emulateNetworkConditions', n && !n.offline ? { offline: false, latency: n.latency, downloadThroughput: n.down, uploadThroughput: n.up } : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
      netWasSet = !!emu.net
    } catch {}
  }
  const findDevice = (d) => {
    const names = Object.keys(devices); const q = String(d).toLowerCase().trim()
    return names.find((k) => k.toLowerCase() === q) || names.find((k) => k.toLowerCase().includes(q) && !/landscape/i.test(k))
  }
  // o: {device, dark:'1'|'0'|'auto', reduced, net, lang, tz, dpr, reset}; -> true, если пересоздан контекст
  async function emulate(o) {
    if (!o) return false
    const before = { ...emu }
    if (o.reset) emu = { ...EMU0 }
    if (o.device !== undefined) {
      const d = String(o.device)
      if (/^(none|desktop|off|reset)?$/i.test(d)) emu.device = ''
      else { const k = findDevice(d); if (!k) throw new Error(`unknown device "${d}". Open /devices for the list (a part of the name is enough, e.g. device=iPhone%2014)`); emu.device = k }
    }
    if (o.dark !== undefined) emu.dark = o.dark === true || o.dark === '1' || o.dark === 'dark' ? true : o.dark === false || o.dark === '0' || o.dark === 'light' ? false : null
    if (o.reduced !== undefined) emu.reduced = o.reduced === true || o.reduced === '1'
    if (o.net !== undefined) { const n = String(o.net).toLowerCase(); if (n && !(n in NETS)) throw new Error(`unknown net "${o.net}": use offline | slow3g | 3g | 4g | fast`); emu.net = /^(none|off|fast)$/.test(n) ? '' : n }
    if (o.lang !== undefined) emu.lang = String(o.lang)
    if (o.tz !== undefined) emu.tz = String(o.tz)
    if (o.dpr !== undefined) emu.dpr = Math.min(4, Math.max(0, Number(o.dpr) || 0))
    const key = (e) => [e.device, e.lang, e.tz, e.dpr].join('|')
    const needCtx = key(before) !== key(emu)
    if (needCtx) {
      if (before.device !== emu.device) { const dv = emu.device && devices[emu.device]; vp = dv ? { ...dv.viewport } : { width: 1280, height: 800 } }
      if (page && !page.isClosed()) { const u = page.url(); if (u && u !== 'about:blank') pendingUrl = u }
      try { await ctx?.close() } catch {}
      ctx = null; page = null; cdp = null
    } else await applyLive()
    return needCtx
  }
  const emuLine = () => {
    const a = []
    if (emu.device) { const d = devices[emu.device]; a.push(`device ${emu.device} (${d.viewport.width}x${d.viewport.height} @${d.deviceScaleFactor}x${d.isMobile ? ', mobile' : ''}${d.hasTouch ? ', touch' : ''})`) }
    if (emu.dark !== null) a.push(emu.dark ? 'dark color scheme' : 'light color scheme')
    if (emu.reduced) a.push('reduced motion')
    if (emu.net) a.push('network ' + emu.net)
    if (emu.lang) a.push('lang ' + emu.lang)
    if (emu.tz) a.push('timezone ' + emu.tz)
    if (emu.dpr) a.push('dpr ' + emu.dpr)
    return a.join(', ')
  }
  const POPULAR = ['iPhone SE', 'iPhone 14', 'iPhone 14 Pro Max', 'Pixel 7', 'Galaxy S9+', 'iPad Mini', 'iPad (gen 7)', 'iPad Pro 11', 'Galaxy Tab S4', 'Desktop Chrome', 'Desktop Chrome HiDPI']
  function devicesText() {
    const row = (k) => { const d = devices[k]; return `  ${k.padEnd(22)} ${String(d.viewport.width + 'x' + d.viewport.height).padEnd(10)} @${d.deviceScaleFactor}x ${d.isMobile ? 'mobile' : 'desktop'}${d.hasTouch ? ' touch' : ''}` }
    const pop = POPULAR.filter((k) => devices[k]); const n = Object.keys(devices).length
    return `COMMON DEVICES (${n} in total; any part of a name works):\n${pop.map(row).join('\n')}`
  }
  async function setView(w, h, scheme) {
    vp = { width: w, height: h }; await page.setViewportSize(vp)
    if (scheme) await page.emulateMedia({ colorScheme: scheme }).catch(() => {})
  }

  function prune() {
    const files = fs.readdirSync(shotsDir).filter((f) => /^[a-z]+\d+.*\.(png|jpg|webp)$/i.test(f)).sort()
    for (const f of files.slice(0, Math.max(0, files.length - 80))) fs.rmSync(path.join(shotsDir, f), { force: true })
  }
  // opts: {full, selector, clip:[x,y,w,h], dpr}
  async function shot(opts = false) {
    if (typeof opts === 'boolean') opts = { full: opts }
    const name = `s${Date.now()}.png`
    const o = { path: path.join(shotsDir, name), timeout: 8000, scale: 'css' }
    if (opts.selector) {
      const loc = page.locator(opts.selector).first()
      if (!(await loc.count())) throw new Error('no element matches ' + opts.selector)
      await loc.screenshot(o)
    } else {
      if (opts.clip) o.clip = { x: opts.clip[0], y: opts.clip[1], width: opts.clip[2], height: opts.clip[3] }
      o.fullPage = !!opts.full || (!!opts.clip && opts.clipPage)
      await page.screenshot(o)
    }
    prune()
    return name
  }

  // ---- image lab: labMain выполняется в Chromium (canvas), на отдельной пустой странице ----
  async function lab(job) {
    if (!browser || !browser.isConnected()) await ensure()
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } })
    try {
      const pg = await ctx.newPage()
      pg.setDefaultTimeout(30000)
      await pg.goto('about:blank')
      return await withTimeout(pg.evaluate(new Function('job', 'return (' + labMain.toString() + ')(job)'), job), 60000, 'image lab')
    } finally { await ctx.close().catch(() => {}) }
  }

  // ---- анализ страницы (выполняется в браузере) ----
  const analyze = () => {
    const vw = innerWidth, vh = innerHeight
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0' }
    const selOf = (el) => {
      const parts = []; let e = el
      while (e && e.nodeType === 1 && e !== document.documentElement && parts.length < 4) {
        if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break }
        let s = e.tagName.toLowerCase()
        if (e.classList.length) s += '.' + [...e.classList].slice(0, 2).map((c) => CSS.escape(c)).join('.')
        const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : []
        if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(e) + 1})`
        parts.unshift(s); e = e.parentElement
      }
      return parts.join(' > ')
    }
    const rgba = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return [255, 255, 255, 1]; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]] }
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0.5) return c } return [255, 255, 255, 1] }
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
    const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
    const R = (r) => ({ x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) })

    const inter = [...document.querySelectorAll('a[href],button,input,select,textarea,summary,[role=button],[onclick],[tabindex]:not([tabindex="-1"])')].filter(vis).slice(0, 120)
    const els = inter.map((el, i) => {
      const cs = getComputedStyle(el)
      const label = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || el.alt || '').trim().replace(/\s+/g, ' ').slice(0, 40)
      return { i: i + 1, tag: el.tagName.toLowerCase() + (el.type && el.tagName === 'INPUT' ? `[${el.type}]` : ''), label, sel: selOf(el), r: R(el.getBoundingClientRect()), disabled: !!el.disabled, value: ('value' in el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'button' && el.type !== 'submit') ? String(el.value).slice(0, 80) : undefined, color: hex(rgba(cs.color)), bg: hex(bgOf(el)), cursor: cs.cursor }
    })
    const headings = [...document.querySelectorAll('h1,h2,h3')].filter(vis).slice(0, 15).map((h) => ({ tag: h.tagName.toLowerCase(), text: h.innerText.trim().slice(0, 60), r: R(h.getBoundingClientRect()) }))
    const blocks = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    for (let n = walker.nextNode(); n && blocks.length < 40; n = walker.nextNode()) {
      if (inter.includes(n) || n.closest('a,button,select,textarea') || /^(H1|H2|H3|SCRIPT|STYLE)$/.test(n.tagName)) continue
      const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join(' ').trim()
      if (own && vis(n)) blocks.push({ text: own.slice(0, 40), r: R(n.getBoundingClientRect()) })
    }
    const imgs = [...document.images].filter(vis).slice(0, 20).map((im) => ({ src: (im.currentSrc || im.src).slice(-50), broken: im.complete && im.naturalWidth === 0, r: R(im.getBoundingClientRect()) }))

    // ---- проблемы вёрстки ----
    const issues = []
    const docW = document.documentElement.scrollWidth, docH = document.documentElement.scrollHeight
    if (docW > vw + 1) issues.push(`horizontal overflow: page is ${docW}px wide but viewport is ${vw}px (content is cut off or needs horizontal scroll)`)
    const clipped = []
    for (const el of document.body.querySelectorAll('*')) {
      if (clipped.length >= 5) break
      if (!vis(el) || el.closest('svg')) continue
      const r = el.getBoundingClientRect()
      if ((r.right > vw + 2 || r.left < -2) && el.children.length === 0) clipped.push(selOf(el) + ` (x ${Math.round(r.left)}..${Math.round(r.right)})`)
    }
    if (clipped.length) issues.push('elements outside the viewport horizontally: ' + clipped.join('; '))
    const ov = []
    for (let a = 0; a < Math.min(els.length, 80); a++) for (let b = a + 1; b < Math.min(els.length, 80); b++) {
      const A = els[a].r, B = els[b].r
      const ix = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x), iy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y)
      if (ix > 4 && iy > 4 && ix * iy > 0.3 * Math.min(A.w * A.h, B.w * B.h) && !inter[a].contains(inter[b]) && !inter[b].contains(inter[a])) ov.push(`"${els[a].label || els[a].tag}" overlaps "${els[b].label || els[b].tag}"`)
    }
    if (ov.length) issues.push('overlapping interactive elements: ' + ov.slice(0, 5).join('; '))
    const lowc = []
    for (const el of [...inter, ...document.querySelectorAll('p,span,li,h1,h2,h3,label,td,div')].slice(0, 400)) {
      if (lowc.length >= 6) break
      const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())
      if ((!own && !el.value) || !vis(el)) continue
      const cs = getComputedStyle(el); const fg = rgba(cs.color), bg = bgOf(el)
      const cr = contrast(fg, bg)
      if (cr < 3) lowc.push(`${selOf(el)} text ${hex(fg)} on ${hex(bg)} contrast ${cr.toFixed(1)}:1`)
    }
    if (lowc.length) issues.push('low text contrast (<3:1): ' + lowc.join('; '))
    let small = 0; for (const el of document.body.querySelectorAll('*')) { if ([...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) && vis(el) && parseFloat(getComputedStyle(el).fontSize) < 11) small++ }
    if (small) issues.push(`${small} text element(s) with font-size < 11px (hard to read)`)
    if (vw < 600) { const t = els.filter((e) => !e.disabled && (e.r.w < 32 || e.r.h < 32)); if (t.length) issues.push(`${t.length} touch target(s) smaller than 32px on a narrow screen, e.g. "${t[0].label || t[0].tag}" ${t[0].r.w}x${t[0].r.h}`) }
    const brokenImgs = imgs.filter((i) => i.broken); if (brokenImgs.length) issues.push('broken images: ' + brokenImgs.map((i) => i.src).join(', '))
    if (!document.body.innerText.trim() && !imgs.length && !document.querySelector('canvas,svg,video,iframe')) issues.push('page looks EMPTY (no visible text, images or canvas) - script error or missing content?')
    if (!document.querySelector('meta[name=viewport]')) issues.push('no <meta name="viewport"> - page will not be responsive on phones')

    const bs = getComputedStyle(document.body)
    return {
      title: document.title, url: location.href, vw, vh, docW, docH, scrollY: Math.round(scrollY),
      text: document.body.innerText.replace(/\n{3,}/g, '\n\n').trim().slice(0, 2500),
      body: { bg: hex(bgOf(document.body)), color: hex(rgba(bs.color)), font: bs.fontFamily.split(',')[0].replace(/["']/g, ''), size: bs.fontSize },
      headings, els, blocks, imgs, issues,
    }
  }

  function wireframe(a) {
    const cols = 100, sx = a.vw / cols, sy = sx * 2
    const rows = Math.max(6, Math.min(48, Math.ceil(a.vh / sy)))
    const g = Array.from({ length: rows }, () => Array(cols).fill(' '))
    const put = (x, y, ch) => { if (y >= 0 && y < rows && x >= 0 && x < cols) g[y][x] = ch }
    const text = (x, y, s, max) => { for (let i = 0; i < Math.min(s.length, max); i++) put(x + i, y, s[i]) }
    const items = [
      ...a.headings.map((h) => ({ r: h.r, label: h.text, box: false })),
      ...a.blocks.map((b) => ({ r: b.r, label: b.text, box: false })),
      ...a.imgs.map((i) => ({ r: i.r, label: 'IMG', box: true })),
      ...a.els.map((e) => ({ r: e.r, label: e.label || e.tag, box: true })),
    ].map((it) => ({ ...it, y: it.r.y - a.scrollY })).filter((it) => it.y < a.vh && it.y + it.r.h > 0)
      .sort((p, q) => q.r.w * q.r.h - p.r.w * p.r.h)
    for (const it of items) {
      const x0 = Math.max(0, Math.floor(it.r.x / sx)), x1 = Math.min(cols - 1, Math.floor((it.r.x + it.r.w) / sx))
      const y0 = Math.max(0, Math.floor(it.y / sy)), y1 = Math.min(rows - 1, Math.floor((it.y + it.r.h) / sy))
      if (it.box && x1 - x0 >= 3 && y1 - y0 >= 2) {
        for (let x = x0; x <= x1; x++) { put(x, y0, '-'); put(x, y1, '-') }
        for (let y = y0; y <= y1; y++) { put(x0, y, '|'); put(x1, y, '|') }
        put(x0, y0, '+'); put(x1, y0, '+'); put(x0, y1, '+'); put(x1, y1, '+')
        text(x0 + 1, Math.round((y0 + y1) / 2), it.label, x1 - x0 - 1)
      } else if (it.box) text(x0, y0, `[${it.label}]`, Math.max(4, x1 - x0 + 3))
      else text(x0, y0, it.label, Math.max(6, x1 - x0 + 1))
    }
    const top = '+' + '-'.repeat(cols) + '+'
    return [top, ...g.map((r) => '|' + r.join('').replace(/\s+$/, '').padEnd(cols) + '|'), top].join('\n') + `\n(1 char = ${Math.round(sx)}x${Math.round(sy)} px; viewport ${a.vw}x${a.vh})`
  }

  function report(a, shotUrl, { brief = false } = {}) {
    const errs = logs.filter((l) => /error|JS-ERROR|net-fail|http-/i.test(l.k) && !l.k.endsWith('.log'))
    const L = []
    L.push(`PAGE: "${a.title}"  ${a.url}`)
    if (emuLine()) L.push(`EMULATION: ${emuLine()}   (stays on for next calls; &reset=1 clears)`)
    L.push(`VIEWPORT: ${a.vw}x${a.vh}   PAGE SIZE: ${a.docW}x${a.docH}${a.docH > a.vh ? ` (scrollable, scrollY=${a.scrollY})` : ''}`)
    L.push(`ERRORS: ${errs.length ? errs.length : 'none'}${errs.length ? '\n' + errs.slice(0, 10).map((e) => `  - [${e.k}] ${e.s}`).join('\n') : ''}`)
    const other = logs.filter((l) => !errs.includes(l)).slice(-5)
    if (other.length) L.push('CONSOLE:\n' + other.map((e) => `  - [${e.k}] ${e.s}`).join('\n'))
    if (shotUrl) L.push(`SCREENSHOT (image, for AIs that can view images): ${shotUrl}`)
    L.push('LAYOUT CHECK: ' + (a.issues.length ? '\n' + a.issues.map((s) => '  ! ' + s).join('\n') : 'no problems detected (no overflow, overlap, low contrast)'))
    L.push(`VISIBLE TEXT:\n${(brief ? a.text.slice(0, 600) : a.text).split('\n').map((l) => '  ' + l).join('\n')}`)
    const vals = a.els.filter((e) => e.value !== undefined)
    if (vals.length) L.push('FIELD VALUES (inputs/displays):\n' + vals.map((e) => `  ${e.sel} = ${JSON.stringify(e.value)}`).join('\n'))
    if (brief) return L.join('\n')
    L.push(`STYLE: background ${a.body.bg}, text ${a.body.color}, font "${a.body.font}" ${a.body.size}`)
    if (a.headings.length) L.push('HEADINGS:\n' + a.headings.map((h) => `  ${h.tag} "${h.text}" at (${h.r.x},${h.r.y})`).join('\n'))
    L.push(`INTERACTIVE ELEMENTS (${a.els.length}) - use the selector in /click or /act:\n` + (a.els.map((e) => `  [${e.i}] ${e.tag} "${e.label}"  sel: ${e.sel}   at (${e.r.x},${e.r.y}) ${e.r.w}x${e.r.h}${e.disabled ? ' DISABLED' : ''}${e.value !== undefined ? ' value=' + JSON.stringify(e.value) : ''}  text ${e.color} on ${e.bg}`).join('\n') || '  (none)'))
    L.push('WIREFRAME (ASCII layout of the current viewport; boxes = buttons/inputs, text = headings/labels):\n' + wireframe(a))
    return L.join('\n')
  }

  async function look(p) {
    const a = await withTimeout(page.evaluate(analyze), 10000, 'page analysis (page script is probably stuck in an infinite loop)')
    const name = await shot(p.shotOpts || { full: p.full === '1' })
    return { name, text: (u) => report(a, u(name), { brief: p.brief === '1' }), a }
  }

  async function goto(url) {
    logs = []; cursor = 0
    // 'commit' = сервер ответил; дальше ждём DOMContentLoaded/load ограниченное время и идём дальше в любом случае:
    // страница с недоступным внешним <script src> иначе держала бы DOMContentLoaded вечно (и /look висел 15+ c).
    const resp = await page.goto(url, { waitUntil: 'commit', timeout: 15000 }).catch((e) => { throw new Error('cannot open page: ' + e.message.split('\n')[0] + (emu.net === 'offline' ? '  [emulation: network offline is ON -> add net=fast or reset=1 to go back online]' : '')) })
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { logs.push({ k: 'net-fail', s: 'DOMContentLoaded did not fire in 5s (a blocking <script src> is probably unreachable) - showing the page as it is' }) })
    await Promise.race([page.waitForLoadState('load', { timeout: 3000 }).catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
    await page.waitForTimeout(300)
    return resp
  }

  // Изолированная проверка «Chromium жив»: отдельный контекст, не трогает страницу агента.
  async function probe() {
    if (!browser || !browser.isConnected()) await ensure()
    const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } })
    try {
      const pg = await ctx.newPage()
      await pg.setContent('<html><body style="margin:0;background:#fff"><div id=a style="width:120px;height:80px;background:#e33;margin:20px"></div><h1 id=h>Hello</h1></body></html>', { waitUntil: 'commit', timeout: 5000 })
      await pg.waitForSelector('#h', { timeout: 5000 })
      const t = await withTimeout(pg.evaluate('document.getElementById("h").innerText + "/" + document.getElementById("a").getBoundingClientRect().width'), 5000, 'probe eval')
      const file = path.join(shotsDir, `p${Date.now()}.png`)
      await pg.screenshot({ path: file, timeout: 8000 })
      return { text: t, file }
    } finally { await ctx.close().catch(() => {}) }
  }

  const fixSel = (s) => (/^text=[^"']/.test(s) ? `text="${s.slice(5)}"` : s)

  async function runSteps(steps) {
    const out = []; let n = 0
    for (const raw of steps) {
      const st = raw.trim(); if (!st) continue; n++
      const i = st.indexOf(':'); const act = (i < 0 ? st : st.slice(0, i)).toLowerCase(); const arg = i < 0 ? '' : st.slice(i + 1)
      try {
        if (act === 'click' || act === 'dblclick' || act === 'hover') {
          const loc = page.locator(fixSel(arg)); const c = await loc.count()
          if (!c) throw new Error('no element matches ' + arg)
          await loc.first()[act === 'hover' ? 'hover' : act === 'dblclick' ? 'dblclick' : 'click']({ timeout: 4000 })
          out.push(`${n}. ${act} ${arg} OK${c > 1 ? ` (${c} matches, used the first)` : ''}`)
        } else if (act === 'type' || act === 'fill') {
          const eq = arg.indexOf('='); if (eq < 0) throw new Error('use type:SELECTOR=TEXT')
          await page.locator(fixSel(arg.slice(0, eq))).first().fill(arg.slice(eq + 1), { timeout: 4000 }); out.push(`${n}. type into ${arg.slice(0, eq)} OK`)
        } else if (act === 'keys') { await page.keyboard.type(arg, { delay: 30 }); out.push(`${n}. keys "${arg}" OK`) }
        else if (act === 'press') { await page.keyboard.press(arg); out.push(`${n}. press ${arg} OK`) }
        else if (act === 'wait') { await page.waitForTimeout(Math.min(5000, Number(arg) || 300)); out.push(`${n}. wait ${arg} OK`) }
        else if (act === 'scroll') { await page.evaluate((y) => window.scrollTo(0, Number(y) || 0), arg); out.push(`${n}. scroll to ${arg} OK`) }
        else if (act === 'text') { const t = await page.locator(fixSel(arg)).first().innerText({ timeout: 3000 }); out.push(`${n}. text of ${arg} = ${JSON.stringify(t.slice(0, 500))}`) }
        else if (act === 'eval') { out.push(`${n}. eval => ${await evalJs(arg)}`) }
        else if (act === 'viewport') { const [w, h] = arg.split('x').map(Number); await page.setViewportSize({ width: w, height: h }); vp = { width: w, height: h }; out.push(`${n}. viewport ${w}x${h} OK`) }
        else throw new Error('unknown step "' + act + '" (click,dblclick,hover,type,keys,press,wait,scroll,text,eval,viewport)')
        await page.waitForTimeout(80)
      } catch (e) { out.push(`${n}. ${st} FAILED: ${String(e.message).split('\n')[0]}`); break }
    }
    return out
  }

  async function evalJs(js) {
    let r
    try { r = await withTimeout(page.evaluate(js), 10000, 'eval') } catch (e1) {
      if (/^TIMEOUT/.test(e1.message)) throw e1
      try { r = await withTimeout(page.evaluate(`(()=>{${js}})()`), 10000, 'eval') } catch (e2) { throw new Error(String(e1.message).split('\n')[0]) }
    }
    const s = typeof r === 'string' ? r : JSON.stringify(r)
    return String(s).slice(0, 3000)
  }

  return {
    locked, close, hardKill, ensure, goto, look, shot, lab, probe, runSteps, evalJs, report, emulate, emuLine, devicesText, setView, applyLive,
    getPage: () => page, freshLogs: () => { const f = logs.slice(cursor); cursor = logs.length; return f },
    isOpen: () => !!page && !page.isClosed(),
  }
}
