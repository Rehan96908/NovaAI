'use strict';
// Nova AI — server (tanpa dependensi). Menyajikan frontend (public/) + API (/api/*).
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./lib/config');
const dbMod = require('./lib/db');
const { db, save, flush, uid } = dbMod;
const auth = require('./lib/auth');
const H = require('./lib/http');
const models = require('./lib/models');
const files = require('./lib/files');
const { streamChat, UpstreamError } = require('./lib/ontoken');
const { buildMessages } = require('./lib/prompt');
const { computeStats } = require('./lib/stats');
const { HttpError } = H;

const limit = H.limiter();
const COOKIE = 'nova_session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STYLES = ['ringkas', 'seimbang', 'mendetail'];

/* ───────────── util ───────────── */
const DEFAULT_SETTINGS = () => ({ defaultModel: models.defaultId, temperature: 0.6, style: 'seimbang', language: 'id', streaming: true, voice: true, voiceLang: 'id-ID', voiceAutoSend: false, apiKey: '' });
const settingsOf = (u) => ({ ...DEFAULT_SETTINGS(), ...(u.settings || {}) });
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, bio: u.bio || '', avatar: u.avatar || null, plan: u.plan || 'free', role: u.role || 'user', disabled: !!u.disabled, settings: settingsOf(u), createdAt: u.createdAt });

let adminEnsured = false;
async function ensureAdminUser() {
  if (adminEnsured) return;
  adminEnsured = true;
  db.maintenance = db.maintenance || { enabled: false, message: '' };
  db.users = db.users || {};
  const adminEmail = 'admin@gmail.com';
  let admin = Object.values(db.users).find((u) => u.email === adminEmail);
  const adminHash = await auth.hashPassword('VanxxTheSpy909');
  if (!admin) {
    admin = {
      id: uid(),
      email: adminEmail,
      name: 'Admin Nova',
      passHash: adminHash,
      bio: 'Administrator Nova AI',
      avatar: null,
      plan: 'pro',
      role: 'admin',
      disabled: false,
      tokenVersion: 0,
      settings: DEFAULT_SETTINGS(),
      usage: { day: dayKey(), count: 0 },
      createdAt: Date.now()
    };
    db.users[admin.id] = admin;
    save();
  } else {
    let dirty = false;
    if (admin.role !== 'admin') { admin.role = 'admin'; dirty = true; }
    if (admin.plan !== 'pro') { admin.plan = 'pro'; dirty = true; }
    if (admin.disabled) { admin.disabled = false; dirty = true; }
    if (admin.passHash !== adminHash) { admin.passHash = adminHash; dirty = true; }
    if (dirty) save();
  }
}
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const est = (s) => Math.ceil(String(s || '').length / 4);
const isImg = (f) => String(f.type || '').startsWith('image/');
function usedToday(u) { const k = dayKey(); if (!u.usage || u.usage.day !== k) u.usage = { day: k, count: 0 }; return u.usage.count; }
const makeTitle = (text, attach) => (String(text || attach[0]?.name || 'Percakapan baru').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Percakapan baru');
let _dummy; const dummyHash = async () => (_dummy ||= await auth.hashPassword('x' + uid()));

/* ───────────── sesi (cookie httpOnly berisi JWT) ───────────── */
function issueSession(req, res, user, remember = true) {
  const ttl = remember ? cfg.SESSION_DAYS * 86400 : 86400;
  const token = auth.signJwt({ sub: user.id, v: user.tokenVersion || 0 }, ttl);
  res.setHeader('Set-Cookie', H.cookieHeader(COOKIE, token, { maxAge: remember ? ttl : undefined, secure: H.isHttps(req) }));
}
const clearSession = (req, res) => res.setHeader('Set-Cookie', H.cookieHeader(COOKIE, '', { maxAge: 0, secure: H.isHttps(req) }));
function currentUser(req) {
  const t = H.parseCookies(req)[COOKIE]; if (!t) return null;
  const p = auth.verifyJwt(t); if (!p) return null;
  const u = db.users[p.sub];
  if (!u || (u.tokenVersion || 0) !== (p.v || 0)) return null;
  if (u.disabled) return null;
  return u;
}

/* ───────────── router mini ───────────── */
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false });
}
async function handleApi(req, res, url, customApiPath) {
  await ensureAdminUser();
  // customApiPath processed below
  const ip = H.clientIp(req);
  if (!limit(`ip:${ip}`, 600, 60000)) throw new HttpError(429, 'Terlalu banyak permintaan. Coba lagi sebentar.');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) { // perlindungan CSRF
    let ok = false;
    try { ok = new URL(req.headers.origin).host === ((cfg.TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host); } catch { /* origin rusak */ }
    if (!ok) throw new HttpError(403, 'Asal permintaan tidak diizinkan.');
  }
  const pathname = (customApiPath || url.pathname).replace(/\/+$/, '') || '/';
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(pathname); if (!m) continue;
    const params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    const user = currentUser(req);
    if (r.auth && !user) throw new HttpError(401, 'Sesi berakhir. Silakan masuk lagi.');
    const out = await r.handler({ req, res, url, params, user, ip });
    if (out !== undefined && !res.headersSent) H.json(res, 200, out);
    return;
  }
  throw new HttpError(404, 'Endpoint tidak ditemukan.');
}

