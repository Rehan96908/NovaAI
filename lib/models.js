'use strict';
// Daftar model yang tampil di pilihan model. Ubah lewat models.json (tanpa mengubah kode).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FALLBACK = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', badge: 'Direkomendasikan', icon: 'spark', vision: true, desc: 'Seimbang: kualitas tinggi dengan kecepatan baik.' },
];
function load() {
  const f = process.env.MODELS_FILE ? path.resolve(cfg.ROOT, process.env.MODELS_FILE) : path.join(cfg.ROOT, 'models.json');
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    const list = (Array.isArray(arr) ? arr : []).filter((m) => m && m.id).map((m) => ({
      id: String(m.id), name: String(m.name || m.id), desc: String(m.desc || ''), badge: String(m.badge || ''),
      icon: String(m.icon || 'spark'), vision: !!m.vision,
    }));
    if (list.length) return list;
  } catch (e) { console.warn('[models] models.json tidak terbaca, memakai bawaan:', e.message); }
  return FALLBACK;
}
const list = load();
module.exports = {
  list,
  get: (id) => list.find((m) => m.id === id),
  defaultId: list.some((m) => m.id === cfg.DEFAULT_MODEL) ? cfg.DEFAULT_MODEL : list[0].id,
};
