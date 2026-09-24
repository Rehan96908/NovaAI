'use strict';
// Pengujian API end-to-end (memakai server tiruan ON Token, tanpa internet).  Jalankan: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os'), fs = require('fs'), path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-test-'));
Object.assign(process.env, {
  DATA_DIR: tmp, ONTOKEN_API_KEY: 'sk-test', JWT_SECRET: 'j'.repeat(48), MODELS_FILE: path.join(__dirname, 'models.test.json'),
  FREE_DAILY_MESSAGES: '14', MAX_FILE_MB: '1', STORAGE_LIMIT_MB: '2', REGISTER_PER_HOUR: '200', ENV_FILE: path.join(tmp, 'none.env'), DEFAULT_MODEL: 'claude-sonnet-5',
});
let mock, app, base, cfg;
before(async () => {
  mock = await require('./mock-upstream').start();
  process.env.ONTOKEN_BASE_URL = mock.url;
  cfg = require('../lib/config');
  app = require('../server');
  await app.start(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.flush(); app.server.closeAllConnections?.(); app.server.close(); mock.server.closeAllConnections?.(); mock.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/* ── helper ── */
function client() {
  let cookie = '';
  const call = async (method, url, body, extra = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; cookie = /=$/.test(kv) ? '' : kv; }
    return res;
  };
  const j = async (method, url, body, extra) => { const r = await call(method, url, body, extra); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
  const chat = async (payload) => {
    const r = await call('POST', '/api/chat', payload); const t = await r.text();
    if ((r.headers.get('content-type') || '').includes('event-stream')) return { status: r.status, events: t.split('\n\n').filter((x) => x.startsWith('data:')).map((x) => JSON.parse(x.slice(5))) };
    return { status: r.status, body: JSON.parse(t) };
  };
  return { call, j, chat, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}
let n = 0;
async function newUser() { const c = client(); const email = `u${++n}@test.id`; const r = await c.j('POST', '/api/auth/register', { name: 'Uji ' + n, email, password: 'rahasia123' }); assert.equal(r.status, 200); return { c, email }; }
const answer = (evs) => evs.filter((e) => e.type === 'delta').map((e) => e.t).join('');
const b64 = (s) => Buffer.from(s).toString('base64');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/* ── umum ── */
test('health & daftar model bersifat publik, header keamanan terpasang', async () => {
  const c = client();
  const h = await c.j('GET', '/api/health'); assert.equal(h.status, 200); assert.equal(h.body.upstreamConfigured, true);
  assert.match(h.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  const m = await c.j('GET', '/api/models'); assert.equal(m.body.default, 'claude-sonnet-5'); assert.ok(m.body.models.some((x) => x.id === 'deepseek-v4-flash-0731' && x.vision === false));
});
test('file statis: / menyajikan index.html, path traversal ditolak', async () => {
  if (!fs.existsSync(path.join(__dirname, '..', 'public', 'index.html'))) return;
  const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /<html/i);
  assert.equal((await fetch(base + '/..%2f..%2fserver.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
});

/* ── autentikasi ── */
test('register: validasi input, duplikat, cookie httpOnly', async () => {
  const c = client();
  assert.equal((await c.j('POST', '/api/auth/register', { name: 'A', email: 'a@b.id', password: 'rahasia123' })).status, 400);
  assert.equal((await c.j('POST', '/api/auth/register', { name: 'Budi', email: 'bukan-email', password: 'rahasia123' })).status, 400);
  assert.equal((await c.j('POST', '/api/auth/register', { name: 'Budi', email: 'b@b.id', password: 'pendek' })).status, 400);
  const ok = await c.call('POST', '/api/auth/register', { name: 'Budi', email: 'budi@test.id', password: 'rahasia123' });
  assert.equal(ok.status, 200);
  const sc = ok.headers.getSetCookie()[0]; assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
  const body = await ok.json(); assert.equal(body.user.email, 'budi@test.id'); assert.ok(!('passHash' in body.user));
  assert.equal((await client().j('POST', '/api/auth/register', { name: 'Budi 2', email: 'BUDI@test.id', password: 'rahasia123' })).status, 409);
  assert.equal((await c.j('GET', '/api/auth/me')).body.user.name, 'Budi');
});
test('/api/auth/session: null bila belum login, berisi user bila sudah', async () => {
  const c = client(); assert.deepEqual((await c.j('GET', '/api/auth/session')).body, { user: null });
  const { c: u } = await newUser(); const s = await u.j('GET', '/api/auth/session'); assert.equal(s.status, 200); assert.ok(s.body.user.email);
  assert.equal((await c.j('GET', '/api/models')).body.limits.dailyMessages, 14);
});
test('login: pesan error generik, sukses, logout menghapus sesi', async () => {
  const { email } = await newUser(); const c = client();
  const bad = await c.j('POST', '/api/auth/login', { email, password: 'salah-salah' });
  const none = await c.j('POST', '/api/auth/login', { email: 'tidak-ada@test.id', password: 'rahasia123' });
  assert.equal(bad.status, 401); assert.equal(bad.body.error, none.body.error);
  assert.equal((await c.j('POST', '/api/auth/login', { email, password: 'rahasia123' })).status, 200);
  assert.equal((await c.j('GET', '/api/auth/me')).status, 200);
  await c.j('POST', '/api/auth/logout'); assert.equal((await c.j('GET', '/api/auth/me')).status, 401);
});
test('endpoint terlindungi butuh login; cookie dipalsukan ditolak; CSRF (Origin asing) ditolak', async () => {
  const c = client();
  for (const [m, u] of [['GET', '/api/conversations'], ['GET', '/api/stats'], ['POST', '/api/chat'], ['POST', '/api/files']]) assert.equal((await c.j(m, u, m === 'POST' ? {} : undefined)).status, 401, u);
  const { c: u } = await newUser(); u.cookie = u.cookie.slice(0, -3) + 'abc';
  assert.equal((await u.j('GET', '/api/auth/me')).status, 401);
  const evil = await client().j('POST', '/api/auth/login', { email: 'x@y.id', password: 'rahasia123' }, { Origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
});
test('rate limit login: percobaan berlebih diblokir', async () => {
  const c = client(); let last;
  for (let i = 0; i < 10; i++) last = await c.j('POST', '/api/auth/login', { email: 'brute@test.id', password: 'salah-salah' });
  assert.equal(last.status, 429);
});
test('pendaftaran bisa ditutup lewat konfigurasi', async () => {
  cfg.ALLOW_REGISTRATION = false;
  try { assert.equal((await client().j('POST', '/api/auth/register', { name: 'Zed', email: 'zed@test.id', password: 'rahasia123' })).status, 403); }
  finally { cfg.ALLOW_REGISTRATION = true; }
});
test('body terlalu besar → 413', async () => {
  const r = await client().j('POST', '/api/auth/login', { email: 'a@b.id', password: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(r.status, 413);
});

/* ── chat ── */
test('chat baru: stream meta → delta → done, tersimpan, API key tak bocor ke klien', async () => {
  const { c } = await newUser();
  const r = await c.chat({ text: 'Apa kabar dunia?', model: 'claude-sonnet-5' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.events[0].type, r.events.at(-1).type], ['meta', 'done']);
  assert.equal(answer(r.events), 'Halo! Kamu bilang: Apa kabar dunia?');
  assert.ok(r.events.filter((e) => e.type === 'delta').length > 3, 'harus streaming, bukan satu potong');
  assert.equal(JSON.stringify(r.events).includes('sk-test'), false);
  const sys = mock.state.last.messages[0]; assert.equal(sys.role, 'system'); assert.match(sys.content, /Nova AI/);
  assert.equal(mock.state.last.stream, true); assert.equal(mock.state.last.model, 'claude-sonnet-5'); assert.equal(mock.state.last.temperature, 0.6);
  const conv = (await c.j('GET', `/api/conversations/${r.events[0].conversationId}`)).body.conversation;
  assert.equal(conv.title, 'Apa kabar dunia?'); assert.equal(conv.messages.length, 2); assert.equal(conv.messages[1].tokens, 19);
});
test('lanjutan percakapan mengirim riwayat; regenerate mengganti jawaban; edit memotong riwayat', async () => {
  const { c } = await newUser();
  const a = await c.chat({ text: 'pertama' }); const id = a.events[0].conversationId;
  await c.chat({ text: 'kedua', conversationId: id });
  assert.deepEqual(mock.state.last.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
  const before = (await c.j('GET', `/api/conversations/${id}`)).body.conversation.messages;
  const rg = await c.chat({ conversationId: id, regenerate: true });
  const after = (await c.j('GET', `/api/conversations/${id}`)).body.conversation.messages;
  assert.equal(after.length, before.length); assert.notEqual(after.at(-1).id, before.at(-1).id); assert.equal(rg.events[0].userMessageId, null);
  const edit = await c.chat({ conversationId: id, text: 'pertama (diedit)', truncateFrom: before[0].id });
  const done = (await c.j('GET', `/api/conversations/${id}`)).body.conversation.messages;
  assert.equal(done.length, 2); assert.equal(done[0].content, 'pertama (diedit)'); assert.match(answer(edit.events), /diedit/);
});
test('validasi chat: pesan kosong, model asing, percakapan milik orang lain', async () => {
  const { c } = await newUser(); const { c: other } = await newUser();
  assert.equal((await c.chat({ text: '   ' })).status, 400);
  assert.equal((await c.chat({ text: 'hai', model: 'gpt-nope' })).status, 400);
  const mine = (await c.chat({ text: 'rahasia saya' })).events[0].conversationId;
  assert.equal((await other.chat({ text: 'intip', conversationId: mine })).status, 404);
  assert.equal((await other.j('GET', `/api/conversations/${mine}`)).status, 404);
});
test('lampiran teks disisipkan ke prompt; gambar hanya untuk model vision', async () => {
  const { c } = await newUser();
  const t = (await c.j('POST', '/api/files', { name: 'catatan.md', data: b64('# Judul rahasia\nisi file') })).body.file;
  assert.equal(t.kind, 'text');
  const r = await c.chat({ text: 'ringkas file ini', fileIds: [t.id] });
  const u = mock.state.last.messages.at(-1).content; assert.match(u, /catatan\.md/); assert.match(u, /Judul rahasia/);
  const conv = (await c.j('GET', `/api/conversations/${r.events[0].conversationId}`)).body.conversation;
  assert.equal(conv.messages[0].files[0].name, 'catatan.md');

  const img = (await c.j('POST', '/api/files', { name: 'foto.png', data: PNG })).body.file; assert.equal(img.kind, 'image');
  const ok = await c.chat({ text: 'apa ini?', fileIds: [img.id], model: 'claude-opus-5' }); assert.equal(ok.status, 200);
  const parts = mock.state.last.messages.at(-1).content; assert.ok(Array.isArray(parts) && parts.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));

  const cid = ok.events[0].conversationId; const countBefore = (await c.j('GET', `/api/conversations/${cid}`)).body.conversation.messages.length;
  const no = await c.chat({ text: 'lihat', fileIds: [img.id], model: 'deepseek-v4-flash-0731', conversationId: cid });
  assert.equal(no.status, 400); assert.match(no.body.error, /tidak bisa membaca gambar/);
  assert.equal((await c.j('GET', `/api/conversations/${cid}`)).body.conversation.messages.length, countBefore, 'permintaan ditolak tidak boleh mengubah percakapan');
});
test('upload: tipe tidak didukung, gambar palsu, terlalu besar, nama file disanitasi', async () => {
  const { c } = await newUser();
  assert.equal((await c.j('POST', '/api/files', { name: 'virus.exe', data: b64('MZ\u0000\u0001binary') })).status, 415);
  assert.equal((await c.j('POST', '/api/files', { name: 'palsu.png', data: b64('ini bukan gambar') })).status, 415);
  assert.equal((await c.j('POST', '/api/files', { name: 'besar.txt', data: Buffer.alloc(1.2 * 1048576, 65).toString('base64') })).status, 413);
  const ok = await c.j('POST', '/api/files', { name: '../../etc/passwd.txt', data: b64('aman') }); assert.equal(ok.status, 200); assert.ok(!ok.body.file.name.includes('/'));
  assert.equal((await c.j('POST', '/api/files', { name: 'x.txt', data: '' })).status, 400);
});
test('kuota harian dibatasi per pengguna', async () => {
  const { c } = await newUser(); let last;
  for (let i = 0; i < 14; i++) { last = await c.chat({ text: 'pesan ' + i }); assert.equal(last.status, 200, 'pesan ke-' + i); }
  const over = await c.chat({ text: 'kelebihan' }); assert.equal(over.status, 429); assert.match(over.body.error, /14 pesan/);
  const st = (await c.j('GET', '/api/stats')).body; assert.equal(st.quota.usedToday, 14); assert.equal(st.quota.dailyLimit, 14);
});
test('error dari ON Token dipetakan ke pesan ramah; pesan pengguna tetap tersimpan', async () => {
  const { c } = await newUser();
  const a = await c.chat({ text: '__402__ tes' }); const e = a.events.find((x) => x.type === 'error'); assert.match(e.message, /Saldo ON Token/);
  const conv = (await c.j('GET', `/api/conversations/${a.events[0].conversationId}`)).body.conversation;
  assert.deepEqual(conv.messages.map((m) => m.role), ['user']);
  const b = await c.chat({ text: '__500__ tes' }); assert.match(b.events.find((x) => x.type === 'error').message, /bermasalah/);
  const saved = cfg.ONTOKEN_API_KEY; cfg.ONTOKEN_API_KEY = 'sk-salah';
  try { const r = await c.chat({ text: 'halo' }); assert.match(r.events.find((x) => x.type === 'error').message, /API key ON Token ditolak/); assert.equal(JSON.stringify(r.events).includes('sk-salah'), false); }
  finally { cfg.ONTOKEN_API_KEY = saved; }
  cfg.ONTOKEN_API_KEY = ''; try { assert.equal((await c.chat({ text: 'halo' })).status, 503); } finally { cfg.ONTOKEN_API_KEY = saved; }
});
test('parameter yang ditolak gateway dicoba ulang tanpa parameter itu; balasan non-stream tetap didukung', async () => {
  const { c } = await newUser();
  const r = await c.chat({ text: 'coba strict', model: 'strict-model' });
  assert.equal(answer(r.events), 'Halo! Kamu bilang: coba strict'); assert.ok(!('temperature' in mock.state.last));
  mock.state.mode = 'json';
  try { const j = await c.chat({ text: 'mode json' }); assert.equal(answer(j.events), 'Halo! Kamu bilang: mode json'); } finally { mock.state.mode = 'sse'; }
});
test('stop di tengah stream: jawaban parsial tersimpan (aborted) dan koneksi ke ON Token diputus', async () => {
  const { c } = await newUser(); const ctrl = new AbortController();
  const before = mock.state.aborted;
  const res = await fetch(base + '/api/chat', { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Cookie: c.cookie }, body: JSON.stringify({ text: '__slow__ panjang' }) });
  const reader = res.body.getReader(); let got = '', cid = null;
  while ((got.match(/"type":"delta"/g) || []).length < 3) { const { value, done } = await reader.read(); if (done) break; got += Buffer.from(value).toString(); const m = got.match(/"conversationId":"([^"]+)"/); if (m) cid = m[1]; }
  ctrl.abort(); await new Promise((r) => setTimeout(r, 500));
  const conv = (await c.j('GET', `/api/conversations/${cid}`)).body.conversation; const ai = conv.messages.at(-1);
  assert.equal(ai.role, 'assistant'); assert.equal(ai.aborted, true); assert.ok(ai.content.startsWith('lambat'));
  assert.ok(ai.content.length < 'lambat '.repeat(60).length); assert.equal(mock.state.aborted, before + 1);
});

/* ── percakapan ── */
test('CRUD percakapan: ganti nama, sematkan, arsipkan, like, hapus, hapus massal & semua', async () => {
  const { c } = await newUser(); const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await c.chat({ text: 'topik ' + i })).events[0].conversationId);
  assert.equal((await c.j('GET', '/api/conversations')).body.conversations.length, 4);
  const p = await c.j('PATCH', `/api/conversations/${ids[0]}`, { title: 'Judul Baru', pinned: true, archived: true });
  assert.deepEqual([p.body.conversation.title, p.body.conversation.pinned, p.body.conversation.archived], ['Judul Baru', true, true]);
  assert.equal((await c.j('PATCH', `/api/conversations/${ids[0]}`, { title: '   ' })).status, 400);
  const conv = (await c.j('GET', `/api/conversations/${ids[1]}`)).body.conversation;
  await c.j('PATCH', `/api/conversations/${ids[1]}/messages/${conv.messages[1].id}`, { like: 1 });
  assert.equal((await c.j('GET', `/api/conversations/${ids[1]}`)).body.conversation.messages[1].like, 1);
  assert.equal((await c.j('DELETE', `/api/conversations/${ids[2]}`)).status, 200); assert.equal((await c.j('GET', `/api/conversations/${ids[2]}`)).status, 404);
  assert.equal((await c.j('POST', '/api/conversations/bulk-delete', { ids: [ids[0], ids[1], 'tidak-ada'] })).body.deleted, 2);
  assert.equal((await c.j('DELETE', '/api/conversations')).body.deleted, 1);
  assert.equal((await c.j('GET', '/api/conversations')).body.conversations.length, 0);
});

/* ── akun, pengaturan, statistik ── */
test('pengaturan & profil: validasi dan tersimpan; avatar divalidasi', async () => {
  const { c } = await newUser();
  assert.equal((await c.j('PATCH', '/api/me/settings', { defaultModel: 'nope' })).status, 400);
  assert.equal((await c.j('PATCH', '/api/me/settings', { temperature: 5 })).status, 400);
  assert.equal((await c.j('PATCH', '/api/me/settings', { style: 'ngawur' })).status, 400);
  await c.j('PATCH', '/api/me/settings', { defaultModel: 'claude-opus-5', temperature: 0.3, style: 'ringkas', streaming: false });
  const me = (await c.j('GET', '/api/auth/me')).body.user; assert.deepEqual([me.settings.defaultModel, me.settings.temperature, me.settings.streaming], ['claude-opus-5', 0.3, false]);
  await c.chat({ text: 'pakai default' }); assert.equal(mock.state.last.model, 'claude-opus-5'); assert.equal(mock.state.last.temperature, 0.3); assert.match(mock.state.last.messages[0].content, /ringkas/);
  assert.equal((await c.j('PATCH', '/api/me', { name: 'X' })).status, 400);
  assert.equal((await c.j('PATCH', '/api/me', { name: 'Nama Baru', bio: 'suka kopi' })).body.user.name, 'Nama Baru');
  assert.equal((await c.j('PATCH', '/api/me', { avatar: 'data:image/png;base64,' + PNG })).status, 200);
  assert.equal((await c.j('PATCH', '/api/me', { avatar: 'javascript:alert(1)' })).status, 400);
  assert.equal((await c.j('PATCH', '/api/me', { avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
});
test('ganti kata sandi & keluar dari semua perangkat mencabut sesi lain', async () => {
  const { c, email } = await newUser(); const other = client();
  await other.j('POST', '/api/auth/login', { email, password: 'rahasia123' }); assert.equal((await other.j('GET', '/api/auth/me')).status, 200);
  assert.equal((await c.j('POST', '/api/me/password', { current: 'salah-salah', next: 'baru12345' })).status, 400);
  assert.equal((await c.j('POST', '/api/me/password', { current: 'rahasia123', next: 'baru12345' })).status, 200);
  assert.equal((await c.j('GET', '/api/auth/me')).status, 200, 'sesi yang mengganti sandi tetap aktif');
  assert.equal((await other.j('GET', '/api/auth/me')).status, 401, 'sesi lain dicabut');
  assert.equal((await client().j('POST', '/api/auth/login', { email, password: 'rahasia123' })).status, 401);
  const again = client(); assert.equal((await again.j('POST', '/api/auth/login', { email, password: 'baru12345' })).status, 200);
  assert.equal((await c.j('POST', '/api/auth/logout-all')).status, 200); assert.equal((await again.j('GET', '/api/auth/me')).status, 401); assert.equal((await c.j('GET', '/api/auth/me')).status, 200);
});
test('statistik dashboard dihitung dari data nyata', async () => {
  const { c } = await newUser();
  await c.chat({ text: 'satu', model: 'claude-sonnet-5' }); await c.chat({ text: 'dua', model: 'claude-sonnet-5' }); await c.chat({ text: 'tiga', model: 'deepseek-v4-flash-0731' });
  await c.j('POST', '/api/files', { name: 'a.txt', data: b64('halo') });
  const s = (await c.j('GET', '/api/stats')).body;
  assert.equal(s.totals.chats, 3); assert.equal(s.totals.msgCur, 3); assert.equal(s.totals.tokCur, 57);
  assert.equal(s.activity[7].length, 7); assert.equal(s.activity[30].length, 30); assert.equal(s.activity[7].at(-1).count, 3);
  assert.equal(s.favorite.name, 'Claude Sonnet 5'); assert.equal(s.favorite.pct, 67); assert.equal(s.files.length, 1); assert.equal(s.quota.storageBytes, 4);
  await c.j('DELETE', `/api/files/${s.files[0].id}`); assert.equal((await c.j('GET', '/api/stats')).body.files.length, 0);
});
test('ekspor data tanpa hash sandi; hapus akun menghapus semua data & file', async () => {
  const { c } = await newUser();
  await c.chat({ text: 'data saya' }); const f = (await c.j('POST', '/api/files', { name: 'x.txt', data: b64('isi') })).body.file;
  const me = (await c.j('GET', '/api/auth/me')).body.user;
  const ex = await c.call('GET', '/api/me/export'); const raw = await ex.text();
  assert.match(ex.headers.get('content-disposition'), /attachment/); assert.ok(!raw.includes('passHash') && !raw.includes('s1$')); assert.equal(JSON.parse(raw).conversations.length, 1);
  const dir = path.join(tmp, 'uploads', me.id); assert.ok(fs.existsSync(dir));
  assert.equal((await c.j('DELETE', '/api/me', { confirm: 'salah' })).status, 400);
  assert.equal((await c.j('DELETE', '/api/me', { confirm: 'HAPUS' })).status, 200);
  assert.equal((await c.j('GET', '/api/auth/me')).status, 401); assert.equal(fs.existsSync(dir), false);
  assert.equal((await client().j('POST', '/api/auth/login', { email: me.email, password: 'rahasia123' })).status, 401);
  void f;
});
