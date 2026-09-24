'use strict';
// Titik masuk untuk Vercel. Semua permintaan ke /api/* berakhir di sini (lihat
// vercel.json). File ini SENGAJA dibuat setipis mungkin — semua logika rute yang
// sesungguhnya ada di ../server.js dan ../lib/*, persis sama dengan yang dipakai
// saat menjalankan `npm start` secara biasa di komputer/VPS.
//
// Yang berbeda dari server.js hanyalah: sebelum menangani permintaan, kita muat
// dulu seluruh data aplikasi dari Postgres ke memori (loadDb), dan setelah selesai,
// kita simpan lagi bila ada perubahan (flushIfDirty). Ini perlu karena fungsi
// serverless tidak punya memori maupun disk yang bertahan antar permintaan.
//
// SYARAT AGAR INI BEKERJA:
//  1) Tambahkan Storage → Postgres di dashboard proyek Vercel-mu (gratis untuk
//     pemakaian kecil). Vercel otomatis mengisi POSTGRES_URL.
//  2) Isi ONTOKEN_API_KEY dan JWT_SECRET di Project Settings → Environment Variables.
// Lihat DEPLOY.md untuk langkah lengkap.
if (!process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL && !process.env.DATABASE_URL) {
  module.exports = (req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: 'POSTGRES_URL belum diisi. Tambahkan Storage → Postgres di dashboard proyek Vercel-mu, lalu redeploy. Lihat DEPLOY.md.',
    }));
  };
} else {
  const { requestHandler } = require('../server');
  const { loadDb, flushIfDirty } = require('../lib/db');

  module.exports = async (req, res) => {
    try { await loadDb(); }
    catch (e) {
      console.error('[api] gagal memuat data dari Postgres:', e.message);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'Tidak bisa terhubung ke database. Coba lagi sesaat lagi.' }));
    }
    try { await requestHandler(req, res); }
    finally {
      try { await flushIfDirty(); }
      catch (e) { console.error('[api] gagal menyimpan data ke Postgres:', e.message); }
    }
  };
}
