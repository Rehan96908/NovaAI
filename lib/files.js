'use strict';
// Upload file: gambar (dicek lewat magic bytes) dan file teks/kode.
// Mode file (lokal/VPS): disimpan di data/uploads/<user>/<id>.
// Mode Postgres (Vercel): base64 disimpan langsung di record (db.files[id].data),
// karena platform serverless tidak punya disk permanen — lihat lib/db.pg.js.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { db, save, uid, filesUseDisk } = require('./db');
const { HttpError } = require('./http');

const s4 = (b, from, to) => b.slice(from, to).toString('latin1');
const IMAGE_TYPES = [
  ['image/png', (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => s4(b, 0, 4) === 'GIF8'],
  ['image/webp', (b) => s4(b, 0, 4) === 'RIFF' && s4(b, 8, 12) === 'WEBP'],
];
const TEXT_EXT = new Set(('txt md markdown csv tsv json xml html htm css js mjs cjs ts tsx jsx py java c h cpp hpp cs go rs rb php sh bash sql yaml yml toml ini env log conf vue svelte kt swift r lua tex').split(' '));

const cleanName = (n) => String(n || 'file').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'file';
const usedBytes = (userId) => Object.values(db.files).reduce((n, f) => n + (f.userId === userId ? f.size : 0), 0);
const absPath = (rec) => path.join(cfg.DATA_DIR, rec.rel);
const publicFile = (f) => ({ id: f.id, name: f.name, type: f.type, kind: f.kind, size: f.size, createdAt: f.createdAt });
// Mengembalikan isi file sebagai Buffer, tidak peduli disimpan di disk atau di dalam record.
const readFile = (rec) => (rec.data !== undefined ? Buffer.from(rec.data, 'base64') : fs.readFileSync(absPath(rec)));

function saveUpload(user, b) {
  if (!b || typeof b.data !== 'string' || !b.data) throw new HttpError(400, 'Data file kosong.');
  const name = cleanName(b.name);
  const buf = Buffer.from(b.data, 'base64');
  if (!buf.length) throw new HttpError(400, 'File kosong.');
  if (buf.length > cfg.MAX_FILE_MB * 1048576) throw new HttpError(413, `Ukuran file maksimal ${cfg.MAX_FILE_MB} MB.`);
  if (usedBytes(user.id) + buf.length > cfg.STORAGE_LIMIT_MB * 1048576) throw new HttpError(413, `Penyimpanan penuh (batas ${cfg.STORAGE_LIMIT_MB} MB). Hapus file lama dulu.`);

  let kind = null, type = null;
  const img = IMAGE_TYPES.find(([, test]) => test(buf));
  if (img) { kind = 'image'; type = img[0]; }
  else if (TEXT_EXT.has((name.split('.').pop() || '').toLowerCase()) && !buf.includes(0)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); kind = 'text'; type = 'text/plain'; } catch { /* bukan UTF-8 */ }
  }
  if (!kind) throw new HttpError(415, 'Jenis file belum didukung. Gunakan gambar (PNG/JPG/WebP/GIF) atau file teks/kode (txt, md, csv, json, js, py, dll.).');

  const id = uid();
  let rec;
  if (filesUseDisk) {
    const rel = path.join('uploads', user.id, id);
    fs.mkdirSync(path.join(cfg.DATA_DIR, 'uploads', user.id), { recursive: true });
    fs.writeFileSync(path.join(cfg.DATA_DIR, rel), buf);
    rec = { id, userId: user.id, name, type, kind, size: buf.length, rel, createdAt: Date.now() };
  } else {
    rec = { id, userId: user.id, name, type, kind, size: buf.length, data: buf.toString('base64'), createdAt: Date.now() };
  }
  db.files[id] = rec; save();
  return rec;
}
function removeFile(rec) {
  if (filesUseDisk) { try { fs.unlinkSync(absPath(rec)); } catch { /* sudah hilang */ } }
  delete db.files[rec.id]; save();
}

module.exports = { saveUpload, removeFile, absPath, readFile, publicFile, usedBytes };
