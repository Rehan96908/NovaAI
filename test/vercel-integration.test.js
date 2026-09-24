'use strict';
// Menguji pola yang persis dipakai api/index.js di Vercel: setiap permintaan HTTP
// memanggil loadDb() di awal dan flushIfDirty() di akhir, mengelilingi requestHandler
// yang SAMA PERSIS dipakai server.js (tidak ada logika rute yang diduplikasi/ditulis
// ulang). Ini membuktikan data benar-benar bertahan lintas permintaan terpisah saat
// backend Postgres aktif — bukan cuma lintas pemanggilan fungsi dalam satu proses.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os'), fs = require('fs'), path = require('path');

process.env.POSTGRES_URL = 'postgres://user:pass@localhost:5432/testdb';
Object.assign(process.env, {
  ONTOKEN_API_KEY: 'sk-test', JWT_SECRET: 'v'.repeat(48),
  MODELS_FILE: path.join(__dirname, 'models.test.json'), FREE_DAILY_MESSAGES: '50',
  REGISTER_PER_HOUR: '200', ENV_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-vercel-')), 'none.env'),
  DEFAULT_MODEL: 'claude-sonnet-5',
});

// Berkas ini menguji pola api/index.js memakai driver "pg" TIRUAN (lihat
// node_modules/pg/index.js), yang hanya ada di lingkungan pengembangan proyek ini.
// Bila dijalankan dengan paket "pg" ASLI (mis. `npm test` di mesin pengguna setelah
// `npm install`), berkas ini otomatis dilewati dengan aman.
const HAS_MOCK = (() => { try { return !!require('pg').__mock; } catch { return false; } })();
if (!HAS_MOCK) console.log('[vercel-integration.test.js] dilewati: driver "pg" tiruan tidak terdeteksi (ini normal di luar lingkungan pengembangan).');

let mock, srv, base, mockPg, dbMod;
before(async () => {
  if (!HAS_MOCK) return;
  mock = await require('./mock-upstream').start();
  process.env.ONTOKEN_BASE_URL = mock.url;
  mockPg = require('pg').__mock; mockPg.reset();

  const cfg = require('../lib/config');
  assert.equal(cfg.HAS_POSTGRES, true, 'config harus mendeteksi mode Postgres');
  dbMod = require('../lib/db');
  assert.equal(dbMod.mode, 'postgres');
  const { requestHandler } = require('../server');

  // Pola persis api/index.js:
  srv = http.createServer(async (req, res) => {
    await dbMod.loadDb();
    try { await requestHandler(req, res); }
    finally { await dbMod.flushIfDirty(); }
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { if (HAS_MOCK) { srv.close(); mock.server.close(); } });

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, ...(cookie ? { headers: { 'Content-Type': 'application/json', Cookie: cookie } } : {}) });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; cookie = /=$/.test(kv) ? '' : kv; }
    return res;
  };
  return {
    j: async (method, url, body) => { const r = await call(method, url, body); return { status: r.status, body: await r.json().catch(() => null) }; },
    chat: async (payload) => { const r = await call('POST', '/api/chat', payload); const t = await r.text(); return { status: r.status, events: t.split('\n\n').filter((x) => x.startsWith('data:')).map((x) => JSON.parse(x.slice(5))) }; },
  };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const answer = (evs) => evs.filter((e) => e.type === 'delta').map((e) => e.t).join('');

test('data bertahan lintas permintaan HTTP terpisah (register di request A, terlihat di request B)', async () => {
  if (!HAS_MOCK) return;
  const a = client();
  const reg = await a.j('POST', '/api/auth/register', { name: 'Uji Vercel', email: 'vercel@test.id', password: 'rahasia123' });
  assert.equal(reg.status, 200);
  assert.ok(mockPg.store.get('nova_state').get(1).users, 'data sudah tertulis ke "Postgres" setelah request selesai');

  // Request B: proses yang sama, tapi ini test terpisah utuh -> loadDb() akan
  // membaca ulang dari mockPg.store (bukan dari cache in-memory permintaan sebelumnya).
  const b = client();
  const login = await b.j('POST', '/api/auth/login', { email: 'vercel@test.id', password: 'rahasia123' });
  assert.equal(login.status, 200, 'user yang didaftarkan di request A bisa login di request B');
  assert.equal(login.body.user.name, 'Uji Vercel');
});

test('chat streaming tersimpan lewat backend Postgres dan terlihat di permintaan berikutnya', async () => {
  if (!HAS_MOCK) return;
  const a = client();
  await a.j('POST', '/api/auth/register', { name: 'Chat User', email: 'chatpg@test.id', password: 'rahasia123' });
  const r = await a.chat({ text: 'halo dari tes postgres', model: 'claude-sonnet-5' });
  assert.equal(r.status, 200);
  assert.equal(answer(r.events), 'Halo! Kamu bilang: halo dari tes postgres');
  const cid = r.events[0].conversationId;

  const conv = await a.j('GET', `/api/conversations/${cid}`);
  assert.equal(conv.body.conversation.messages.length, 2);

  // Simulasikan "cold start" lain: bersihkan in-memory dan muat ulang langsung dari mock Postgres.
  for (const k of Object.keys(dbMod.db)) delete dbMod.db[k];
  await dbMod.loadDb();
  const found = Object.values(dbMod.db.conversations).find((c) => c.id === cid);
  assert.ok(found, 'percakapan ditemukan lagi setelah dimuat ulang dari (mock) Postgres');
  assert.equal(found.messages[0].content, 'halo dari tes postgres');
});

test('lampiran teks disimpan sebagai base64 di record (bukan di disk) dan tetap terbaca untuk prompt', async () => {
  if (!HAS_MOCK) return;
  const a = client();
  await a.j('POST', '/api/auth/register', { name: 'File User', email: 'filepg@test.id', password: 'rahasia123' });
  const up = await a.j('POST', '/api/files', { name: 'catatan.md', data: b64('# Rahasia\nIsi dari mode postgres') });
  assert.equal(up.status, 200);
  const rec = dbMod.db.files[up.body.file.id];
  assert.ok(rec.data, 'file punya field data (base64) di dalam dokumen JSON, bukan field rel/disk');
  assert.equal(rec.rel, undefined);

  const r = await a.chat({ text: 'ringkas file ini', fileIds: [up.body.file.id] });
  assert.equal(r.status, 200);
  const sentToUpstream = mock.state.last.messages.at(-1).content;
  assert.match(sentToUpstream, /Rahasia/, 'isi file berhasil dibaca dari base64 record dan disisipkan ke prompt');
});

test('MAX_FILE_MB otomatis diturunkan ke 3 MB pada mode Postgres (menjaga di bawah batas body ±4.5 MB Vercel)', () => {
  if (!HAS_MOCK) return;
  const cfg = require('../lib/config');
  assert.equal(cfg.MAX_FILE_MB, 3);
});

test('JWT_SECRET wajib diisi eksplisit saat berjalan di atas Vercel (tidak boleh mencoba menulis disk)', () => {
  if (!HAS_MOCK) return;
  delete require.cache[require.resolve('../lib/config')];
  const prevSecret = process.env.JWT_SECRET, prevVercel = process.env.VERCEL;
  delete process.env.JWT_SECRET; process.env.VERCEL = '1';
  try { assert.throws(() => require('../lib/config'), /JWT_SECRET belum diisi/); }
  finally { process.env.JWT_SECRET = prevSecret; if (prevVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = prevVercel; delete require.cache[require.resolve('../lib/config')]; require('../lib/config'); }
});
