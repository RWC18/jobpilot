// Password login for deployed instances. Set JOBPILOT_PASSWORD to turn it on.
// The session cookie is an HMAC of the password, so changing the password logs everyone out.
const crypto = require('crypto');

const PASSWORD = process.env.JOBPILOT_PASSWORD || '';
const enabled = Boolean(PASSWORD);
const token = enabled ? crypto.createHmac('sha256', PASSWORD).update('jobpilot-session-v1').digest('hex') : '';

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** True when the request may use the app. */
function allowed(req) {
  if (!enabled) return true;
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)jp_session=([a-f0-9]+)/);
  return Boolean(m) && sameText(m[1], token);
}

// Slow down password guessing: 10 tries per IP per 15 minutes.
const tries = new Map();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

/** Checks the password; returns the Set-Cookie header on success, null otherwise. */
function login(req, password) {
  const ip = clientIp(req);
  const now = Date.now();
  const t = tries.get(ip) || { n: 0, since: now };
  if (now - t.since > 15 * 60000) { t.n = 0; t.since = now; }
  if (t.n >= 10) return { error: 'Too many attempts. Try again in 15 minutes.' };
  if (!sameText(password || '', PASSWORD)) {
    t.n++;
    tries.set(ip, t);
    return { error: 'Wrong password' };
  }
  tries.delete(ip);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return { cookie: `jp_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}` };
}

const logoutCookie = 'jp_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';

module.exports = { enabled, allowed, login, logoutCookie };