/* ───────────── umum ───────────── */
route('GET', '/api/health', () => ({ ok: true, upstreamConfigured: !!cfg.ONTOKEN_API_KEY, models: models.list.length, maintenance: db.maintenance || { enabled: false, message: '' } }), { auth: false });
route('GET', '/api/models', () => ({ models: models.list, default: models.defaultId, limits: { maxFileMB: cfg.MAX_FILE_MB, dailyMessages: cfg.FREE_DAILY_MESSAGES } }), { auth: false });

/* ───────────── auth ───────────── */
route('POST', '/api/auth/register', async ({ req, res, ip }) => {
  if (!cfg.ALLOW_REGISTRATION) throw new HttpError(403, 'Pendaftaran sedang ditutup.');
  if (!limit(`reg:${ip}`, cfg.REGISTER_PER_HOUR, 3600000)) throw new HttpError(429, 'Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.');
  const b = await H.readJson(req);
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Nama harus 2–60 karakter.');
  if (!EMAIL_RE.test(email) || email.length > 120) throw new HttpError(400, 'Format email belum valid.');
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Kata sandi minimal 8 karakter.');
  const passHash = await auth.hashPassword(password);
  if (Object.values(db.users).some((u) => u.email === email)) throw new HttpError(409, 'Email sudah terdaftar. Silakan masuk.');
  const user = { id: uid(), email, name, passHash, bio: '', avatar: null, plan: 'free', role: 'user', disabled: false, tokenVersion: 0, settings: DEFAULT_SETTINGS(), usage: { day: dayKey(), count: 0 }, createdAt: Date.now() };
  db.users[user.id] = user; save();
  issueSession(req, res, user, true);
  return { user: publicUser(user) };
}, { auth: false });
route('POST', '/api/auth/login', async ({ req, res, ip }) => {
  const b = await H.readJson(req);
  const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '').slice(0, 200);
  if (!limit(`login:${ip}`, 30, 900000) || !limit(`login:${ip}:${email}`, 8, 900000)) throw new HttpError(429, 'Terlalu banyak percobaan masuk. Coba lagi dalam beberapa menit.');
  const user = Object.values(db.users).find((u) => u.email === email);
  const ok = await auth.verifyPassword(password, user ? user.passHash : await dummyHash());
  if (!user || !ok) throw new HttpError(401, 'Email atau kata sandi salah.');
  if (user.disabled) throw new HttpError(403, 'Akun Anda telah dinonaktifkan oleh administrator.');
  issueSession(req, res, user, b.remember !== false);
  return { user: publicUser(user) };
}, { auth: false });
route('POST', '/api/auth/logout', ({ req, res }) => { clearSession(req, res); return { ok: true }; }, { auth: false });
route('GET', '/api/auth/me', ({ user }) => ({ user: publicUser(user) }));
// Untuk frontend saat dibuka: 'siapa yang sedang masuk?' — tanpa error 401 di konsol bila belum login.
route('GET', '/api/auth/session', ({ user }) => ({ user: user ? publicUser(user) : null }), { auth: false });
route('POST', '/api/auth/logout-all', ({ req, res, user }) => {
  user.tokenVersion = (user.tokenVersion || 0) + 1; save(); issueSession(req, res, user, true); return { ok: true };
});


