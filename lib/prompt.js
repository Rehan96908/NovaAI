'use strict';
// Menyusun pesan yang dikirim ke model: system prompt + riwayat + lampiran.
const { db } = require('./db');
const { readFile } = require('./files');

const HISTORY_MAX = 40;        // jumlah pesan terakhir yang dikirim
const CHAR_BUDGET = 120000;    // batas total karakter riwayat
const TEXT_LIMIT = 40000;      // batas per file teks
const TOTAL_TEXT_LIMIT = 90000;
const MAX_IMAGES = 4;

function systemPrompt(user, s) {
  const style = { ringkas: 'Jawab ringkas dan langsung ke inti.', seimbang: 'Jawab jelas dengan kedalaman yang seimbang.', mendetail: 'Jawab mendetail dan terstruktur; sertakan langkah dan contoh bila berguna.' }[s.style] || '';
  return [
    'Kamu adalah asisten AI di aplikasi web "Nova AI".',
    `Bahasa utama jawaban: ${s.language === 'en' ? 'English' : 'Bahasa Indonesia'}, kecuali pengguna jelas memakai bahasa lain.`,
    style,
    'Gunakan Markdown (judul, daftar, tabel, blok kode berlabel bahasa) bila membantu keterbacaan.',
    'Jika tidak yakin, katakan terus terang dan jangan mengarang fakta.',
    user.name ? `Nama pengguna: ${user.name}.` : '',
    user.bio ? `Catatan pengguna tentang dirinya: ${String(user.bio).slice(0, 500)}` : '',
  ].filter(Boolean).join('\n');
}

const isImage = (f) => String(f.type || '').startsWith('image/');

function toUpstream(m, model, budget) {
  if (m.role === 'assistant') return m.content ? { role: 'assistant', content: m.content } : null;
  let text = m.content || '';
  const parts = [];
  for (const ref of m.files || []) {
    const rec = db.files[ref.id];
    if (!rec) { text += `\n\n[Lampiran "${ref.name}" sudah dihapus]`; continue; }
    if (isImage(rec)) {
      if (model.vision && budget.images > 0) {
        budget.images--;
        parts.push({ type: 'image_url', image_url: { url: `data:${rec.type};base64,${readFile(rec).toString('base64')}` } });
      } else text += `\n\n[Gambar "${ref.name}" tidak disertakan${model.vision ? ' (batas gambar tercapai)' : ' (model ini tidak bisa membaca gambar)'}]`;
    } else {
      let t = ''; try { t = readFile(rec).toString('utf8'); } catch { /* hilang */ }
      const cut = Math.max(0, Math.min(TEXT_LIMIT, budget.text));
      const clipped = t.length > cut;
      t = t.slice(0, cut); budget.text -= t.length;
      text += `\n\n[Lampiran: ${ref.name}]\n\`\`\`\n${t}${clipped ? '\n… (dipotong)' : ''}\n\`\`\``;
    }
  }
  return parts.length ? { role: 'user', content: [{ type: 'text', text: text || '(lihat gambar)' }, ...parts] } : { role: 'user', content: text || '(kosong)' };
}

// Gabungkan pesan berurutan dengan peran sama (beberapa gateway mensyaratkan peran bergantian).
function mergeSameRole(list) {
  const out = [];
  for (const m of list) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      const a = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      const b = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      if (typeof last.content === 'string' && typeof m.content === 'string') last.content += '\n\n' + m.content;
      else last.content = [...a, ...b];
    } else out.push({ ...m });
  }
  return out;
}

function buildMessages({ user, settings, conv, model }) {
  let recent = conv.messages.slice(-HISTORY_MAX);
  let budget = CHAR_BUDGET; const keep = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const len = (recent[i].content || '').length;
    if (budget - len < 0 && keep.length) break;
    budget -= len; keep.unshift(recent[i]);
  }
  while (keep.length && keep[0].role !== 'user') keep.shift();

  const b = { images: MAX_IMAGES, text: TOTAL_TEXT_LIMIT };
  const converted = [];
  for (let i = keep.length - 1; i >= 0; i--) { const u = toUpstream(keep[i], model, b); if (u) converted.unshift(u); } // terbaru lebih dulu dapat jatah gambar
  return [{ role: 'system', content: systemPrompt(user, settings) }, ...mergeSameRole(converted)];
}

module.exports = { buildMessages };
