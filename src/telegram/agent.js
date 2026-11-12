// tg_* commands for the sandbox agent API. Plugged into createSandbox({ telegram }).
import { TgService, fmtDate } from './client.js';

const b64 = (s) => Buffer.from(String(s).replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const val = (p, k) => (p[k + '_b64'] !== undefined ? b64(p[k + '_b64']) : p[k]);
const num = (v, d, a, b) => { const n = Number(v); return Math.min(b, Math.max(a, Number.isFinite(n) && v !== undefined && v !== '' ? n : d)); };
const flag = (v) => v === '1' || v === 'true' || v === 'yes';
const E = (msg, http = 400) => Object.assign(new Error(msg), { http });

const NOT_LINKED = 'Telegram is NOT linked. Tell the user to type /tg in bratcode and scan the QR code with Telegram (Settings -> Devices -> Link Desktop Device). Then repeat.';

export function createTelegramAgent(svc = new TgService()) {
  const guard = async () => { if (!svc.linked) throw E(NOT_LINKED, 409); };

  const commands = {
    tg_status: async () => {
      const s = await svc.status();
      if (!s.linked) return { ok: true, linked: false, text: s.revoked ? 'Telegram session was revoked. Ask the user to run /tg again.' : NOT_LINKED };
      return { ok: true, ...s, text: `Telegram linked: ${s.name}${s.username ? ' (@' + s.username + ')' : ''}${s.phone ? ' +' + s.phone : ''} id=${s.id}${s.offline ? '\n(offline now: ' + s.error + ')' : ''}` };
    },

    tg_dialogs: async (p) => {
      await guard();
      const list = await svc.dialogs({ limit: num(p.limit, 30, 1, 200), unread: flag(p.unread) });
      if (!list.length) return { ok: true, dialogs: [], text: '(no dialogs)' };
      const text = `DIALOGS (${list.length}):\n` + list.map((d) =>
        `${d.id}\t${d.kind}\t${d.name}${d.username ? ' @' + d.username : ''}${d.unread ? `  [${d.unread} unread]` : ''}${d.last ? `\n\t  ${fmtDate(d.last.date)} ${d.last.out ? 'я: ' : ''}${d.last.text.replace(/\s+/g, ' ')}` : ''}`).join('\n');
      return { ok: true, dialogs: list, text };
    },

    tg_search: async (p) => {
      await guard();
      const q = val(p, 'q') ?? val(p, 'query') ?? val(p, 'name');
      if (!q) throw E('missing "q" (tg_search?q=Мама)');
      const hits = await svc.search(q, { limit: num(p.limit, 15, 1, 50) });
      if (!hits.length) return { ok: true, results: [], text: `nothing found for "${q}". Try another spelling / a nickname, or tg_dialogs to browse.` };
      return { ok: true, results: hits, text: `FOUND ${hits.length} for "${q}":\n` + hits.map((h) => `${h.id}\t${h.kind}\t${h.name}${h.username ? ' @' + h.username : ''}${h.phone ? ' +' + h.phone : ''}  (${h.source})`).join('\n') + '\nnext: tg_read?chat=<id>' };
    },

    tg_read: async (p) => {
      await guard();
      const chat = val(p, 'chat') ?? p.id ?? p.q;
      const r = await svc.read(chat, { limit: num(p.limit, 40, 1, 300), offsetId: p.offset_id, search: val(p, 'search') || '' });
      if (!r.rows.length) return { ok: true, chat: r.chat, rows: [], text: `${r.chat}: (no messages)` };
      const lines = r.rows.map((m) => `[${m.id}] ${fmtDate(m.date)} ${m.from}${m.replyTo ? ` (reply to #${m.replyTo}${m.replyPreview ? ': "' + m.replyPreview.replace(/\s+/g, ' ') + '"' : ''})` : ''}: ${m.text}`);
      const first = r.rows[0].id;
      return { ok: true, chat: r.chat, rows: r.rows, text: `CHAT: ${r.chat}  (${r.rows.length} messages, oldest first)\n` + lines.join('\n') + `\n--- older messages: tg_read?chat=${encodeURIComponent(String(chat))}&offset_id=${first} ---` };
    },

    tg_find_msg: async (p) => {
      await guard();
      const q = val(p, 'q') ?? val(p, 'query') ?? val(p, 'text');
      const rows = await svc.findMessages(q, { chat: val(p, 'chat') || '', limit: num(p.limit, 20, 1, 50) });
      if (!rows.length) return { ok: true, rows: [], text: `no messages with "${q}"${p.chat ? ' in ' + p.chat : ''}` };
      const text = `MESSAGES with "${q}" (${rows.length}):\n` + rows.map((m) => `${m.chatId ? m.chatId + '\t' : ''}[${m.chat}] ${fmtDate(m.date)} ${m.from}: ${m.text.replace(/\s+/g, ' ')}`).join('\n');
      return { ok: true, rows, text };
    },

    tg_send: async (p) => {
      await guard();
      const chat = val(p, 'chat') ?? val(p, 'to');
      const text = val(p, 'text') ?? val(p, 'message');
      if (!chat) throw E('missing "chat" (id, @username, phone or exact name)');
      if (!text || !String(text).trim()) throw E('missing "text" (or text_b64)');
      const r = await svc.send(chat, text);
      return { ok: true, ...r, text: `OK sent to ${r.chat} (message #${r.id}): ${String(text).slice(0, 200)}` };
    },
  };

  const clip = (s, n = 60) => String(s || '').slice(0, n);
  const titles = {
    tg_status: () => 'tg status',
    tg_dialogs: (p) => 'tg dialogs' + (p.unread ? ' (unread)' : ''),
    tg_search: (p, v) => 'tg search ' + clip(v('q') || p.query),
    tg_read: (p, v) => 'tg read ' + clip(v('chat') || p.id),
    tg_find_msg: (p, v) => 'tg find "' + clip(v('q')) + '"' + (p.chat ? ' in ' + clip(p.chat, 20) : ''),
    tg_send: (p, v) => `tg send -> ${clip(v('chat') || v('to'), 24)}: ${clip(v('text') || v('message'), 50)}`,
  };

  return { commands, titles, sensitive: ['tg_send'], service: svc };
}
