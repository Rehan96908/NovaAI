'use strict';
const crypto = require('crypto');
let Pool;
try {
  ({ Pool } = require('pg'));
} catch {
  throw new Error('Paket "pg" belum terpasang. Jalankan: npm install');
}

const CONN = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL;
let pool = null;

function getPool() {
  if (pool) return pool;
  let connStr = process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL || CONN;
  let cleanConnStr = connStr;
  try {
    if (connStr && connStr.includes('://')) {
      const u = new URL(connStr);
      u.searchParams.delete('sslmode');
      u.searchParams.delete('supa');
      cleanConnStr = u.toString();
    }
  } catch {}
  pool = new Pool({
    connectionString: cleanConnStr,
    ssl: /localhost|127\.0\.0\.1/.test(connStr || '') ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (e) => console.error('[db.pg] galat pool:', e.message));
  return pool;
}

const TABLE = process.env.POSTGRES_TABLE || 'nova_state';
let tableReady = null;

async function ensureTable() {
  if (!tableReady) {
    tableReady = (async () => {
      const p = getPool();
      // 1. State Table (sumber kebenaran dokumen state)
      await p.query(
        `CREATE TABLE IF NOT EXISTS "${TABLE}" (
           id INT PRIMARY KEY,
           data JSONB NOT NULL DEFAULT '{}'::jsonb,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
      await p.query(
        `INSERT INTO "${TABLE}" (id, data, updated_at)
         VALUES (1, '{}'::jsonb, now())
         ON CONFLICT (id) DO NOTHING`
      );

      // 2. Relational Normalized Tables (untuk struktur SQL penuh & audit di dashboard DB)
      await p.query(
        `CREATE TABLE IF NOT EXISTS "nova_users" (
           id VARCHAR(64) PRIMARY KEY,
           email VARCHAR(255) UNIQUE NOT NULL,
           name VARCHAR(255) NOT NULL,
           pass_hash TEXT NOT NULL,
           role VARCHAR(32) DEFAULT 'user',
           plan VARCHAR(32) DEFAULT 'free',
           disabled BOOLEAN DEFAULT FALSE,
           token_version INT DEFAULT 0,
           settings JSONB DEFAULT '{}'::jsonb,
           usage JSONB DEFAULT '{}'::jsonb,
           created_at BIGINT NOT NULL
         )`
      ).catch(() => {});

      await p.query(
        `CREATE TABLE IF NOT EXISTS "nova_conversations" (
           id VARCHAR(64) PRIMARY KEY,
           user_id VARCHAR(64) NOT NULL,
           title VARCHAR(255) NOT NULL,
           model VARCHAR(64) NOT NULL,
           pinned BOOLEAN DEFAULT FALSE,
           archived BOOLEAN DEFAULT FALSE,
           created_at BIGINT NOT NULL,
           updated_at BIGINT NOT NULL
         )`
      ).catch(() => {});

      await p.query(
        `CREATE TABLE IF NOT EXISTS "nova_messages" (
           id VARCHAR(64) PRIMARY KEY,
           conversation_id VARCHAR(64) NOT NULL,
           role VARCHAR(32) NOT NULL,
           content TEXT NOT NULL,
           files JSONB DEFAULT '[]'::jsonb,
           tokens INT DEFAULT 0,
           like_status INT DEFAULT 0,
           aborted BOOLEAN DEFAULT FALSE,
           created_at BIGINT NOT NULL
         )`
      ).catch(() => {});

      await p.query(
        `CREATE TABLE IF NOT EXISTS "nova_sessions" (
           id VARCHAR(128) PRIMARY KEY,
           user_id VARCHAR(64) NOT NULL,
           token TEXT,
           expires_at BIGINT NOT NULL,
           created_at BIGINT NOT NULL
         )`
      ).catch(() => {});
    })().catch((e) => {
      tableReady = null;
      console.error('[db.pg] ensureTable error:', e.message);
      throw e;
    });
  }
  return tableReady;
}

const db = { users: {}, conversations: {}, files: {}, sessions: {} };
let dirty = false;
let loaded = false;

async function loadDb() {
  await ensureTable();
  const p = getPool();
  const { rows } = await p.query(`SELECT data FROM "${TABLE}" WHERE id = 1`);
  const fresh = rows[0] ? rows[0].data : {};
  for (const k of Object.keys(db)) delete db[k];
  Object.assign(db, { users: {}, conversations: {}, files: {}, sessions: {}, ...fresh });
  dirty = false;
  loaded = true;
}

function save() {
  dirty = true;
}

async function flushIfDirty() {
  if (!dirty) return;
  dirty = false;
  await ensureTable();
  const p = getPool();

  // 1. Simpan atomic state ke tabel utama
  await p.query(
    `INSERT INTO "${TABLE}" (id, data, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [JSON.stringify(db)]
  );

  // 2. Sinkronkan ke tabel relasional terpisah (non-blocking)
  try {
    for (const u of Object.values(db.users || {})) {
      await p.query(
        `INSERT INTO "nova_users" (id, email, name, pass_hash, role, plan, disabled, token_version, settings, usage, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email, name = EXCLUDED.name, pass_hash = EXCLUDED.pass_hash,
           role = EXCLUDED.role, plan = EXCLUDED.plan, disabled = EXCLUDED.disabled,
           token_version = EXCLUDED.token_version, settings = EXCLUDED.settings,
           usage = EXCLUDED.usage`,
        [u.id, u.email, u.name, u.passHash, u.role, u.plan, !!u.disabled, u.tokenVersion || 0, JSON.stringify(u.settings || {}), JSON.stringify(u.usage || {}), u.createdAt || Date.now()]
      ).catch(() => {});
    }

    for (const c of Object.values(db.conversations || {})) {
      await p.query(
        `INSERT INTO "nova_conversations" (id, user_id, title, model, pinned, archived, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title, model = EXCLUDED.model, pinned = EXCLUDED.pinned,
           archived = EXCLUDED.archived, updated_at = EXCLUDED.updated_at`,
        [c.id, c.userId, c.title, c.model, !!c.pinned, !!c.archived, c.createdAt || Date.now(), c.updatedAt || Date.now()]
      ).catch(() => {});

      if (Array.isArray(c.messages)) {
        for (const m of c.messages) {
          if (!m.id) continue;
          await p.query(
            `INSERT INTO "nova_messages" (id, conversation_id, role, content, files, tokens, like_status, aborted, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET
               content = EXCLUDED.content, files = EXCLUDED.files, tokens = EXCLUDED.tokens,
               like_status = EXCLUDED.like_status, aborted = EXCLUDED.aborted`,
            [m.id, c.id, m.role, m.content || '', JSON.stringify(m.files || []), m.tokens || 0, m.like || 0, !!m.aborted, m.createdAt || Date.now()]
          ).catch(() => {});
        }
      }
    }

    for (const [sid, sess] of Object.entries(db.sessions || {})) {
      await p.query(
        `INSERT INTO "nova_sessions" (id, user_id, token, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [sid, sess.userId, sess.token || '', sess.expiresAt || 0, sess.createdAt || Date.now()]
      ).catch(() => {});
    }
  } catch (err) {
    // Relational table sync error ditoleransi karena nova_state sudah tersimpan aman
  }
}

async function flush() {
  dirty = true;
  await flushIfDirty();
}

const uid = () => crypto.randomBytes(9).toString('base64url');
const mode = 'postgres';
const filesUseDisk = false;

module.exports = {
  db,
  save,
  flush,
  uid,
  loadDb,
  flushIfDirty,
  mode,
  filesUseDisk,
  get isLoaded() { return loaded; },
  get _pool() { return getPool(); }
};
