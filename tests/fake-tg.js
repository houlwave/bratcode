// Fake GramJS client for tests
const big = (n) => ({ value: BigInt(n), toString() { return String(n); } });
export function fakeClient({ authorized = true } = {}) {
  const sent = [];
  const users = {
    1: { className: 'User', id: big(1), firstName: 'Мама', lastName: '', username: 'mama_u', phone: '79990001' },
    2: { className: 'User', id: big(2), firstName: 'Боря', lastName: 'Иванов', username: '' },
  };
  const group = { className: 'Chat', id: big(100), title: 'Семья' };
  const now = Math.floor(Date.now() / 1000);
  const msgs = {
    100: [
      { id: 12, date: now - 300, message: 'в субботу едем на дачу?', out: false, senderId: big(1), sender: users[1] },
      { id: 13, date: now - 200, message: 'да, выезжаем в 10', out: true, senderId: big(9) },
      { id: 14, date: now - 100, message: 'а в воскресенье шашлыки', out: false, senderId: big(2), sender: users[2], replyTo: { replyToMsgId: 12 } },
    ],
    1: [{ id: 5, date: now - 50, message: 'привет', out: false, senderId: big(1), sender: users[1] }],
  };
  const dlg = (e, unread, last) => ({ id: e.id, name: e.title || e.firstName, title: e.title, entity: e, inputEntity: e, unreadCount: unread, pinned: false, message: last });
  return {
    connected: true,
    sent,
    session: { save: () => 'SESSION-STR' },
    async connect() { return true; },
    async disconnect() { this.connected = false; },
    async checkAuthorization() { return authorized; },
    async getMe() { return { className: 'User', id: big(9), firstName: 'Я', username: 'me_u', phone: '7000' }; },
    async getDialogs() { return [dlg(group, 3, msgs[100][2]), dlg(users[1], 0, msgs[1][0]), dlg(users[2], 1, { date: 1, message: 'x' })]; },
    async getEntity(q) {
      const s = String(q);
      if (s === '@mama_u') return users[1];
      const id = Number(s);
      if (users[id]) return users[id];
      if (id === 100) return group;
      throw new Error('not found');
    },
    async getMessages(entity, { limit, search } = {}) {
      const id = Number(String(entity.id));
      let l = [...(msgs[id] || [])].reverse();
      if (search) l = l.filter((m) => m.message.toLowerCase().includes(String(search).toLowerCase()));
      return l.slice(0, limit);
    },
    async sendMessage(entity, { message }) { sent.push({ to: String(entity.id), message }); return { id: 77, date: Math.floor(Date.now() / 1000) }; },
    async invoke(req) {
      const n = req.className || req.constructor?.name;
      if (/Search$/.test(n) && !/Global/.test(n)) return { users: [users[1]], chats: [] };
      if (/SearchGlobal/.test(n)) return { users: [users[1], users[2]], chats: [group], messages: [{ id: 14, date: now - 100, message: 'а в воскресенье шашлыки', out: false, peerId: { chatId: big(100) }, fromId: { userId: big(2) } }] };
      return {};
    },
    async signInUserWithQrCode(_c, p) {
      await p.qrCode({ token: Buffer.from('tok1'), expires: 0 });
      if (p.password) { const pw = await p.password('hint'); if (pw !== 'secret') throw new Error('bad password'); }
      return { className: 'User', id: big(9), firstName: 'Я', username: 'me_u', phone: '7000' };
    },
  };
}
