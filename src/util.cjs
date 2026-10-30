const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function getJson(url) { return JSON.parse(await getText(url)); }

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(\w+);/g, (m, n) => ENTITIES[n] ?? m);
}

function stripHtml(html) {
  return decode(String(html || '')
    .replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Buckets a job into the three kinds the user cares about:
 * long = full-time / permanent, short = contract / temporary / part-time, project = fixed-price / freelance gig.
 */
function classifyTerm(hint, text = '') {
  const h = String(hint || '').toLowerCase();
  const t = String(text || '').toLowerCase().slice(0, 4000);
  if (/fixed|freelance|per[- ]project|gig/.test(h)) return 'project';
  if (/contract|temporary|part[-_ ]?time|intern/.test(h)) return 'short';
  if (/full[-_ ]?time|permanent/.test(h)) {
    return /\b(contract|freelance)\b.{0,40}\b(\d+\s*(month|week)s?)\b/.test(t) ? 'short' : 'long';
  }
  if (/fixed[- ]price|per project|project[- ]based|one[- ]time project/.test(t)) return 'project';
  if (/\bcontract(or)?\b|temporary|\b\d+\s*(month|week)s? (contract|engagement)/.test(t)) return 'short';
  if (/full[- ]time|permanent|benefits|equity/.test(t)) return 'long';
  return 'long';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (minMs, maxMs) => sleep(minMs + Math.random() * (maxMs - minMs));

/** An application that stopped where a human has to step in (login, captcha, unknown question). */
class NeedsUser extends Error {}

module.exports = { UA, getText, getJson, decode, stripHtml, classifyTerm, sleep, jitter, NeedsUser };
