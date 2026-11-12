import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, eq, ok, has } from './helpers.js';
import { createSandbox } from '../src/sandbox/server.js';
import { createTelegramAgent } from '../src/telegram/agent.js';
import { TgService } from '../src/telegram/client.js';
import { fakeClient } from './fake-tg.js';

console.log('sandbox');
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-proj-'));
const tgFile = path.join(os.tmpdir(), 'bc-sb-tg-' + process.pid + '.json');
fs.writeFileSync(tgFile, JSON.stringify({ session: 'S' }));
const svc = new TgService({ file: tgFile, factory: () => fakeClient() });
let approve = true; const asked = [];
const sb = await createSandbox({
  cwd: proj, tunnel: false, telegram: createTelegramAgent(svc),
  confirm: async (cmd, p) => { asked.push(cmd); return approve; },
});
const g = async (cmd, opt) => { const r = await fetch(sb.localBase() + '/' + cmd, opt); return { status: r.status, text: await r.text() }; };
const b64 = (s) => Buffer.from(s).toString('base64');

await test('token is required', async () => {
  const r = await fetch(`http://127.0.0.1:${sb.port}/agent/wrong/help`);
  eq(r.status, 401);
});

await test('help lists mac + telegram + undo + real-path notes', async () => {
  const r = await g('help');
  has(r.text, 'osascript'); has(r.text, 'tg_read'); has(r.text, 'undo'); has(r.text, 'REAL computer');
  has((await g('help?topic=telegram')).text, 'tg_send');
  has((await g('help?topic=mac')).text, 'screencapture' === 'x' ? '' : 'sysinfo');
});

await test('write / read / numbered read with sha', async () => {
  const f = path.join(proj, 'a.js');
  const w = await g('write?path=a.js&content_b64=' + encodeURIComponent(b64('const a = 1;\nconsole.log(a);\n')));
  has(w.text, 'OK wrote'); has(w.text, 'SYNTAX: OK');
  ok(fs.existsSync(f));
  const r = await g('read?path=a.js&numbered=1');
  has(r.text, '1: const a = 1;'); has(r.text, 'sha ');
});

await test('absolute path anywhere on disk works (whole-disk host)', async () => {
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-out-')), 'x.txt');
  const w = await g('write?path=' + encodeURIComponent(outside) + '&content=hi');
  has(w.text, 'OK wrote'); eq(fs.readFileSync(outside, 'utf8'), 'hi');
});

await test('edit + multiedit + syntax error is reported', async () => {
  const e = await g('edit?path=a.js&find=' + encodeURIComponent('a = 1') + '&replace=' + encodeURIComponent('a = 2'));
  has(e.text, 'OK 1 edit');
  const bad = await g('edit?path=a.js&find=' + encodeURIComponent('console.log(a);') + '&replace=' + encodeURIComponent('console.log(a;'));
  has(bad.text, 'SYNTAX ERROR');
  const miss = await g('edit?path=a.js&find=nothere&replace=x');
  ok(miss.status >= 400, 'miss must fail'); has(miss.text, 'ERROR');
  const before = fs.readFileSync(path.join(proj, 'a.js'), 'utf8');
  const me = await g('multiedit?path=a.js&edits_b64=' + encodeURIComponent(b64(JSON.stringify([{ find: 'console.log(a;', replace: 'console.log(a);' }]))));
  has(me.text, 'OK 1 edit'); ok(fs.readFileSync(path.join(proj, 'a.js'), 'utf8') !== before);
});

await test('grep / glob / tree / outline / symbols / refs / diagnostics', async () => {
  fs.writeFileSync(path.join(proj, 'm.js'), 'export function hello() { return 1 }\nhello();\n');
  has((await g('grep?pattern=hello')).text, 'm.js');
  has((await g('glob?pattern=*.js')).text, 'a.js');
  has((await g('tree')).text, 'm.js');
  has((await g('outline?path=m.js')).text, 'hello');
  has((await g('symbols?q=hello')).text, 'm.js');
  has((await g('refs?name=hello')).text, 'm.js');
  has((await g('diagnostics?path=m.js')).text, 'all OK');
});

await test('patch (unified diff) applies atomically', async () => {
  fs.writeFileSync(path.join(proj, 'p.txt'), 'one\ntwo\nthree\n');
  const diff = '--- a/p.txt\n+++ b/p.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n';
  const r = await g('patch?patch_b64=' + encodeURIComponent(b64(diff)));
  has(r.text, 'OK patch applied'); eq(fs.readFileSync(path.join(proj, 'p.txt'), 'utf8'), 'one\nTWO\nthree\n');
});

