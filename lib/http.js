'use strict';
// Helper HTTP murni tanpa library eksternal (Cookie, CORS, JSON, static file, rate limit).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function secureHeaders(res) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; " +
    "media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
}

function clientIp(req) {
  if (cfg.TRUST_PROXY) {
    const x = req.headers['x-forwarded-for'];
    if (x) return String(x).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

function isHttps(req) {
  return cfg.TRUST_PROXY
    ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    : !!(req.socket && req.socket.encrypted);
}

function json(res, status, obj, headers = {}) {
  const s = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(s);
}

async function readBody(req, limit) {
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body);
    if (typeof req.body === 'object' && req.body !== null) return Buffer.from(JSON.stringify(req.body));
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'Data terlalu besar.');
  const chunks = [];
  let n = 0;
  if (typeof req[Symbol.asyncIterator] === 'function') {
    for await (const c of req) {
      n += c.length;
      if (n > limit) throw new HttpError(413, 'Data terlalu besar.');
      chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    }
  } else {
    await new Promise((resolve, reject) => {
      req.on('data', (c) => {
        n += c.length;
        if (n > limit) reject(new HttpError(413, 'Data terlalu besar.'));
        else chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
      });
      req.on('end', resolve);
      req.on('error', reject);
    });
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 1024 * 1024) {
  if (req.body !== undefined) {
    if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
      return req.body;
    }
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { throw new HttpError(400, 'JSON tidak valid.'); }
    }
    if (Buffer.isBuffer(req.body)) {
      try { return JSON.parse(req.body.toString('utf8')); } catch { throw new HttpError(400, 'JSON tidak valid.'); }
    }
  }
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'JSON tidak valid.');
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* abaikan */ }
  }
  return out;
}

function cookieHeader(name, value, { maxAge, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function serveStatic(req, res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return false; }
  if (p === '/') p = '/index.html';

  const clean = p.startsWith('/') ? p.slice(1) : p;
  const candidates = [
    path.join(cfg.ROOT, 'public', clean),
    path.join(cfg.ROOT, clean),
    path.join(__dirname, '..', 'public', clean),
    path.join(__dirname, '..', clean),
    path.join(process.cwd(), 'public', clean),
    path.join(process.cwd(), clean),
  ];

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const st = fs.statSync(file);
        if (st.isFile()) {
          const ext = path.extname(file).toLowerCase();
          const type = MIME[ext];
          if (!type) continue;
          const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304);
            res.end();
            return true;
          }
          res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': st.size,
            ETag: etag,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
          });
          if (req.method === 'HEAD') { res.end(); return true; }
          fs.createReadStream(file).pipe(res);
          return true;
        }
      }
    } catch { /* coba kandidat berikutnya */ }
  }

  // Fallback ke file ter-bundle jika tidak ditemukan di disk serverless
  if (p === '/index.html' || p === '/') {
    const html = require('./html');
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
    return true;
  }
  if (p === '/css/styles.css') {
    const css = require('./styles');
    const buf = Buffer.from(css, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=300',
    });
    res.end(buf);
    return true;
  }
  if (p === '/js/app.js') {
    const js = require('./appjs');
    const buf = Buffer.from(js, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=300',
    });
    res.end(buf);
    return true;
  }
  if (p === '/js/boot.js') {
    const js = require('./bootjs');
    const buf = Buffer.from(js, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=300',
    });
    res.end(buf);
    return true;
  }

  return false;
}

function limiter() {
  const m = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of m) if (e.reset < now) m.delete(k);
  }, 60000).unref();

  return (key, max, windowMs) => {
    const now = Date.now();
    let e = m.get(key);
    if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; m.set(key, e); }
    e.n++;
    return e.n <= max;
  };
}

module.exports = {
  HttpError,
  secureHeaders,
  clientIp,
  isHttps,
  json,
  readBody,
  readJson,
  parseCookies,
  cookieHeader,
  serveStatic,
  limiter,
};
