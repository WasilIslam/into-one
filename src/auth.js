// Stateless signing for sessions and OAuth state (works across serverless instances).
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY;
const DAY = 24 * 3600e3;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp && p.exp < Date.now() ? null : p;
}

const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(c => {
  const i = c.indexOf('=');
  return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
}));

const setCookie = (res, name, value, maxAgeMs) => res.append('Set-Cookie',
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`);

const allowed = email => (process.env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).includes(String(email).toLowerCase());

const session = req => verify(cookies(req).sid);
const startSession = (res, email) => setCookie(res, 'sid', sign({ email, exp: Date.now() + 30 * DAY }), 30 * DAY);
const endSession = res => setCookie(res, 'sid', '', 0);

// OAuth state = signed {purpose, nonce}; nonce also lives in a cookie so the callback is bound to this browser.
function newState(res, purpose, extra = {}) {
  const nonce = crypto.randomBytes(12).toString('hex');
  setCookie(res, `st_${purpose}`, nonce, 10 * 60e3);
  return sign({ purpose, nonce, ...extra, exp: Date.now() + 10 * 60e3 });
}

// Returns the state payload ({ purpose, ...extra }) if it's valid for this browser, else null.
function checkState(req, state) {
  const p = verify(state);
  return p && cookies(req)[`st_${p.purpose}`] === p.nonce ? p : null;
}

module.exports = { sign, verify, session, startSession, endSession, allowed, newState, checkState };
