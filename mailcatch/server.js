// https://github.com/SeanDishman/openai-account-generator
'use strict';

/*
 * mailcatch — a wildcard catch-all mail server.
 *
 * - Runs an SMTP server that accepts mail for ANY address at your domain
 *   (no auth, no per-mailbox config — true wildcard / catch-all).
 * - Parses each message and keeps it in memory (and on disk).
 * - Serves a small web UI that lists incoming mail live.
 * - Exposes a JSON API, including "latest notification + timestamp received".
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

// ---- config (override via env) --------------------------------------------
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25', 10);
const HTTP_HOST = process.env.HTTP_HOST || '0.0.0.0';
const SMTP_HOST = process.env.SMTP_HOST || '0.0.0.0';
const MAX_EMAILS = parseInt(process.env.MAX_EMAILS || '500', 10);
const MAX_SIZE = parseInt(process.env.MAX_SIZE || String(25 * 1024 * 1024), 10); // 25MB
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'emails.json');

// Auth: one password guards both the web login and the JSON API. It lives ONLY
// here on the backend — it is never sent to the browser. Override with the
// AUTH_PASSWORD env var if you want to change it without editing this file.
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'change-me';
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(30 * 24 * 3600 * 1000), 10);

// ---- storage (in-memory, newest first, persisted to disk) -----------------
/** @type {Array<object>} */
let emails = [];

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) emails = parsed;
    console.log(`[store] loaded ${emails.length} message(s) from ${DATA_FILE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[store] could not load data file:', err.message);
  }
}

let persistTimer = null;
function persist() {
  // debounce disk writes so a burst of mail doesn't thrash the disk
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(emails), 'utf8');
    } catch (err) {
      console.warn('[store] could not persist:', err.message);
    }
  }, 500);
}

function addEmail(record) {
  emails.unshift(record);
  if (emails.length > MAX_EMAILS) emails.length = MAX_EMAILS;
  persist();
}

// ---- SMTP server ----------------------------------------------------------
const smtp = new SMTPServer({
  // A catch-all needs zero authentication and no TLS requirement — real senders
  // (Gmail, etc.) just connect on port 25 and hand us the message.
  authOptional: true,
  disabledCommands: ['AUTH'],
  size: MAX_SIZE,
  // Accept every recipient. This is what makes it a wildcard: mail to
  // literally-anything@yourdomain is accepted.
  onRcptTo(address, session, cb) {
    cb();
  },
  onData(stream, session, cb) {
    simpleParser(stream, {}, (err, parsed) => {
      if (err) {
        console.error('[smtp] parse error:', err.message);
        return cb(err);
      }

      const rcpt = (session.envelope.rcptTo || []).map((r) => r.address);
      const mailFrom =
        (session.envelope.mailFrom && session.envelope.mailFrom.address) || '';

      const record = {
        id: crypto.randomBytes(9).toString('hex'),
        // The timestamp we received it — the thing the API is asked to report.
        receivedAt: new Date().toISOString(),
        remoteAddress: session.remoteAddress || '',
        // envelope (what the SMTP conversation actually said)
        envelopeFrom: mailFrom,
        envelopeTo: rcpt,
        // parsed headers
        from: (parsed.from && parsed.from.text) || mailFrom || '',
        to: (parsed.to && parsed.to.text) || rcpt.join(', '),
        subject: parsed.subject || '(no subject)',
        date: parsed.date ? parsed.date.toISOString() : null,
        text: parsed.text || '',
        html: parsed.html || '',
        attachments: (parsed.attachments || []).map((a) => ({
          filename: a.filename || 'attachment',
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || 0,
        })),
      };

      addEmail(record);
      console.log(
        `[smtp] +mail  to=${rcpt.join(',') || '?'}  from=${record.from}  subj="${record.subject}"`
      );
      cb();
    });
  },
});

smtp.on('error', (err) => {
  console.error('[smtp] server error:', err.message);
});

// ---- auth (backend-only; password never leaves the server) ----------------
// Sessions are random tokens held in memory. A restart clears them (just log in
// again). Requests authenticate EITHER with the session cookie (web UI) OR with
// the password in a header (programmatic API use).
const sessions = new Map(); // token -> expiresAt (ms)

function newSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function sessionValid(token) {
  const exp = token && sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// constant-time compare so the password can't be guessed by timing
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function isAuthed(req) {
  // 1) web UI: valid session cookie
  const cookies = parseCookies(req);
  if (sessionValid(cookies.mc_session)) return true;
  // 2) API: password via header  (Authorization: Bearer <pw>  or  X-Api-Key: <pw>)
  const authz = req.headers['authorization'] || '';
  const bearer = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  const key = req.headers['x-api-key'] || bearer;
  if (key && safeEqual(key, AUTH_PASSWORD)) return true;
  return false;
}
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// ---- HTTP: web UI + JSON API ----------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // we sit behind Caddy/nginx
app.use(express.json({ limit: '1mb' }));

// CORS for the JSON API so browser extensions / cross-origin clients can call it.
// Auth is header-based (X-Api-Key / Bearer), never cookies, so a wildcard origin
// is safe here — no credentials ride along. Preflight (OPTIONS) is answered before
// requireAuth so it never 401s.
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Api-Key, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// POST /api/login  { "password": "..." }  -> sets an httpOnly session cookie
app.post('/api/login', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (!safeEqual(password, AUTH_PASSWORD)) {
    return res.status(401).json({ ok: false, error: 'wrong password' });
  }
  const token = newSession();
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  res.setHeader(
    'Set-Cookie',
    `mc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}${secure ? '; Secure' : ''}`
  );
  res.json({ ok: true });
});

// POST /api/logout — drop the session
app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.mc_session) sessions.delete(cookies.mc_session);
  res.setHeader('Set-Cookie', 'mc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// GET /api/session — lets the UI know if it's already logged in
app.get('/api/session', (req, res) => res.json({ authed: isAuthed(req) }));

// slim summary (no big bodies) for list views
function summarize(e) {
  return {
    id: e.id,
    receivedAt: e.receivedAt,
    from: e.from,
    to: e.to,
    envelopeTo: e.envelopeTo,
    subject: e.subject,
    hasHtml: !!e.html,
    attachments: e.attachments,
  };
}

// GET /api/latest — the latest notification and the timestamp we got it.
app.get('/api/latest', requireAuth, (req, res) => {
  if (!emails.length) {
    return res.json({ email: null, receivedAt: null, count: 0 });
  }
  const latest = emails[0];
  res.json({
    email: latest,
    receivedAt: latest.receivedAt,
    count: emails.length,
  });
});

// GET /api/emails — list summaries. Optional ?to=foo filters by recipient.
//   ?limit=N caps the number returned (default all, up to MAX_EMAILS).
app.get('/api/emails', requireAuth, (req, res) => {
  let list = emails;
  if (req.query.to) {
    const needle = String(req.query.to).toLowerCase();
    list = list.filter(
      (e) =>
        (e.envelopeTo || []).some((a) => a.toLowerCase().includes(needle)) ||
        (e.to || '').toLowerCase().includes(needle)
    );
  }
  const limit = parseInt(req.query.limit || '0', 10);
  if (limit > 0) list = list.slice(0, limit);
  res.json({ count: list.length, total: emails.length, emails: list.map(summarize) });
});

// GET /api/emails/:id — one full message (headers + text + html).
app.get('/api/emails/:id', requireAuth, (req, res) => {
  const e = emails.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'not found' });
  res.json(e);
});

// DELETE /api/emails — clear the mailbox.
app.delete('/api/emails', requireAuth, (req, res) => {
  emails = [];
  persist();
  res.json({ ok: true });
});

// health check (public, no data leaked)
app.get('/healthz', (req, res) => res.json({ ok: true }));

// static web UI
app.use(express.static(path.join(__dirname, 'public')));

// ---- boot -----------------------------------------------------------------
loadFromDisk();

app.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[http] web UI + API on http://${HTTP_HOST}:${HTTP_PORT}`);
});

smtp.listen(SMTP_PORT, SMTP_HOST, () => {
  console.log(`[smtp] listening for mail on ${SMTP_HOST}:${SMTP_PORT}`);
});

// graceful shutdown
function shutdown() {
  console.log('\n[app] shutting down…');
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(emails), 'utf8');
  } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