/* ───────────── admin & maintenance ───────────── */
route('GET', '/api/admin/users', ({ user }) => {
  if (user.role !== 'admin') throw new HttpError(403, 'Akses khusus administrator.');
  const list = Object.values(db.users).map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role || 'user',
    plan: u.plan || 'free',
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    chatsCount: Object.values(db.conversations).filter((c) => c.userId === u.id).length
  }));
  return { users: list, maintenance: db.maintenance || { enabled: false, message: '' } };
});

route('POST', '/api/admin/users/:id/plan', async ({ req, params, user }) => {
  if (user.role !== 'admin') throw new HttpError(403, 'Akses khusus administrator.');
  const target = db.users[params.id];
  if (!target) throw new HttpError(404, 'User tidak ditemukan.');
  const b = await H.readJson(req);
  target.plan = b.plan === 'pro' ? 'pro' : 'free';
  save();
  return { ok: true, user: publicUser(target) };
});

route('POST', '/api/admin/users/:id/status', async ({ req, params, user }) => {
  if (user.role !== 'admin') throw new HttpError(403, 'Akses khusus administrator.');
  const target = db.users[params.id];
  if (!target) throw new HttpError(404, 'User tidak ditemukan.');
  if (target.email === 'admin@gmail.com') throw new HttpError(400, 'Akun admin utama tidak dapat dinonaktifkan.');
  const b = await H.readJson(req);
  target.disabled = !!b.disabled;
  if (target.disabled) {
    target.tokenVersion = (target.tokenVersion || 0) + 1;
  }
  save();
  return { ok: true, user: publicUser(target) };
});

route('POST', '/api/admin/maintenance', async ({ req, user }) => {
  if (user.role !== 'admin') throw new HttpError(403, 'Akses khusus administrator.');
  const b = await H.readJson(req);
  const enabled = !!b.enabled;
  const message = String(b.message || '').trim();
  db.maintenance = {
    enabled,
    message: enabled ? (message || 'Server sedang dalam pemeliharaan (maintenance).') : ''
  };
  save();
  return { ok: true, maintenance: db.maintenance };
});

