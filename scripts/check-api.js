'use strict';
// Menguji koneksi ke ON Token memakai key di .env:  npm run check
const cfg = require('../lib/config');
const models = require('../lib/models');
const { streamChat, listModels } = require('../lib/ontoken');

(async () => {
  console.log('Base URL :', cfg.ONTOKEN_BASE_URL);
  console.log('API key  :', cfg.ONTOKEN_API_KEY ? `terpasang (…${cfg.ONTOKEN_API_KEY.slice(-4)})` : 'BELUM diisi di .env');
  if (!cfg.ONTOKEN_API_KEY) process.exit(1);

  let ids = [];
  try { ids = await listModels(AbortSignal.timeout(30000)); console.log(`Daftar model: ${ids.length} model tersedia di akunmu`); }
  catch (e) { console.log('Daftar model gagal:', e.message); }

  let gagal = 0;
  console.log('\nTes tiap model di models.json (jawaban singkat, hemat token):');
  for (const m of models.list) {
    if (ids.length && !ids.includes(m.id)) console.log(`  ! ${m.id} tidak ada di daftar model ON Token — periksa penulisan ID`);
    const t0 = Date.now(); let out = '';
    try {
      await streamChat({ model: m.id, messages: [{ role: 'user', content: 'Balas hanya dengan satu kata: OK' }], maxTokens: 32, signal: AbortSignal.timeout(60000), onDelta: (t) => (out += t) });
      console.log(`  ✓ ${m.id}  (${Date.now() - t0} ms)  → "${out.trim().slice(0, 40)}"`);
    } catch (e) { gagal++; console.log(`  ✗ ${m.id}  → ${e.message}`); }
  }
  console.log(gagal ? `\n${gagal} model gagal. Perbaiki lalu jalankan lagi.` : '\nSemua model OK. Kamu siap menjalankan: npm start');
  process.exit(gagal ? 1 : 0);
})();
