// Tiny fake Discord: records webhook POSTs and scheduled-event API calls.
//   node test/discord-mock.mjs [port]     (standalone)   or   import { startMock }
// Webhook URL:  http://127.0.0.1:<port>/webhook      API base: http://127.0.0.1:<port>/api/v10
import http from 'node:http';

export function startMock(port = 0) {
  const state = {
    webhooks: [],   // parsed JSON bodies of webhook POSTs
    api: [],        // { method, path, body, auth } for /api/v10/*
    failNext: [],   // queue of { status, body } to answer the next webhook POST(s) with
    port: 0, close: null,
    reset() { state.webhooks.length = 0; state.api.length = 0; state.failNext.length = 0; },
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const u = new URL(req.url, 'http://x');
      const send = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/webhook' && req.method === 'POST') {
        const f = state.failNext.shift();
        if (f) return send(f.status, f.body || {});
        state.webhooks.push({ ...body, _query: u.search });
        return send(200, { id: String(1000 + state.webhooks.length), ...body });
      }
      if (u.pathname.startsWith('/api/v10/')) {
        const path = u.pathname.slice('/api/v10'.length);
        state.api.push({ method: req.method, path, body, auth: req.headers.authorization });
        if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
        return send(200, { id: 'evt-' + (path.split('/')[4] || '1'), ...body });
      }
      send(404, { message: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      state.port = server.address().port;
      state.close = () => new Promise((r) => server.close(r));
      resolve(state);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock(Number(process.argv[2] || 9911));
  console.log(`mock discord on http://127.0.0.1:${m.port}/webhook`);
  setInterval(() => { if (m.webhooks.length) { console.log(JSON.stringify(m.webhooks.splice(0), null, 1)); } }, 500);
}
