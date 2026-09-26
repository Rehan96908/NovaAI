'use strict';
// Backend penyimpanan #2: Postgres (satu baris JSONB berisi seluruh data aplikasi).
// Dipakai otomatis saat POSTGRES_URL (atau DATABASE_URL) terisi — ini kondisi yang
// biasanya benar di Vercel setelah kamu menambahkan Storage → Postgres di dashboard,
// karena Vercel mengisi variabel itu sendiri.
//
// KENAPA DESAINNYA SEPERTI INI (baca ini sebelum mengubah):
// Vercel adalah platform serverless: setiap permintaan bisa dilayani oleh proses baru
// tanpa disk permanen, jadi pendekatan "file JSON di disk" (lib/db.file.js) tidak bisa
// dipakai. Solusinya di sini: seluruh state aplikasi (users, conversations, files)
// diperlakukan sebagai SATU dokumen JSON, dimuat dari Postgres di awal setiap
// permintaan (loadDb) dan ditulis kembali di akhir bila ada perubahan (flushIfDirty).
// Ini membuat lib/db.js, server.js, dan seluruh route TIDAK PERLU tahu bahwa ia
// sedang bicara ke Postgres — mereka tetap mengakses `db.users[id]` dkk secara
// sinkron seperti biasa, sama persis dengan mode file.
//
// KETERBATASAN YANG PERLU KAMU TAHU (jujur, bukan disembunyikan):
// 1) Konkurensi: bila dua permintaan berjalan bersamaan dan sama-sama mengubah data,
//    yang menyimpan belakangan akan menimpa yang pertama (khas pola "load-modify-save"
//    satu dokumen). Untuk pemakaian pribadi/tim kecil ini jarang jadi masalah nyata.
//    Untuk skala banyak pengguna sekaligus, migrasikan ke skema tabel per-baris.
// 2) Ukuran: seluruh data (termasuk lampiran, disimpan sebagai base64) ada dalam satu
//    dokumen yang dimuat penuh tiap permintaan. Wajar untuk pemakaian pribadi; kalau
//    datamu sudah besar (banyak pengguna/lampiran), pertimbangkan migrasi skema.
// 3) Lampiran disimpan sebagai base64 di dalam dokumen ini (bukan di disk, karena
//    Vercel tidak punya disk permanen), jadi otomatis ikut batasan ukuran permintaan
//    Vercel (±4,5 MB per request). server.js sudah menurunkan default MAX_FILE_MB
//    saat mode ini aktif — lihat lib/config.js.
const crypto = require('crypto');

let Pool;
try { ({ Pool } = require('pg')); }
catch {
  throw new Error('Paket "pg" belum terpasang. Ini seharusnya terpasang otomatis lewat "npm install" (sudah ada di package.json). Jika muncul saat menjalankan secara lokal, jalankan: npm install');
}

const CONN = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL;
const pool = new Pool({ connectionString: CONN, ssl: /localhost|127\.0\.0\.1/.test(CONN || '') ? false : { rejectUnauthorized: false } });
pool.on('error', (e) => console.error('[db.pg] galat koneksi tak terduga:', e.message));

const TABLE = process.env.POSTGRES_TABLE || 'nova_state';
let tableReady = null;
async function ensureTable() {
  if (!tableReady) {
    tableReady = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS "${TABLE}" (
           id INT PRIMARY KEY,
           data JSONB NOT NULL DEFAULT '{}'::jsonb,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
      await pool.query(
        `INSERT INTO "${TABLE}" (id, data, updated_at)
         VALUES (1, '{}'::jsonb, now())
         ON CONFLICT (id) DO NOTHING`
      );
    })().catch((e) => {
      tableReady = null;
      console.error('[db.pg] ensureTable error:', e.message);
      throw e;
    });
  }
  return tableReady;
}

const db = { users: {}, conversations: {}, files: {} };
let dirty = false;
let loaded = false;

async function loadDb() {
  await ensureTable();
  const { rows } = await pool.query(`SELECT data FROM "${TABLE}" WHERE id = 1`);
  const fresh = rows[0] ? rows[0].data : {};
  // Ganti isi in-place (bukan reassign) supaya semua modul lain yang sudah
  // melakukan `const { db } = require('./db')` tetap merujuk objek yang sama.
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, { users: {}, conversations: {}, files: {}, ...fresh });
  dirty = false; loaded = true;
}
function save() { dirty = true; } // dipanggil sinkron oleh route seperti pada mode file
async function flushIfDirty() {
  if (!dirty) return;
  dirty = false;
  await ensureTable();
  await pool.query(
    `INSERT INTO "${TABLE}" (id, data, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [JSON.stringify(db)]
  );
}
async function flush() { dirty = true; await flushIfDirty(); } // untuk kompatibilitas pemanggilan manual/tes

const uid = () => crypto.randomBytes(9).toString('base64url');
const mode = 'postgres';
const filesUseDisk = false; // lib/files.js menyimpan base64 langsung di dalam dokumen, bukan di disk

module.exports = { db, save, flush, uid, loadDb, flushIfDirty, mode, filesUseDisk, get isLoaded() { return loaded; }, _pool: pool };
