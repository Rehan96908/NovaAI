'use strict';
// Server tiruan ON Token (format OpenAI-compatible) khusus untuk pengujian offline.
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(port = 0) {
  const state = { last: null, requests: [], mode: 'sse', aborted: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const fail = (status, message) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message } })); };
    if (req.headers.authorization !== 'Bearer sk-test') return fail(401, 'Invalid API key');

    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'claude-sonnet-5' }, { id: 'claude-opus-5' }, { id: 'deepseek-v4-flash-0731' }] }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw); state.last = body; state.requests.push(body);
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const text = typeof lastUser.content === 'string' ? lastUser.content : lastUser.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
      if (text.includes('__402__')) return fail(402, 'insufficient balance');
      if (text.includes('__500__')) return fail(500, 'boom');
      if (body.model === 'strict-model' && 'temperature' in body) return fail(400, "Unsupported parameter: 'temperature' is not supported with this model");

      const slow = text.includes('__slow__');
      let reply;
      if (slow) reply = 'lambat '.repeat(60);
      else if (/tabel|bandingkan/i.test(text)) reply = 'Berikut tabelnya:\n\n| Model | Kecepatan | Penalaran |\n|---|---|---|\n| Nova Lite | Cepat | Dasar |\n| Nova Pro | Sedang | Kuat |\n\n**Ringkasan:** pilih sesuai kebutuhan.';
      else if (/kode|debounce|fungsi/i.test(text)) reply = 'Ini contohnya:\n\n```javascript\nfunction halo() {\n  return "dunia";\n}\n```\n\nSemoga membantu.';
      else reply = `Halo! Kamu bilang: ${text.slice(0, 300)}`;
      const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };
      if (state.mode === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.on('close', () => { if (!res.writableEnded) state.aborted++; });
      for (const w of reply.split(/(?<= )/)) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
        await sleep(slow ? 40 : 1);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/v1` })));
}
module.exports = { start };
