'use strict';
// Hash kata sandi (scrypt) + JWT HS256 buatan sendiri — tanpa library eksternal.
const crypto = require('crypto');
const { promisify } = require('util');
const cfg = require('./config');
const scrypt = promisify(crypto.scrypt);

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `s1$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  try {
    const [v, s, h] = String(stored).split('$');
    if (v !== 's1') return false;
    const key = await scrypt(pw, Buffer.from(s, 'base64'), 64);
    const ref = Buffer.from(h, 'base64');
    return key.length === ref.length && crypto.timingSafeEqual(key, ref);
  } catch { return false; }
}

const enc = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const mac = (data) => crypto.createHmac('sha256', cfg.JWT_SECRET).update(data).digest();

function signJwt(payload, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({ ...payload, iat: now, exp: now + ttlSec });
  return `${head}.${body}.${mac(`${head}.${body}`).toString('base64url')}`;
}
function verifyJwt(token) {
  try {
    const [h, b, s] = String(token).split('.');
    if (!h || !b || !s) return null;
    const head = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (head.alg !== 'HS256') return null;
    const want = mac(`${h}.${b}`);
    const got = Buffer.from(s, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp && p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

module.exports = { hashPassword, verifyPassword, signJwt, verifyJwt };
