'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FALLBACK = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', badge: 'Direkomendasikan', icon: 'spark', vision: true, desc: 'Seimbang: kualitas tinggi dengan kecepatan baik.' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', badge: 'Mendalam', icon: 'layers', vision: true, desc: 'Penalaran mendalam untuk analisis dan coding kompleks.' },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', badge: 'Cepat', icon: 'bolt', vision: false, desc: 'Sangat cepat dan hemat untuk tugas harian (teks saja).' }
];

function load() {
  if (process.env.MODELS_FILE) {
    try {
      const f = path.resolve(cfg.ROOT, process.env.MODELS_FILE);
      if (fs.existsSync(f)) {
        const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Array.isArray(arr) && arr.length) return arr;
      }
    } catch {}
  }
  try {
    return require('../models.json');
  } catch {
    return FALLBACK;
  }
}

const raw = load();
const list = (Array.isArray(raw) ? raw : []).filter((m) => m && m.id).map((m) => ({
  id: String(m.id),
  name: String(m.name || m.id),
  desc: String(m.desc || ''),
  badge: String(m.badge || ''),
  icon: String(m.icon || 'spark'),
  vision: !!m.vision,
}));

module.exports = {
  list: list.length ? list : FALLBACK,
  get: (id) => list.find((m) => m.id === id) || (process.env.MODELS_FILE ? load().find((m) => m.id === id) : null),
  defaultId: list.some((m) => m.id === cfg.DEFAULT_MODEL) ? cfg.DEFAULT_MODEL : (list[0] || FALLBACK[0]).id,
};
