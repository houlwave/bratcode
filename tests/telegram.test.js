import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, eq, ok, has } from './helpers.js';
import { TgService } from '../src/telegram/client.js';
import { createTelegramAgent } from '../src/telegram/agent.js';
import { qrHalfBlocks, qrMatrix } from '../src/telegram/qr.js';
import { fakeClient } from './fake-tg.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-tg-'));
const file = path.join(tmp, 'telegram.json');

console.log('telegram');
const svc = new TgService({ file, factory: () => fakeClient() });
const agent = createTelegramAgent(svc);

await test('not linked -> helpful message', async () => {
  const r = await agent.commands.tg_status({});
  eq(r.linked, false); has(r.text, '/tg');
  let err; try { await agent.commands.tg_dialogs({}); } catch (e) { err = e; }
  ok(err && err.http === 409, 'tg_dialogs must 409');
});

await test('QR login saves session with 0600 and 2FA password flows', async () => {
  let qr = '', asked = '';
  const u = await svc.loginWithQr({ onQr: (url) => { qr = url; }, onPassword: async (h) => { asked = h; return 'secret'; } });
  has(qr, 'tg://login?token='); eq(asked, 'hint'); eq(String(u.id), '9');
  const mode = fs.statSync(file).mode & 0o777;
  eq(mode, 0o600);
  eq(JSON.parse(fs.readFileSync(file, 'utf8')).session, 'SESSION-STR');
});

await test('wrong 2FA password fails and does not save', async () => {
  const f2 = path.join(tmp, 't2.json');
  const s2 = new TgService({ file: f2, factory: () => fakeClient() });
  let err; try { await s2.loginWithQr({ onQr() {}, onPassword: async () => 'nope' }); } catch (e) { err = e; }
  ok(err); ok(!fs.existsSync(f2));
});

await test('tg_status linked', async () => {
  const r = await agent.commands.tg_status({});
  eq(r.linked, true); has(r.text, 'Я');
});

await test('tg_dialogs lists chats with unread', async () => {
  const r = await agent.commands.tg_dialogs({});
  has(r.text, 'Семья'); has(r.text, '[3 unread]');
  const u = await agent.commands.tg_dialogs({ unread: '1' });
  ok(!u.text.includes('Мама'));
});

await test('tg_search finds Мама and Семья', async () => {
  const a = await agent.commands.tg_search({ q: 'Мама' });
  has(a.text, 'Мама'); has(a.text, '@mama_u');
  const b = await agent.commands.tg_search({ q: 'семь' });
  has(b.text, 'Семья');
});

await test('tg_read: weekday, authors, replies, oldest first', async () => {
  const r = await agent.commands.tg_read({ chat: '100' });
  has(r.text, 'CHAT: Семья'); has(r.text, 'в субботу едем на дачу'); has(r.text, 'я:');
  has(r.text, 'reply to #12'); ok(/ (пн|вт|ср|чт|пт|сб|вс) /.test(r.text), 'weekday');
  ok(r.text.indexOf('в субботу') < r.text.indexOf('шашлыки'), 'order');
});

await test('tg_read by name', async () => {
  const r = await agent.commands.tg_read({ chat: 'Семья' });
  has(r.text, 'CHAT: Семья');
});

await test('tg_find_msg globally and in chat', async () => {
  const g = await agent.commands.tg_find_msg({ q: 'шашлык' });
  has(g.text, 'шашлыки'); has(g.text, 'Семья');
  const c = await agent.commands.tg_find_msg({ q: 'дачу', chat: '100' });
  has(c.text, 'на дачу');
});

await test('tg_send sends as user and is marked sensitive', async () => {
  ok(agent.sensitive.includes('tg_send'));
  const r = await agent.commands.tg_send({ chat: 'Мама', text: 'Привет, мам!' });
  has(r.text, 'OK sent');
  const c = svc.client; eq(c.sent.at(-1).message, 'Привет, мам!');
  const b = await agent.commands.tg_send({ chat: '1', text_b64: Buffer.from('до связи').toString('base64') });
  has(b.text, 'до связи');
});

await test('tg_send validates input', async () => {
  let e1; try { await agent.commands.tg_send({ chat: '1' }); } catch (e) { e1 = e; }
  ok(e1 && e1.http === 400);
});

await test('qr half blocks are scannable-shaped', async () => {
  const lines = qrHalfBlocks('tg://login?token=abc');
  const n = qrMatrix('tg://login?token=abc').length;
  eq(lines.length, Math.ceil((n + 4) / 2));
  ok(lines.every((l) => [...l].length === n + 4));
  ok(/[▀▄█]/.test(lines.join('')));
});

await svc.close();
