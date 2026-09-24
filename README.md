# Nova AI

Website chat AI (frontend + backend) yang memakai [ON Token](https://app.ontoken.id)
sebagai penyedia model (Claude Sonnet 5, Claude Opus 5, DeepSeek V4 Flash). API key
ON Token hanya pernah dibaca oleh server (file `.env`), tidak pernah dikirim ke
browser — semua permintaan ke AI lewat backend ini dulu.

**Mulai cepat:** lihat [DEPLOY.md](./DEPLOY.md) untuk cara menjalankan di komputer
sendiri/VPS, atau men-deploy ke Vercel.

## Struktur proyek

```
public/            Frontend (HTML/CSS/JS polos, tanpa build step, tanpa framework)
server.js          Semua rute API (auth, chat, riwayat, file, pengaturan, statistik)
lib/               Modul backend: config, autentikasi, klien ON Token, dll.
api/index.js       Titik masuk khusus Vercel (lihat DEPLOY.md)
test/              Pengujian otomatis (lihat di bawah)
scripts/check-api.js  Uji koneksi ke ON Token memakai key di .env: `npm run check`
```

## Bagaimana data disimpan

`lib/db.js` memilih otomatis:
- **Tidak ada `POSTGRES_URL`** → file JSON lokal (`data/db.json`). Dipakai saat
  `npm start` biasa di komputer/VPS.
- **Ada `POSTGRES_URL`** → Postgres (satu dokumen JSON per aplikasi). Aktif otomatis
  di Vercel setelah kamu menambahkan Storage → Postgres. Penjelasan desain dan
  keterbatasannya ada di komentar atas `lib/db.pg.js` — baca itu sebelum mengubahnya.

Kedua mode memakai kode rute yang **sama persis** (`server.js`, `lib/*`) — hanya
lapisan penyimpanan yang berbeda.

## Keamanan yang sudah diterapkan

- Kata sandi di-hash dengan scrypt (bukan disimpan polos).
- Sesi login memakai cookie httpOnly + JWT bertanda tangan (HMAC-SHA256), bukan
  disimpan di localStorage.
- Perlindungan CSRF dasar (pengecekan header Origin) untuk permintaan pengubah data.
- Rate limit untuk percobaan login, pendaftaran, dan pengiriman chat.
- Content-Security-Policy ketat (tanpa `unsafe-eval`, tanpa domain skrip asing).
- API key ON Token tidak pernah dikirim ke browser, termasuk di dalam pesan error.

## Pengujian otomatis

```bash
npm test
```

Menjalankan **37 pengujian otomatis** (Node's built-in test runner, tanpa
dependensi tambahan), semuanya memakai server ON Token **tiruan** lokal
(`test/mock-upstream.js`) — jadi tidak memakai kuota/saldo ON Token sungguhan dan
bisa dijalankan tanpa internet:

- `test/api.test.js` (23 tes) — seluruh alur rute dalam mode file: registrasi,
  login, sesi, CSRF, rate limit, kirim chat + streaming, regenerate, edit pesan,
  lampiran gambar/teks, validasi vision-only, kuota harian, error dari upstream,
  CRUD percakapan, pengaturan, ekspor & hapus akun.
- `test/db-pg.test.js` (9 tes) — lapisan penyimpanan Postgres saja: load/save/flush,
  pembuatan tabel otomatis, data bertahan lintas "cold start" simulasi, retry saat
  galat koneksi. Memakai driver `pg` **tiruan** (bukan Postgres sungguhan).
- `test/vercel-integration.test.js` (5 tes) — pola persis `api/index.js`
  (loadDb → tangani permintaan → flush) dijalankan dengan rute yang sungguhan
  (bukan disederhanakan), membuktikan data benar-benar bertahan lintas permintaan
  HTTP terpisah saat backend Postgres aktif.

Selain itu, sebelum proyek ini diserahkan, seluruh alur juga sudah diuji langsung
di browser sungguhan (bukan hanya lewat kode): registrasi, login, chat streaming,
ganti model, upload gambar & teks, tolak gambar ke model non-vision, edit/regenerate
pesan, tombol Stop, riwayat (cari/ganti nama/sematkan/arsipkan/hapus), pengaturan
(profil/avatar/tema/model default/kata sandi), harga, dashboard (statistik & grafik
dari data asli), hapus akun, serta tampilan mobile — di desktop maupun mobile viewport.

### Yang **tidak** bisa diuji dari lingkungan pengembangan ini

Lingkungan tempat proyek ini ditulis tidak punya akses internet ke `api.ontoken.id`
maupun ke Vercel/Postgres sungguhan (dibatasi oleh sandbox). Karena itu:
- Jalankan `npm run check` setelah mengisi `ONTOKEN_API_KEY` di `.env` untuk
  memastikan API key dan ketiga model benar-benar tersambung ke ON Token asli.
- Setelah deploy ke Vercel, lakukan satu kali uji coba manual (daftar akun, kirim
  pesan) untuk memastikan koneksi ke Postgres sungguhan bekerja seperti yang
  divalidasi lewat tiruan di atas.

## Mengganti/menambah model

Edit `models.json` — tidak perlu mengubah kode. Field `vision: true` menandai model
yang bisa membaca gambar.
