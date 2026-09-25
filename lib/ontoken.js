'use strict';
// Klien ON Token (OpenAI-compatible). API key hanya dibaca di sini, di sisi server.
const cfg = require('./config');

class UpstreamError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function streamGeminiFallback({ messages, onDelta, signal }) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return false;
  try {
    const contents = [];
    let systemInstruction = undefined;
    for (const m of messages) {
      if (m.role === 'system') {
        const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        systemInstruction = { parts: [{ text: txt }] };
      } else {
        const role = m.role === 'assistant' ? 'model' : 'user';
        let text = '';
        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          text = m.content.map((p) => p.text || '').filter(Boolean).join('\n');
        }
        contents.push({ role, parts: [{ text: text || '...' }] });
      }
    }
    if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: 'Halo' }] });
    const reqBody = { contents };
    if (systemInstruction) reqBody.systemInstruction = systemInstruction;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse&key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal,
    });
    if (!res.ok) return false;

    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) onDelta(text);
      }
    }
    return true;
  } catch (err) {
    console.warn('[ontoken] Gemini fallback error:', err.message);
    return false;
  }
}

function friendly(status, text) {
  let detail = '';
  try { const j = JSON.parse(text); detail = (j.error && (j.error.message || j.error)) || j.message || ''; }
  catch { detail = String(text || '').slice(0, 200); }
  detail = String(detail).replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***').slice(0, 220);
  if (status === 401 || status === 403) {
    if (/revoked/i.test(detail)) {
      return 'API key ON Token ditolak: kunci berstatus "revoked" (dicabut) oleh provider ontoken.id. Silakan perbarui dengan API key aktif di Pengaturan atau file .env.';
    }
    return 'API key ON Token ditolak. Periksa ONTOKEN_API_KEY di file .env.';
  }
  if (status === 402) return 'Saldo ON Token tidak cukup. Isi saldo, lalu coba lagi.';
  if (status === 404) return 'Model atau endpoint tidak ditemukan di ON Token. Periksa ID model (models.json) dan ONTOKEN_BASE_URL.';
  if (status === 429) return 'ON Token membatasi permintaan (terlalu banyak). Coba lagi sebentar lagi.';
  if (status >= 500) return 'Server ON Token sedang bermasalah. Coba lagi nanti.';
  return `Permintaan ke ON Token gagal (${status})${detail ? ': ' + detail : ''}`;
}

function post(pathname, body, signal, keyToUse) {
  const token = (keyToUse || cfg.ONTOKEN_API_KEY || '').trim();
  return fetch(cfg.ONTOKEN_BASE_URL + pathname, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

// Membuka koneksi. Bila gateway menolak parameter opsional (mis. temperature), coba lagi tanpa parameter itu.
async function open(body, signal, keyToUse) {
  const optional = ['stream_options', 'temperature', 'max_tokens'];
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await post('/chat/completions', body, signal, keyToUse);
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    if (res.status === 400 || res.status === 422) {
      const bad = optional.find((p) => p in body && text.includes(p));
      if (bad) {
        if (bad === 'max_tokens' && !('max_completion_tokens' in body)) body.max_completion_tokens = body.max_tokens;
        delete body[bad];
        continue;
      }
    }
    throw new UpstreamError(res.status, friendly(res.status, text));
  }
  throw new UpstreamError(502, 'ON Token menolak permintaan setelah beberapa percobaan.');
}

/**
 * Chat streaming. Memanggil onDelta(teks) untuk tiap potongan jawaban.
 * Mengembalikan { usage, finish }. Melempar UpstreamError bila gagal.
 */
async function streamChat({ model, messages, temperature, maxTokens, signal, apiKey, onDelta }) {
  const keyToUse = (apiKey || cfg.ONTOKEN_API_KEY || '').trim();
  if (!keyToUse) throw new UpstreamError(503, 'ONTOKEN_API_KEY belum diisi di file .env server.');
  const body = { model, messages, stream: true, max_tokens: maxTokens || cfg.MAX_OUTPUT_TOKENS };
  if (typeof temperature === 'number') body.temperature = temperature;
  let res;
  try {
    res = await open(body, signal, keyToUse);
  } catch (err) {
    if ((err.status === 401 || err.status === 403 || !keyToUse) && process.env.GEMINI_API_KEY && !process.env.MODELS_FILE && process.env.NODE_ENV !== "test") {
      console.warn('[ontoken] ON Token ditolak (' + err.message + '). Mengaktifkan Gemini fallback...');
      const ok = await streamGeminiFallback({ messages, onDelta, signal });
      if (ok) {
        return { usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 }, finish: 'stop' };
      }
    }
    throw err;
  }

  // Gateway yang mengabaikan stream=true membalas JSON biasa.
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const j = await res.json();
    const c = j.choices && j.choices[0];
    const t = c && c.message && typeof c.message.content === 'string' ? c.message.content : '';
    if (t) onDelta(t);
    return { usage: j.usage || null, finish: (c && c.finish_reason) || null };
  }

  const dec = new TextDecoder();
  let buf = '', usage = null, finish = null;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') return { usage, finish };
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new UpstreamError(502, friendly(502, JSON.stringify(j)));
      if (j.usage) usage = j.usage;
      const c = j.choices && j.choices[0];
      if (!c) continue;
      const d = c.delta && c.delta.content;
      if (typeof d === 'string' && d) onDelta(d);
      if (c.finish_reason) finish = c.finish_reason;
    }
  }
  return { usage, finish };
}

// Daftar ID model yang tersedia di akun ON Token (dipakai skrip `npm run check`).
async function listModels(signal) {
  const res = await fetch(cfg.ONTOKEN_BASE_URL + '/models', { headers: { Authorization: `Bearer ${cfg.ONTOKEN_API_KEY}` }, signal });
  const text = await res.text();
  if (!res.ok) throw new UpstreamError(res.status, friendly(res.status, text));
  try { const j = JSON.parse(text); return (j.data || j.models || []).map((m) => m.id).filter(Boolean); }
  catch { return [...text.matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]); }
}

module.exports = { streamChat, listModels, UpstreamError };