await test('exec + start/logs/stop background process', async () => {
  const r = await g('exec?cmd=' + encodeURIComponent('echo hello && pwd'));
  has(r.text, 'hello'); has(r.text, fs.realpathSync(proj)); has(r.text, 'exit code: 0');
  const s = await g('start?cmd=' + encodeURIComponent('echo started; sleep 20') + '&name=t1');
  has(s.text, 'OK started');
  has((await g('logs?name=t1')).text, 'started');
  has((await g('ps')).text, 't1');
  has((await g('stop?name=t1')).text, 'OK stopped');
});

await test('batch runs several commands in one request', async () => {
  const cmds = 'read?path=p.txt\ngrep?pattern=TWO\nls';
  const r = await g('batch?cmds_b64=' + encodeURIComponent(b64(cmds)));
  has(r.text, 'BATCH: 3 of 3'); has(r.text, 'TWO');
});

await test('remember / memory', async () => {
  has((await g('remember?text=' + encodeURIComponent('tests: npm test'))).text, 'OK remembered');
  has((await g('memory')).text, 'npm test');
  has((await g('help')).text, 'npm test');
});

await test('INBOX: a prompt typed mid-run arrives at the end of the NEXT answer, once', async () => {
  sb.pushMessage('не трогай package.json');
  eq(sb.pendingInbox(), 1);
  const a = await g('ls');
  has(a.text, '>>> NEW MESSAGE FROM THE USER'); has(a.text, 'не трогай package.json');
  eq(sb.pendingInbox(), 0);
  const b = await g('ls');
  ok(!b.text.includes('NEW MESSAGE'), 'delivered only once');
  sb.pushMessage('one'); sb.pushMessage('two');
  const j = await g('ls?format=json');
  const o = JSON.parse(j.text); eq(o.user_messages, ['one', 'two']);
});

await test('UNDO: history + revert of write/edit/rm/mv', async () => {
  const f = path.join(proj, 'u.txt');
  await g('write?path=u.txt&content=v1');
  await g('write?path=u.txt&content=v2');
  await g('edit?path=u.txt&find=v2&replace=v3');
  eq(fs.readFileSync(f, 'utf8'), 'v3');
  has((await g('history')).text, 'u.txt');
  const u1 = await g('undo');
  has(u1.text, 'restored'); eq(fs.readFileSync(f, 'utf8'), 'v2');
  await g('undo?n=2');
  ok(!fs.existsSync(f), 'file created by the agent is removed by undo');
  // rm then undo restores content
  fs.writeFileSync(f, 'precious');
  await g('rm?path=u.txt');
  ok(!fs.existsSync(f));
  await g('undo');
  eq(fs.readFileSync(f, 'utf8'), 'precious');
  // mv
  await g('mv?from=u.txt&to=moved/u2.txt');
  ok(fs.existsSync(path.join(proj, 'moved/u2.txt')));
  await g('undo');
  ok(fs.existsSync(f) && !fs.existsSync(path.join(proj, 'moved/u2.txt')), 'mv undone');
  has((await g('undo?n=999')).text, 'UNDO');
  has((await g('undo')).text, 'nothing to undo');
});

await test('directory rm is backed up and restorable', async () => {
  fs.mkdirSync(path.join(proj, 'dd/sub'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'dd/sub/f.txt'), 'deep');
  await g('rm?path=dd');
  ok(!fs.existsSync(path.join(proj, 'dd')));
  await g('undo');
  eq(fs.readFileSync(path.join(proj, 'dd/sub/f.txt'), 'utf8'), 'deep');
});

await test('macOS commands degrade gracefully on non-mac', async () => {
  const r = await g('sysinfo'); has(r.text, 'OS:'); has(r.text, 'cwd:');
  if (process.platform !== 'darwin') { has((await g('osascript?script=x')).text, 'only on macOS'); has((await g('clipboard')).text, 'only on macOS'); }
});

await test('telegram commands are routed; tg_send needs approval (Side B)', async () => {
  has((await g('tg_status')).text, 'linked');
  has((await g('tg_search?q=' + encodeURIComponent('Мама'))).text, 'Мама');
  has((await g('tg_read?chat=100')).text, 'шашлыки');
  asked.length = 0; approve = true;
  const ok1 = await g('tg_send?chat=1&text=' + encodeURIComponent('привет'));
  has(ok1.text, 'OK sent'); eq(asked, ['tg_send']);
  approve = false;
  const no = await g('tg_send?chat=1&text=' + encodeURIComponent('нет'));
  eq(no.status, 403); has(no.text, 'DENIED'); eq(svc.client.sent.length, 1);
  approve = true;
});

await test('unknown command is a clean 404', async () => {
  const r = await g('nope'); eq(r.status, 404); has(r.text, 'unknown command');
});

await test('files + proxy routes', async () => {
  fs.writeFileSync(path.join(proj, 'index.html'), '<h1>x</h1>');
  const r = await fetch(sb.localBase() + '/files' + path.join(proj, 'index.html'));
  eq(r.status, 200); has(await r.text(), '<h1>x</h1>');
});

await sb.stop(); await svc.close();
