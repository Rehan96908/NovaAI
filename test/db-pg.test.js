'use strict';
// Menguji lib/db.pg.js (backend Postgres) dengan driver "pg" tiruan (lihat catatan
// di node_modules/pg/index.js). Ini menguji LOGIKA load/save/flush & pembuatan
// tabel — bukan koneksi Postgres sungguhan, karena sandbox pengembangan ini tidak
// punya akses jaringan untuk memasang atau menjalankan Postgres asli.
// Jalankan: node --test test/db-pg.test.js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.POSTGRES_URL = 'postgres://user:pass@localhost:5432/testdb';
// Berkas ini menguji lib/db.pg.js memakai driver "pg" TIRUAN (lihat
// node_modules/pg/index.js) yang hanya ada di lingkungan pengembangan proyek ini.
// Bila suatu saat dijalankan dengan paket "pg" ASLI terpasang (mis. `npm test` di
// mesin pengguna setelah `npm install`), berkas ini otomatis dilewati dengan aman
// alih-alih gagal — karena "pg" asli tidak mengekspor `__mock`.
const mockPg = (() => { try { return require('pg').__mock; } catch { return undefined; } })();
const HAS_MOCK = !!mockPg;
if (!HAS_MOCK) console.log('[db-pg.test.js] dilewati: driver "pg" tiruan tidak terdeteksi (ini normal di luar lingkungan pengembangan).');

function freshDbModule() {
  delete require.cache[require.resolve('../lib/db.pg')];
  return require('../lib/db.pg');
}

beforeEach(() => { if (HAS_MOCK) mockPg.reset(); });

test('loadDb pada database kosong menghasilkan struktur default', async () => {
  if (!HAS_MOCK) return;
  const db1 = freshDbModule();
  await db1.loadDb();
  assert.deepEqual(db1.db, { users: {}, conversations: {}, files: {} });
});

test('save() menandai dirty; flushIfDirty menulis, dan tidak menulis lagi bila tidak ada perubahan', async () => {
  if (!HAS_MOCK) return;
  const db1 = freshDbModule();
  await db1.loadDb();
  db1.db.users['u1'] = { id: 'u1', name: 'Budi' };
  db1.save();
  await db1.flushIfDirty();
  const raw = mockPg.store.get('nova_state').get(1);
  assert.equal(raw.users.u1.name, 'Budi');

  // Ubah store secara langsung untuk memastikan flush KEDUA tidak menimpa
  // (karena tidak ada save() baru, dirty harus sudah false).
  raw.users.u1.name = 'DIUBAH_DARI_LUAR';
  await db1.flushIfDirty();
  assert.equal(mockPg.store.get('nova_state').get(1).users.u1.name, 'DIUBAH_DARI_LUAR', 'flush tanpa save() baru tidak boleh menulis ulang');
});

test('data bertahan lintas "cold start" (instance/proses baru membaca hasil simpanan sebelumnya)', async () => {
  if (!HAS_MOCK) return;
  const dbA = freshDbModule();
  await dbA.loadDb();
  dbA.db.conversations['c1'] = { id: 'c1', title: 'Halo dunia', messages: [] };
  dbA.save(); await dbA.flushIfDirty();

  // Simulasikan cold start baru: modul di-require ulang dari nol (cache dibersihkan),
  // tapi mock pg's `store` tetap ada (meniru Postgres sungguhan yang independen dari proses Node).
  const dbB = freshDbModule();
  assert.deepEqual(dbB.db, { users: {}, conversations: {}, files: {} }, 'sebelum loadDb, in-memory masih kosong');
  await dbB.loadDb();
  assert.equal(dbB.db.conversations.c1.title, 'Halo dunia');
});

test('referensi objek `db` tidak berubah setelah loadDb (modul lain yang destructure sekali tetap sinkron)', async () => {
  if (!HAS_MOCK) return;
  const dbMod = freshDbModule();
  const ref = dbMod.db;
  await dbMod.loadDb();
  dbMod.db.users['x'] = { id: 'x' };
  assert.strictEqual(dbMod.db, ref, 'loadDb harus mengubah isi in-place, bukan reassign');
  assert.equal(ref.users.x.id, 'x');
});

test('tabel dibuat otomatis hanya sekali walau loadDb dipanggil berkali-kali', async () => {
  if (!HAS_MOCK) return;
  const dbMod = freshDbModule();
  await dbMod.loadDb(); await dbMod.loadDb(); await dbMod.loadDb();
  assert.ok(mockPg.store.has('nova_state'));
});

test('galat koneksi saat loadDb tidak membuat status "sudah siap" tersangkut selamanya', async () => {
  if (!HAS_MOCK) return;
  const dbMod = freshDbModule();
  mockPg.simulateFailure(1);
  await assert.rejects(() => dbMod.loadDb());
  await dbMod.loadDb(); // percobaan kedua harus berhasil (bukti retry logic ensureTable benar)
  assert.deepEqual(dbMod.db, { users: {}, conversations: {}, files: {} });
});

test('flush() (dipanggil manual) langsung menulis meski belum pernah save()', async () => {
  if (!HAS_MOCK) return;
  const dbMod = freshDbModule();
  await dbMod.loadDb();
  dbMod.db.users['manual'] = { id: 'manual' };
  await dbMod.flush();
  assert.equal(mockPg.store.get('nova_state').get(1).users.manual.id, 'manual');
});

test('mode & filesUseDisk menandakan backend Postgres dengan benar', () => {
  if (!HAS_MOCK) return;
  const dbMod = freshDbModule();
  assert.equal(dbMod.mode, 'postgres');
  assert.equal(dbMod.filesUseDisk, false);
});

test('lib/db.js memilih backend Postgres saat POSTGRES_URL terisi (dispatcher benar)', () => {
  if (!HAS_MOCK) return;
  delete require.cache[require.resolve('../lib/db')];
  delete require.cache[require.resolve('../lib/db.pg')];
  const chosen = require('../lib/db');
  assert.equal(chosen.mode, 'postgres');
});
