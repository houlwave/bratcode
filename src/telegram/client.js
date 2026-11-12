// Personal Telegram (MTProto via GramJS). Session lives in ~/.bratcode-data/telegram.json (0600).
import fs from 'node:fs';
import * as TG from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger } from 'telegram/extensions/Logger.js';
import { TG_SESSION_FILE, readJsonSafe, writeJsonAtomic, readSettings } from '../paths.js';

const T = TG.default || TG;
const { TelegramClient, Api } = T;

// Public Telegram Desktop credentials (open source). Override with your own from https://my.telegram.org:
//   BRATCODE_TG_API_ID / BRATCODE_TG_API_HASH, or "tgApiId"/"tgApiHash" in ~/.bratcode-data/settings.json
const DEFAULT_API_ID = 2040;
const DEFAULT_API_HASH = 'b18441a1ff607e10a989891a5462e627';

export function apiCreds() {
  const s = readSettings();
  const id = Number(process.env.BRATCODE_TG_API_ID || s.tgApiId || DEFAULT_API_ID);
  const hash = String(process.env.BRATCODE_TG_API_HASH || s.tgApiHash || DEFAULT_API_HASH);
  return { apiId: id, apiHash: hash };
}

const quietLogger = () => new Logger('none');
const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function fmtDate(unix) {
  const d = new Date(unix * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${DAYS[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const idStr = (x) => (x === undefined || x === null ? '' : String(x.value ?? x));

export function entityName(e) {
  if (!e) return '?';
  if (e.title) return e.title;
  const n = [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
  return n || (e.username ? '@' + e.username : String(idStr(e.id)));
}

export function entityKind(e) {
  if (!e) return 'chat';
  if (e.className === 'User') return e.bot ? 'bot' : 'user';
  if (e.className === 'Channel') return e.megagroup ? 'group' : 'channel';
  return 'group';
}

export class TgService {
  constructor({ file = TG_SESSION_FILE, factory } = {}) {
    this.file = file;
    this.factory = factory; // for tests
    this.client = null;
    this.me = null;
    this.connecting = null;
  }

  loadSession() {
    const j = readJsonSafe(this.file, null);
    return j && typeof j.session === 'string' ? j : null;
  }

  saveSession(session, me) {
    writeJsonAtomic(this.file, {
      session,
      user: me ? { id: idStr(me.id), name: entityName(me), username: me.username || '', phone: me.phone || '' } : undefined,
      savedAt: new Date().toISOString(),
    }, 0o600);
    try { fs.chmodSync(this.file, 0o600); } catch { /* ignore */ }
  }

  get linked() { return !!this.loadSession(); }
  cached() { const j = this.loadSession(); return j ? { linked: true, ...(j.user || {}) } : { linked: false }; }

  _make(sessionStr) {
    if (this.factory) return this.factory(sessionStr);
    const { apiId, apiHash } = apiCreds();
    return new TelegramClient(new StringSession(sessionStr || ''), apiId, apiHash, {
      connectionRetries: 4,
      baseLogger: quietLogger(),
      deviceModel: 'bratcode',
      appVersion: '1.0',
      useWSS: false,
    });
  }

  // connect with the saved session (null if not linked / revoked)
  async connect() {
    if (this.client && this.client.connected) return this.client;
    if (this.connecting) return this.connecting;
    const saved = this.loadSession();
    if (!saved) return null;
    this.connecting = (async () => {
      const c = this._make(saved.session);
      await c.connect();
      let ok = false;
      try { ok = await c.checkAuthorization(); } catch { ok = false; }
      if (!ok) { try { await c.disconnect(); } catch { /* ignore */ } this.client = null; return null; }
      this.client = c;
      try { this.me = await c.getMe(); } catch { /* ignore */ }
      return c;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async status() {
    const saved = this.loadSession();
    if (!saved) return { linked: false };
    try {
      const c = await this.connect();
      if (!c) return { linked: false, revoked: true };
      const m = this.me || (await c.getMe());
      return { linked: true, id: idStr(m.id), name: entityName(m), username: m.username || '', phone: m.phone || '' };
    } catch (e) {
      return { linked: true, offline: true, error: String(e.message || e), ...(saved.user || {}) };
    }
  }

  /**
   * QR login. Callbacks:
   *   onQr(url)            -> render the QR (tg://login?token=...)
   *   onPassword(hint)     -> Promise<string> (2FA cloud password)
   *   onError(err)         -> return true to stop
   * Resolves with the user.
   */
  async loginWithQr({ onQr, onPassword, onError, signal } = {}) {
    const { apiId, apiHash } = apiCreds();
    const c = this._make('');
    await c.connect();
    let cancelled = false;
    signal?.addEventListener?.('abort', () => { cancelled = true; });
    try {
      const user = await c.signInUserWithQrCode({ apiId, apiHash }, {
        qrCode: async ({ token }) => {
          if (cancelled) throw new Error('cancelled');
          const url = 'tg://login?token=' + Buffer.from(token).toString('base64url');
          await onQr?.(url);
        },
        password: async (hint) => {
          if (!onPassword) throw new Error('2FA password required');
          return onPassword(hint);
        },
        onError: async (err) => {
          if (cancelled) return true;
          const stop = await onError?.(err);
          return !!stop;
        },
      });
      const session = c.session.save();
      this.client = c;
      this.me = user;
      this.saveSession(session, user);
      return user;
    } catch (e) {
      try { await c.disconnect(); } catch { /* ignore */ }
      throw e;
    }
  }

  async logout() {
    try { const c = await this.connect(); if (c) await c.invoke(new Api.auth.LogOut()); } catch { /* ignore */ }
    try { await this.client?.disconnect(); } catch { /* ignore */ }
    this.client = null; this.me = null;
    try { fs.rmSync(this.file, { force: true }); } catch { /* ignore */ }
  }

  async close() { try { await this.client?.disconnect(); } catch { /* ignore */ } this.client = null; }

  async need() {
    const c = await this.connect();
    if (!c) throw Object.assign(new Error('Telegram is not linked. Ask the user to run /tg in bratcode and scan the QR code.'), { http: 409 });
    return c;
  }

  // ---------------------------------------------------------------- reading
  async dialogs({ limit = 30, unread = false } = {}) {
    const c = await this.need();
    const ds = await c.getDialogs({ limit: Math.min(200, Math.max(1, limit)) });
    return ds
      .filter((d) => !unread || d.unreadCount > 0)
      .map((d) => ({
        id: idStr(d.id),
        name: d.name || d.title || entityName(d.entity),
        kind: entityKind(d.entity),
        username: d.entity?.username || '',
        unread: d.unreadCount || 0,
        pinned: !!d.pinned,
        last: d.message ? { date: d.message.date, text: (d.message.message || mediaTag(d.message)).slice(0, 140), out: !!d.message.out } : null,
      }));
  }

  // resolve "id" | "@username" | "+phone" | "Name" -> input entity + display name
  async resolve(chat) {
    const c = await this.need();
    const q = String(chat ?? '').trim();
    if (!q) throw Object.assign(new Error('missing "chat" (id, @username, phone or name; use tg_search first)'), { http: 400 });
    if (q === 'me' || q === 'self') return { entity: 'me', name: 'Saved Messages' };
    if (/^-?\d+$/.test(q)) {
      try { const e = await c.getEntity(q.startsWith('-100') ? BigInt(q) : BigInt(q)); return { entity: e, name: entityName(e) }; } catch { /* fall through to dialogs */ }
      const ds = await c.getDialogs({ limit: 300 });
      const d = ds.find((x) => idStr(x.id) === q || idStr(x.id) === '-100' + q || idStr(x.entity?.id) === q);
      if (d) return { entity: d.entity || d.inputEntity, name: d.name || entityName(d.entity) };
      throw Object.assign(new Error(`chat id ${q} not found in your dialogs`), { http: 404 });
    }
    if (q.startsWith('@') || q.startsWith('+')) {
      const e = await c.getEntity(q);
      return { entity: e, name: entityName(e) };
    }
    const hits = await this.search(q, { limit: 6 });
    if (!hits.length) throw Object.assign(new Error(`nothing found for "${q}" (try tg_search?q=${q})`), { http: 404 });
    const exact = hits.filter((h) => h.name.toLowerCase() === q.toLowerCase());
    const pick = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
    if (!pick) {
      throw Object.assign(new Error(`"${q}" is ambiguous, pass the id:\n` + hits.map((h) => `  ${h.id}  ${h.name} [${h.kind}]${h.username ? ' @' + h.username : ''}`).join('\n')), { http: 409 });
    }
    const e = await c.getEntity(BigInt(pick.id));
    return { entity: e, name: pick.name };
  }

  // contacts + dialogs + global by name/@username/phone
  async search(q, { limit = 15 } = {}) {
    const c = await this.need();
    const needle = String(q || '').trim();
    if (!needle) return [];
    const low = needle.toLowerCase().replace(/^@/, '');
    const out = new Map();
    const add = (e, src, extraName) => {
      if (!e) return;
      const id = idStr(e.id);
      if (!id || out.has(id)) return;
      out.set(id, { id, name: extraName || entityName(e), kind: entityKind(e), username: e.username || '', phone: e.phone || '', source: src });
    };
    try {
      const ds = await c.getDialogs({ limit: 300 });
      for (const d of ds) {
        const nm = (d.name || d.title || '').toLowerCase();
        const un = (d.entity?.username || '').toLowerCase();
        if (nm.includes(low) || un.includes(low)) add(d.entity, 'dialog', d.name || d.title);
      }
    } catch { /* ignore */ }
    try {
      const r = await c.invoke(new Api.contacts.Search({ q: needle.replace(/^@/, ''), limit: Math.min(30, limit * 2) }));
      for (const u of r.users || []) add(u, 'contact');
      for (const ch of r.chats || []) add(ch, 'global');
    } catch { /* ignore */ }
    return [...out.values()].slice(0, limit);
  }

  async read(chat, { limit = 40, offsetId = 0, search = '' } = {}) {
    const c = await this.need();
    const { entity, name } = await this.resolve(chat);
    const msgs = await c.getMessages(entity, { limit: Math.min(300, Math.max(1, limit)), offsetId: Number(offsetId) || 0, search: search || undefined });
    const senders = new Map();
    const who = async (m) => {
      if (m.out) return 'я';
      const sid = idStr(m.senderId);
      if (!sid) return name;
      if (senders.has(sid)) return senders.get(sid);
      let n = name;
      try { const s = m.sender || (await m.getSender()); if (s) n = entityName(s); } catch { /* ignore */ }
      senders.set(sid, n);
      return n;
    };
    const list = [...msgs].reverse();
    const byId = new Map(list.map((m) => [m.id, m]));
    const rows = [];
    for (const m of list) {
      rows.push({
        id: m.id,
        date: m.date,
        from: await who(m),
        out: !!m.out,
        text: m.message || mediaTag(m),
        replyTo: m.replyTo?.replyToMsgId || null,
        replyPreview: m.replyTo?.replyToMsgId && byId.get(m.replyTo.replyToMsgId) ? (byId.get(m.replyTo.replyToMsgId).message || '').slice(0, 60) : '',
      });
    }
    return { chat: name, rows };
  }

  // search messages by keywords: in one chat or globally
  async findMessages(q, { chat = '', limit = 20 } = {}) {
    const c = await this.need();
    const needle = String(q || '').trim();
    if (!needle) throw Object.assign(new Error('missing "q"'), { http: 400 });
    const rows = [];
    if (chat) {
      const r = await this.read(chat, { limit, search: needle });
      return r.rows.map((x) => ({ ...x, chat: r.chat }));
    }
    const res = await c.invoke(new Api.messages.SearchGlobal({
      q: needle, filter: new Api.InputMessagesFilterEmpty(), minDate: 0, maxDate: 0,
      offsetRate: 0, offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, limit: Math.min(50, limit),
    }));
    const ents = new Map();
    for (const u of res.users || []) ents.set(idStr(u.id), u);
    for (const ch of res.chats || []) ents.set(idStr(ch.id), ch);
    for (const m of res.messages || []) {
      const peer = m.peerId;
      const pid = idStr(peer?.userId ?? peer?.chatId ?? peer?.channelId);
      const chatEnt = ents.get(pid);
      const fromEnt = ents.get(idStr(m.fromId?.userId ?? m.peerId?.userId));
      rows.push({
        id: m.id, date: m.date, chat: entityName(chatEnt), chatId: pid,
        from: m.out ? 'я' : entityName(fromEnt || chatEnt),
        out: !!m.out, text: m.message || mediaTag(m),
      });
    }
    return rows;
  }

  async send(chat, text) {
    const c = await this.need();
    const { entity, name } = await this.resolve(chat);
    const m = await c.sendMessage(entity, { message: String(text) });
    return { id: m.id, chat: name, date: m.date };
  }
}

export function mediaTag(m) {
  const md = m?.media;
  if (!md) return '';
  const k = md.className || '';
  if (/Photo/.test(k)) return '[photo]';
  if (/Document/.test(k)) {
    const a = md.document?.attributes || [];
    if (a.some((x) => x.className === 'DocumentAttributeAudio')) return a.find((x) => x.className === 'DocumentAttributeAudio').voice ? '[voice]' : '[audio]';
    if (a.some((x) => x.className === 'DocumentAttributeVideo')) return '[video]';
    const f = a.find((x) => x.className === 'DocumentAttributeFilename');
    return f ? `[file ${f.fileName}]` : '[document]';
  }
  if (/Geo/.test(k)) return '[location]';
  if (/Contact/.test(k)) return '[contact]';
  if (/Poll/.test(k)) return '[poll]';
  return `[${k.replace('MessageMedia', '').toLowerCase() || 'media'}]`;
}
