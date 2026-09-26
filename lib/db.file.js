'use strict';
// Backend penyimpanan #1: file JSON lokal (data/db.json).
// Dipakai saat POSTGRES_URL tidak diisi — cocok untuk menjalankan di laptop, VPS, Railway, Render, dll.
// Penyimpanan sederhana berbasis file JSON (data/db.json) dengan penulisan atomik.
// Cukup untuk ratusan pengguna. Untuk skala besar, ganti modul ini dengan PostgreSQL/SQLite.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'db.json');
const db = { users: {}, conversations: {}, files: {} };
try {
  if (fs.existsSync(FILE)) Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));
} catch (e) {
  fs.copyFileSync(FILE, FILE + '.rusak-' + Date.now());
  console.error('[db] db.json rusak — dicadangkan dan dimulai dari kosong.');
}

let timer = null;
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
function save() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; try { flush(); } catch (e) { console.error('[db] gagal menyimpan:', e.message); } }, 300);
}
const uid = () => crypto.randomBytes(9).toString('base64url');

// Untuk keseragaman antarmuka dengan backend Postgres (lib/db.pg.js):
// loadDb tidak melakukan apa pun (data sudah dibaca saat modul dimuat),
// flushIfDirty langsung menulis bila ada perubahan tertunda.
async function loadDb() {
  try {
    if (fs.existsSync(FILE)) {
      const fresh = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      for (const k of Object.keys(db)) delete db[k];
      Object.assign(db, { users: {}, conversations: {}, files: {}, ...fresh });
    }
  } catch (e) {
    console.error('[db.file] gagal memuat db.json:', e.message);
  }
}
async function flushIfDirty() { if (timer) flush(); }
const mode = 'file';
const filesUseDisk = true;

module.exports = { db, save, flush, uid, loadDb, flushIfDirty, mode, filesUseDisk };
