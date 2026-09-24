'use strict';

const { requestHandler } = require('../server');
const dbMod = require('../lib/db');

module.exports = async (req, res) => {
  if (typeof dbMod.loadDb === 'function') {
    try {
      await dbMod.loadDb();
    } catch (e) {
      console.error('[api] gagal memuat data dari database:', e.message);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'Tidak bisa terhubung ke database. Coba lagi sesaat lagi: ' + e.message }));
    }
  }

  try {
    await requestHandler(req, res);
  } finally {
    if (typeof dbMod.flushIfDirty === 'function') {
      try {
        await dbMod.flushIfDirty();
      } catch (e) {
        console.error('[api] gagal menyimpan data ke database:', e.message);
      }
    }
  }
};
