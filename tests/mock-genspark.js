// Mock of the Genspark HTTP API for tests: balance / user / member_benefits / models / ask_proxy (SSE) / share / abort.
import http from 'node:http';

export async function startMock(accounts) {
  // accounts: { <cookieValue>: { email, tokens, locked:[], mode:'ok'|'exhaust' } }
  const hits = { balance: [], ask: [], share: 0, abort: 0, benefits: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookie = String(req.headers.cookie || '');
    const sid = (cookie.match(/gs_session=([^;]+)/) || [])[1];
    const acc = sid && accounts[sid];
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const body = await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });

    if (url.pathname === '/api/payment/get_credit_balance') {
      hits.balance.push(sid);
      if (!acc) return json({ status: -5, message: 'not login' });
      return json({ status: 0, data: { balance: acc.tokens } });
    }
    if (url.pathname === '/api/user') {
      if (!acc) return json({ status: -5, message: 'not login' });
      return json({ status: 0, data: { cogen: { email: acc.email, plan: 'free' } } });
    }
    if (url.pathname === '/api/quota/member_benefits') {
      hits.benefits++;
      if (!acc) return json({ status: -5, message: 'not login' });
      return json({ status: 0, ai_chat: { flagship_locked: !!(acc.locked && acc.locked.length), flagship_models: acc.locked || [], member_only_locked: false, member_only_models: [] } });
    }
    if (url.pathname === '/api/moa_models_config') {
      return json({ status: 0, data: { models: [{ name: 'claude-opus-5-5' }, { name: 'claude-sonnet-5' }, { name: 'claude-4-5-haiku' }, { name: 'claude-fable-5-1', gk_flag: 'x' }] } });
    }
    if (url.pathname === '/api/project/update') { hits.share++; return json({ status: 0, data: {} }); }
    if (url.pathname === '/api/agent/ask_abort') { hits.abort++; return json({ status: 0 }); }
    if (url.pathname === '/api/agent/ask_proxy') {
      let payload = {}; try { payload = JSON.parse(body); } catch { /* ignore */ }
      hits.ask.push({ sid, payload });
      if (!acc) { res.writeHead(401); return res.end('not login'); }
      if (acc.rawResponse) {
        res.writeHead(acc.rawResponse.status, acc.rawResponse.headers);
        return res.end(acc.rawResponse.body);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const pid = payload.project_id || 'proj-1';
      let i = 0;
      ev({ type: 'project_start', id: pid, _event_index: i++ });
      ev({ type: 'message_start', message_id: 'm' + hits.ask.length, role: 'assistant', ask_id: 'ask-' + hits.ask.length, _event_index: i++ });
      const mid = 'm' + hits.ask.length;
      const say = (t) => ev({ type: 'message_field_delta', message_id: mid, field_name: 'content', delta: t, _event_index: i++ });
      if (acc.mode === 'exhaust' && !acc.once) {
        say('Сделал первую часть. ');
        say('Ваш баланс кредитов отрицательный. Этот запуск остановлен. Пожалуйста, пополните, чтобы продолжить.');
        acc.tokens = 0;
        return res.end();
      }
      if (acc.mode === 'fail500') { res.end(); return; }
      if (acc.delay) await new Promise((r) => setTimeout(r, acc.delay));
      say('Готово: ');
      say(`ответ от ${acc.email} на «${String(payload.user_s_input || '').slice(0, 20).replace(/\n/g, ' ')}»`);
      ev({ type: 'message_result', message: { id: mid, role: 'assistant', content: '' }, _event_index: i++ });
      ev({ type: 'project_field', id: pid, field_name: 'status', field_value: 'FINISHED', _event_index: i++ });
      if (acc.spend) acc.tokens -= acc.spend;
      return res.end();
    }
    res.writeHead(404); res.end('nf');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, hits, accounts, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
