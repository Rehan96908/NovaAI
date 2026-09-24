'use strict';
// Statistik dashboard, dihitung dari data nyata milik pengguna.
const { db } = require('./db');
const cfg = require('./config');
const models = require('./models');

const dk = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function series(counts, days) {
  const out = []; const now = new Date();
  for (let i = days - 1; i >= 0; i--) { const k = dk(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)); out.push({ date: k, count: counts[k] || 0 }); }
  return out;
}
const modelName = (id) => (models.get(id) || { name: id }).name;

function computeStats(user, usedToday) {
  const convs = Object.values(db.conversations).filter((c) => c.userId === user.id);
  const now = new Date();
  const cur = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const t = { chatsCur: 0, chatsPrev: 0, msgCur: 0, msgPrev: 0, tokCur: 0, tokPrev: 0 };
  const perDay = {}, perModel = {};

  for (const c of convs) {
    if (c.createdAt >= cur) t.chatsCur++; else if (c.createdAt >= prev) t.chatsPrev++;
    for (const m of c.messages) {
      if (m.role === 'user') {
        const k = dk(m.createdAt); perDay[k] = (perDay[k] || 0) + 1;
        if (m.createdAt >= cur) t.msgCur++; else if (m.createdAt >= prev) t.msgPrev++;
      } else {
        perModel[m.model] = (perModel[m.model] || 0) + 1;
        const tok = m.tokens || 0;
        if (m.createdAt >= cur) t.tokCur += tok; else if (m.createdAt >= prev) t.tokPrev += tok;
      }
    }
  }
  const totalAnswers = Object.values(perModel).reduce((a, b) => a + b, 0);
  const modelUsage = Object.entries(perModel)
    .map(([id, n]) => ({ id, name: modelName(id), count: n, pct: Math.round((n / totalAnswers) * 100) }))
    .sort((a, b) => b.count - a.count);
  const files = Object.values(db.files).filter((f) => f.userId === user.id).sort((a, b) => b.createdAt - a.createdAt);

  return {
    totals: { chats: convs.length, ...t },
    favorite: modelUsage[0] || null,
    activity: { 7: series(perDay, 7), 30: series(perDay, 30) },
    modelUsage: modelUsage.slice(0, 5),
    recent: convs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5).map((c) => ({ id: c.id, title: c.title, model: modelName(c.model), updatedAt: c.updatedAt })),
    files: files.slice(0, 8).map((f) => ({ id: f.id, name: f.name, size: f.size, kind: f.kind, createdAt: f.createdAt })),
    quota: { usedToday, dailyLimit: cfg.FREE_DAILY_MESSAGES, storageBytes: files.reduce((a, f) => a + f.size, 0), storageLimitBytes: cfg.STORAGE_LIMIT_MB * 1048576, conversations: convs.length },
  };
}
module.exports = { computeStats };
