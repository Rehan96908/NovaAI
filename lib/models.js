'use strict';
const cfg = require('./config');

const FALLBACK = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', badge: 'Direkomendasikan', icon: 'spark', vision: true, desc: 'Seimbang: kualitas tinggi dengan kecepatan baik.' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', badge: 'Mendalam', icon: 'layers', vision: true, desc: 'Penalaran mendalam untuk analisis dan coding kompleks.' },
  { id: 'deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', badge: 'Cepat', icon: 'bolt', vision: false, desc: 'Sangat cepat dan hemat untuk tugas harian (teks saja).' }
];

let raw;
try {
  raw = require('../models.json');
} catch (e) {
  raw = FALLBACK;
}

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
  get: (id) => list.find((m) => m.id === id) || FALLBACK.find((m) => m.id === id),
  defaultId: list.some((m) => m.id === cfg.DEFAULT_MODEL) ? cfg.DEFAULT_MODEL : (list[0] || FALLBACK[0]).id,
};
