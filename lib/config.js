'use strict';
// Membaca file .env (tanpa library tambahan) + nilai default.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile(process.env.ENV_FILE || path.join(ROOT, '.env'));

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

// Vercel (dan platform serverless sejenis) memakai filesystem hanya-baca, kecuali
// /tmp yang tidak permanen. Deteksi ini dipakai untuk menghindari penulisan disk
// yang pasti gagal di sana (data/db.json, data/.jwt_secret, lampiran).
const ON_SERVERLESS_RO_FS = !!process.env.VERCEL;
const HAS_POSTGRES = !!(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL);

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
if (!ON_SERVERLESS_RO_FS) {
  try { fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true }); }
  catch (e) { console.warn('[config] tidak bisa membuat folder data (lanjut tanpa penyimpanan disk):', e.message); }
}

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 32) return s;
  if (ON_SERVERLESS_RO_FS) {
    throw new Error('JWT_SECRET belum diisi. Di Vercel, disk tidak permanen sehingga secret tidak bisa dibuat otomatis — isi JWT_SECRET (minimal 32 karakter acak) di Environment Variables Vercel. Buat nilainya dengan: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  }
  const f = path.join(DATA_DIR, '.jwt_secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const gen = crypto.randomBytes(48).toString('base64url');
  try { fs.writeFileSync(f, gen, { mode: 0o600 }); } catch { /* filesystem tidak bisa ditulis; tetap pakai nilai di memori */ }
  console.warn('[config] JWT_SECRET belum diisi — dibuat otomatis di data/.jwt_secret. Untuk produksi, isi JWT_SECRET di .env.');
  return gen;
}

let apiKey = (process.env.ONTOKEN_API_KEY || '').trim();
if (/ISI_KEY/i.test(apiKey)) apiKey = ''; // placeholder dari .env.example dianggap belum diisi

// Vercel membatasi body permintaan ±4.5 MB; file dikirim sebagai base64 (+±37%)
// di dalam JSON, jadi defaultnya diturunkan otomatis saat backend Postgres aktif.
// Tetap bisa ditimpa manual lewat MAX_FILE_MB di Environment Variables.
const defaultMaxFileMB = HAS_POSTGRES ? 3 : 5;

module.exports = {
  ROOT, DATA_DIR, ON_SERVERLESS_RO_FS, HAS_POSTGRES,
  PORT: num(process.env.PORT, 3000),
  HOST: process.env.HOST || '0.0.0.0',
  TRUST_PROXY: bool(process.env.TRUST_PROXY, ON_SERVERLESS_RO_FS),
  ONTOKEN_API_KEY: apiKey,
  ONTOKEN_BASE_URL: (process.env.ONTOKEN_BASE_URL || 'https://api.ontoken.id/v1').replace(/\/+$/, ''),
  JWT_SECRET: jwtSecret(),
  SESSION_DAYS: num(process.env.SESSION_DAYS, 7),
  ALLOW_REGISTRATION: bool(process.env.ALLOW_REGISTRATION, true),
  REGISTER_PER_HOUR: num(process.env.REGISTER_PER_HOUR, 5),
  FREE_DAILY_MESSAGES: num(process.env.FREE_DAILY_MESSAGES, 50),
  MAX_FILE_MB: num(process.env.MAX_FILE_MB, defaultMaxFileMB),
  STORAGE_LIMIT_MB: num(process.env.STORAGE_LIMIT_MB, 100),
  MAX_OUTPUT_TOKENS: num(process.env.MAX_OUTPUT_TOKENS, 4096),
  REQUEST_TIMEOUT_S: num(process.env.REQUEST_TIMEOUT_S, ON_SERVERLESS_RO_FS ? 280 : 180),
  DEFAULT_MODEL: process.env.DEFAULT_MODEL || 'claude-sonnet-5',
};