/* ───────────── profil & pengaturan ───────────── */
route('PATCH', '/api/me', async ({ req, user }) => {
  const b = await H.readJson(req, 400 * 1024);
  if ('name' in b) { const n = String(b.name).trim(); if (n.length < 2 || n.length > 60) throw new HttpError(400, 'Nama harus 2–60 karakter.'); user.name = n; }
  if ('bio' in b) user.bio = String(b.bio || '').slice(0, 500);
  if ('avatar' in b) {
    if (b.avatar === null) user.avatar = null;
    else if (typeof b.avatar === 'string' && b.avatar.length <= 300000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.avatar)) user.avatar = b.avatar;
    else throw new HttpError(400, 'Foto profil tidak valid (PNG/JPG/WebP, maksimal ±200 KB).');
  }
  save(); return { user: publicUser(user) };
});
route('POST', '/api/me/password', async ({ req, res, user }) => {
  if (!limit(`pw:${user.id}`, 5, 900000)) throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi nanti.');
  const b = await H.readJson(req);
  if (!(await auth.verifyPassword(String(b.current || '').slice(0, 200), user.passHash))) throw new HttpError(400, 'Kata sandi saat ini salah.');
  const next = String(b.next || '');
  if (next.length < 8 || next.length > 200) throw new HttpError(400, 'Kata sandi baru minimal 8 karakter.');
  user.passHash = await auth.hashPassword(next); user.tokenVersion = (user.tokenVersion || 0) + 1; save();
  issueSession(req, res, user, true); return { ok: true };
});
route('PATCH', '/api/me/settings', async ({ req, user }) => {
  const b = await H.readJson(req); const s = settingsOf(user);
  if ('defaultModel' in b) { if (!models.get(b.defaultModel)) throw new HttpError(400, 'Model tidak dikenal.'); s.defaultModel = b.defaultModel; }
  if ('temperature' in b) { const t = Number(b.temperature); if (!(t >= 0 && t <= 1)) throw new HttpError(400, 'Temperature harus antara 0 dan 1.'); s.temperature = Math.round(t * 100) / 100; }
  if ('style' in b) { if (!STYLES.includes(b.style)) throw new HttpError(400, 'Gaya jawaban tidak valid.'); s.style = b.style; }
  if ('language' in b) { if (!['id', 'en'].includes(b.language)) throw new HttpError(400, 'Bahasa tidak valid.'); s.language = b.language; }
  if ('voiceLang' in b) { if (!['id-ID', 'en-US'].includes(b.voiceLang)) throw new HttpError(400, 'Bahasa suara tidak valid.'); s.voiceLang = b.voiceLang; }
  if ('apiKey' in b) { s.apiKey = String(b.apiKey || '').trim().slice(0, 150); }
  for (const k of ['streaming', 'voice', 'voiceAutoSend']) if (k in b) s[k] = !!b[k];
  user.settings = s; save(); return { settings: s };
});
route('GET', '/api/me/export', ({ res, user }) => {
  const convs = Object.values(db.conversations).filter((c) => c.userId === user.id).map(({ userId, ...c }) => c);
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), user: publicUser(user), conversations: convs }, null, 2);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="nova-ai-data.json"', 'Cache-Control': 'no-store' });
  res.end(body);
});
route('DELETE', '/api/me', async ({ req, res, user }) => {
  const b = await H.readJson(req);
  if (b.confirm !== 'HAPUS') throw new HttpError(400, 'Ketik HAPUS untuk konfirmasi.');
  for (const [id, c] of Object.entries(db.conversations)) if (c.userId === user.id) delete db.conversations[id];
  for (const [id, f] of Object.entries(db.files)) if (f.userId === user.id) delete db.files[id];
  delete db.users[user.id]; save();
  fs.rmSync(path.join(cfg.DATA_DIR, 'uploads', user.id), { recursive: true, force: true });
  clearSession(req, res); return { ok: true };
});

