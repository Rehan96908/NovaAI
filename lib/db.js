'use strict';
// Titik masuk penyimpanan data. Memilih backend secara otomatis:
//   - Ada POSTGRES_URL / POSTGRES_PRISMA_URL / DATABASE_URL → lib/db.pg.js (Postgres,
//     dipakai di Vercel setelah kamu menambahkan Storage → Postgres).
//   - Tidak ada → lib/db.file.js (file JSON lokal di data/db.json, dipakai saat
//     menjalankan di laptop, VPS, Railway, Render, dll).
// Semua pemanggil (server.js, lib/files.js, lib/prompt.js, lib/stats.js) cukup
// `require('./db')` dan memakai `db`, `save`, `uid` seperti biasa — mereka tidak
// perlu tahu backend mana yang sedang aktif.
const hasPostgres = !!(process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL);
module.exports = require(hasPostgres ? './db.pg' : './db.file');
