# Panduan Deploy — Nova AI

Ada dua cara menjalankan proyek ini. Pilih salah satu.

---

## Cara A — Komputer sendiri, VPS, Railway, Render, dll. (paling sederhana)

Cocok kalau kamu punya server yang boleh menjalankan proses Node terus-menerus dan
punya disk permanen. **Tidak perlu database tambahan** — data disimpan di file
`data/db.json`.

```bash
npm install
cp .env.example .env
# buka .env, isi ONTOKEN_API_KEY dengan API key dari app.ontoken.id

npm run check   # menguji koneksi & ketiga model ke ON Token
npm start        # jalan di http://localhost:3000
```

Untuk hosting seperti Railway/Render: hubungkan repo, set Environment Variables yang
sama seperti isi `.env` kamu (minimal `ONTOKEN_API_KEY`), start command `npm start`.
Selesai — tidak ada langkah tambahan.

---

## Cara B — Vercel (serverless)

Vercel tidak menjalankan proses yang hidup terus dan tidak punya disk permanen,
jadi versi "file JSON lokal" di Cara A **tidak bisa dipakai di Vercel apa adanya**.
Proyek ini sudah disiapkan untuk mendeteksi Vercel secara otomatis dan beralih ke
penyimpanan Postgres (lihat `lib/db.pg.js` untuk penjelasan lengkap kenapa desainnya
begitu). Kamu hanya perlu menyediakan satu database Postgres kecil — gratis untuk
pemakaian pribadi.

### Langkah-langkah

1. **Push kode ini ke GitHub** (atau GitLab/Bitbucket), lalu impor sebagai proyek baru
   di [vercel.com](https://vercel.com/new).

2. **Tambahkan database.** Di dashboard proyek Vercel: tab **Storage** → **Create
   Database** → pilih **Postgres** (atau Neon, keduanya didukung Vercel secara native)
   → hubungkan ke proyekmu. Vercel otomatis mengisi environment variable
   `POSTGRES_URL` — kamu tidak perlu mengetik apa pun untuk ini.

3. **Isi Environment Variables** (Project Settings → Environment Variables):
   | Nama | Wajib? | Isi dengan |
   |---|---|---|
   | `ONTOKEN_API_KEY` | Wajib | API key dari app.ontoken.id |
   | `JWT_SECRET` | Wajib | String acak ≥32 karakter. Buat dengan menjalankan `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` di komputermu, lalu tempel hasilnya |
   | `ALLOW_REGISTRATION` | Opsional | `false` kalau ingin menutup pendaftaran akun baru |
   | `FREE_DAILY_MESSAGES` | Opsional | Default 50 |

   (`POSTGRES_URL` sudah otomatis dari langkah 2 — jangan diisi ulang manual.)

4. **Deploy.** Vercel akan menjalankan `npm install` (memasang paket `pg` yang
   dipakai untuk bicara ke Postgres) lalu mem-build proyek secara otomatis.

5. **Uji setelah deploy selesai** — buka domain Vercel-mu, coba daftar akun dan
   kirim satu pesan chat. Ini langkah yang **tidak bisa aku uji dari sisi
   pengembangan**, karena lingkungan tempat aku menulis kode ini tidak punya akses
   internet ke Vercel maupun ke Postgres sungguhan. Semua logika sudah diuji
   otomatis secara menyeluruh (lihat bagian "Apa yang sudah diuji" di README.md)
   memakai tiruan/mock untuk keduanya — jadi kemungkinan besar akan langsung
   berjalan, tapi satu kali uji coba manual setelah deploy tetap dianjurkan.

### Yang perlu kamu ketahui soal mode Postgres ini

- **Skala:** seluruh data (akun, percakapan, file) disimpan sebagai satu dokumen
  JSON dalam satu baris tabel. Ini cocok untuk pemakaian pribadi atau tim kecil.
  Kalau nanti dipakai banyak orang sekaligus, pertimbangkan migrasi ke skema
  tabel per-baris (silakan minta bantuan lanjutan untuk ini).
- **Ukuran lampiran diturunkan otomatis jadi 3 MB** (dari 5 MB di Cara A), karena
  Vercel membatasi ukuran isi permintaan sekitar 4,5 MB per request.
- **Percobaan login/registrasi berulang** dibatasi per-proses, bukan lintas semua
  server Vercel sekaligus — cukup untuk mencegah penyalahgunaan ringan, tapi bukan
  proteksi tingkat enterprise.
- Kalau `POSTGRES_URL` lupa diisi, aplikasi akan menjawab semua permintaan `/api/*`
  dengan pesan error yang jelas (bukan crash tanpa penjelasan) yang mengarahkanmu
  kembali ke langkah 2.

### Menjalankan mode Postgres di komputar sendiri (opsional, untuk mencoba dulu)

Isi `POSTGRES_URL` di file `.env` kamu dengan connection string Postgres biasa
(bisa bikin gratis di [neon.tech](https://neon.tech) atau [supabase.com](https://supabase.com)
kalau tidak punya Postgres lokal), lalu `npm start` seperti biasa — aplikasi akan
otomatis memakai Postgres, persis seperti di Vercel.