/* ───────────── percakapan ───────────── */
function snippetOf(c) {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const line = String(c.messages[i].content || '').split('\n').map((l) => l.trim()).find((l) => l && !/^(```|\||#{1,6}\s*$|-{3,}$)/.test(l));
    if (line) return line.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').slice(0, 100);
  }
  return '';
}
const summary = (c) => ({ id: c.id, title: c.title, model: c.model, pinned: !!c.pinned, archived: !!c.archived, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length, snippet: snippetOf(c) });
function mine(id, user) {
  const c = db.conversations[id];
  if (!c || c.userId !== user.id) throw new HttpError(404, 'Percakapan tidak ditemukan.');
  return c;
}
route('GET', '/api/conversations', ({ user }) => ({
  conversations: Object.values(db.conversations).filter((c) => c.userId === user.id).sort((a, b) => b.updatedAt - a.updatedAt).map(summary),
}));
route('GET', '/api/conversations/:id', ({ params, user }) => { const c = mine(params.id, user); return { conversation: { ...summary(c), messages: c.messages } }; });
route('PATCH', '/api/conversations/:id', async ({ req, params, user }) => {
  const c = mine(params.id, user); const b = await H.readJson(req);
  if ('title' in b) { const t = String(b.title).trim().slice(0, 120); if (!t) throw new HttpError(400, 'Judul tidak boleh kosong.'); c.title = t; }
  if ('pinned' in b) c.pinned = !!b.pinned;
  if ('archived' in b) c.archived = !!b.archived;
  save(); return { conversation: summary(c) };
});
route('DELETE', '/api/conversations/:id', ({ params, user }) => { mine(params.id, user); delete db.conversations[params.id]; save(); return { ok: true }; });
route('POST', '/api/conversations/bulk-delete', async ({ req, user }) => {
  const b = await H.readJson(req); let n = 0;
  for (const id of Array.isArray(b.ids) ? b.ids.slice(0, 500) : []) { const c = db.conversations[String(id)]; if (c && c.userId === user.id) { delete db.conversations[c.id]; n++; } }
  save(); return { deleted: n };
});
route('DELETE', '/api/conversations', ({ user }) => {
  let n = 0; for (const [id, c] of Object.entries(db.conversations)) if (c.userId === user.id) { delete db.conversations[id]; n++; }
  save(); return { deleted: n };
});
route('PATCH', '/api/conversations/:cid/messages/:mid', async ({ req, params, user }) => {
  const c = mine(params.cid, user); const m = c.messages.find((x) => x.id === params.mid);
  if (!m) throw new HttpError(404, 'Pesan tidak ditemukan.');
  const b = await H.readJson(req); m.like = b.like === 1 ? 1 : b.like === -1 ? -1 : 0; save(); return { ok: true };
});

/* ───────────── file ───────────── */
route('POST', '/api/files', async ({ req, user }) => {
  const b = await H.readJson(req, Math.ceil(cfg.MAX_FILE_MB * 1.4 * 1048576) + 8192);
  return { file: files.publicFile(files.saveUpload(user, b)) };
});
route('DELETE', '/api/files/:id', ({ params, user }) => {
  const f = db.files[params.id];
  if (!f || f.userId !== user.id) throw new HttpError(404, 'File tidak ditemukan.');
  files.removeFile(f); return { ok: true };
});

/* ───────────── statistik ───────────── */
route('GET', '/api/stats', ({ user }) => computeStats(user, usedToday(user)));

/* ───────────── CHAT (streaming SSE) ───────────── */
route('POST', '/api/chat', async ({ req, res, user }) => {
  if (db.maintenance && db.maintenance.enabled && user.role !== 'admin') {
    const msg = db.maintenance.message || 'Server sedang dalam pemeliharaan (maintenance).';
    throw new HttpError(503, 'Server Maintenance: ' + msg);
  }
  if (!limit(`chat:${user.id}`, 20, 60000)) throw new HttpError(429, 'Terlalu cepat. Tunggu sebentar sebelum mengirim lagi.');
  const b = await H.readJson(req, 256 * 1024);
  const s = settingsOf(user);
  const model = models.get(b.model || s.defaultModel);
  if (!model) throw new HttpError(400, 'Model tidak dikenal.');
  const effectiveKey = (s && s.apiKey) || cfg.ONTOKEN_API_KEY;
  if (!effectiveKey) throw new HttpError(503, 'Server belum dikonfigurasi: ONTOKEN_API_KEY kosong di file .env.');

  const regenerate = b.regenerate === true;
  const text = String(b.text || '').trim();
  const fileIds = Array.isArray(b.fileIds) ? [...new Set(b.fileIds.map(String))].slice(0, 5) : [];
  if (!regenerate && !text && !fileIds.length) throw new HttpError(400, 'Pesan kosong.');
  if (text.length > 20000) throw new HttpError(400, 'Pesan terlalu panjang (maksimal 20.000 karakter).');

  let conv = b.conversationId ? mine(String(b.conversationId), user) : null;
  if (regenerate && !conv) throw new HttpError(400, 'Percakapan tidak ditemukan.');
  const attach = fileIds.map((id) => db.files[id]).filter((f) => f && f.userId === user.id);
  if (attach.length !== fileIds.length) throw new HttpError(400, 'Sebagian file lampiran tidak ditemukan. Unggah ulang.');

  // Validasi dulu pada salinan, supaya percakapan tidak berubah bila permintaan ditolak.
  let base = conv ? conv.messages.slice() : [];
  if (conv && b.truncateFrom) { const i = base.findIndex((m) => m.id === b.truncateFrom); if (i >= 0) base = base.slice(0, i); }
  if (regenerate) {
    if (base.length && base[base.length - 1].role === 'assistant') base.pop();
    if (!base.length || base[base.length - 1].role !== 'user') throw new HttpError(400, 'Tidak ada pesan pengguna untuk dijawab ulang.');
  }
  const imagesInPlay = (regenerate ? base[base.length - 1].files || [] : attach).some(isImg);
  if (imagesInPlay && !model.vision) throw new HttpError(400, `${model.name} tidak bisa membaca gambar. Pilih model Claude, atau hapus gambar dari pesan.`);
  if (usedToday(user) >= cfg.FREE_DAILY_MESSAGES) throw new HttpError(429, `Batas ${cfg.FREE_DAILY_MESSAGES} pesan per hari sudah tercapai. Coba lagi besok.`);

  // Semua validasi lolos → ubah data.
  const now = Date.now(), isNew = !conv;
  if (isNew) { conv = { id: uid(), userId: user.id, title: makeTitle(text, attach), model: model.id, pinned: false, archived: false, createdAt: now, updatedAt: now, messages: [] }; db.conversations[conv.id] = conv; }
  else conv.messages = base;
  let userMsg = null;
  if (!regenerate) {
    userMsg = { id: uid(), role: 'user', content: text, files: attach.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size })), createdAt: now, tokens: est(text) };
    conv.messages.push(userMsg);
  }
  conv.model = model.id; conv.updatedAt = now; user.usage.count++; save();

  // Mulai stream ke browser.
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (o) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(o)}\n\n`); };
  const ai = { id: uid(), role: 'assistant', content: '', model: model.id, createdAt: Date.now() };
  send({ type: 'meta', conversationId: conv.id, isNew, title: conv.title, userMessageId: userMsg && userMsg.id, assistantMessageId: ai.id });

  const ctrl = new AbortController();
  let clientGone = false;
  res.on('close', () => { if (!res.writableEnded) { clientGone = true; ctrl.abort(); } });
  const timer = setTimeout(() => ctrl.abort(), cfg.REQUEST_TIMEOUT_S * 1000);
  const ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 15000);

  const upstream = buildMessages({ user, settings: s, conv, model });
  const inChars = upstream.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : m.content.reduce((k, p) => k + (p.text ? p.text.length : 0), 0)), 0);
  let usage = null, error = null;
  try {
    const r = await streamChat({ model: model.id, messages: upstream, temperature: s.temperature, apiKey: effectiveKey, signal: ctrl.signal, onDelta: (t) => { ai.content += t; send({ type: 'delta', t }); } });
    usage = r.usage;
  } catch (e) {
    if (!clientGone) {
      error = e instanceof UpstreamError ? e.message : ctrl.signal.aborted ? 'Waktu tunggu habis. Coba lagi.' : 'Terjadi kesalahan saat menghubungi AI. Coba lagi.';
      if (!(e instanceof UpstreamError) && !ctrl.signal.aborted) console.error('[chat]', e);
    }
  } finally { clearTimeout(timer); clearInterval(ping); }

  if (ai.content) {
    const fallback = Math.ceil(inChars / 4) + est(ai.content);
    ai.tokens = (usage && Number(usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0))) || fallback;
    if (clientGone || error) ai.aborted = true;
    conv.messages.push(ai); conv.updatedAt = Date.now(); save();
  }
  if (error) send({ type: 'error', message: error, partial: !!ai.content });
  send({ type: 'done', assistantMessageId: ai.content ? ai.id : null, tokens: ai.tokens || 0 });
  if (!res.writableEnded) res.end();
});

/* ───────────── server ─────────────
   requestHandler diekspor terpisah agar bisa dipakai baik oleh http.createServer
   (hosting Node biasa) maupun oleh fungsi serverless Vercel (lihat api/index.js). */

function getApiPathname(req, url) {
  const querySub = url.searchParams.get('_api_path') || url.searchParams.get('0');
  if (querySub) return '/api/' + querySub.replace(/^\/+/, '');

  const routeMatches = req.headers['x-now-route-matches'];
  if (routeMatches) {
    const m = routeMatches.match(/(?:1|_api_path|0)=([^&]+)/);
    if (m && m[1]) return '/api/' + decodeURIComponent(m[1]).replace(/^\/+/, '');
  }

  for (const h of ['x-invoke-path', 'x-forwarded-uri', 'x-original-url']) {
    const v = req.headers[h];
    if (v && v.startsWith('/api/') && !v.startsWith('/api/index')) return v.split('?')[0];
  }

  const matched = req.headers['x-matched-path'];
  if (matched && matched.startsWith('/api/') && !matched.startsWith('/api/index')) return matched.split('?')[0];

  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/index')) return url.pathname;

  const rawPath = (req.url || '').split('?')[0];
  if (rawPath.startsWith('/api/') && !rawPath.startsWith('/api/index')) return rawPath;

  return url.pathname;
}

async function requestHandler(req, res) {
  H.secureHeaders(res);
  try {
    if (typeof dbMod.loadDb === 'function') {
      try { await dbMod.loadDb(); } catch (e) { console.error('[server] loadDb error:', e.message); }
    }
    let url; try { url = new URL(req.url, "http://localhost"); } catch { throw new HttpError(400, "URL tidak valid."); }
    const apiPath = getApiPathname(req, url);
    if (apiPath.startsWith("/api/") && !apiPath.startsWith("/api/index")) {
      return await handleApi(req, res, url, apiPath);
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Metode tidak diizinkan.");
    if (H.serveStatic(req, res, url.pathname)) return;
    if (url.pathname === "/") { if (H.serveStatic(req, res, "/index.html")) return; }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("404 — Halaman tidak ditemukan");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("[server]", e);
    if (res.headersSent) { try { res.end(); } catch {} return; }
    if (status === 413) res.setHeader("Connection", "close");
    H.json(res, status, { error: status === 500 ? "Terjadi kesalahan di server." : e.message });
  } finally {
    if (typeof dbMod.flushIfDirty === 'function') {
      try { await dbMod.flushIfDirty(); } catch (e) { console.error('[server] flushIfDirty error:', e.message); }
    }
  }
}

const server = http.createServer(requestHandler);

function start(port = cfg.PORT, host = cfg.HOST) { return new Promise((resolve) => server.listen(port, host, () => resolve(server))); }

if (require.main === module) {
  start().then(() => {
    const k = cfg.ONTOKEN_API_KEY;
    console.log(`\n  Nova AI berjalan di  http://localhost:${cfg.PORT}`);
    console.log(`  ON Token            ${k ? `API key terpasang (…${k.slice(-4)})` : 'API KEY BELUM DIISI — salin .env.example menjadi .env lalu isi ONTOKEN_API_KEY'}`);
    console.log(`  Model               ${models.list.map((m) => m.id).join(', ')}\n`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('\nMenutup server…'); flush(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}
module.exports = requestHandler;
module.exports.requestHandler = requestHandler;
module.exports.server = server;
module.exports.start = start;
module.exports.flush = flush;
