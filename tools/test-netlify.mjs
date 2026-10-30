// Exercises the Netlify handlers locally with an in-memory Blobs store (no Netlify account needed).
// Usage: node tools/test-netlify.mjs
import os from 'node:os';
import path from 'node:path';

process.env.JOBPILOT_PASSWORD = 'test-password';
process.env.JOBPILOT_DATA = path.join(os.tmpdir(), 'jobpilot-netlify-test-' + Date.now());
process.env.JOBPILOT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
delete process.env.OPENAI_API_KEY;

const { handle, runTask, autopilotTick } = await import('../netlify/lib/app.mjs');

// Minimal stand-in for @netlify/blobs getStore().
const data = new Map();
const blobs = {
  async get(k) { return data.has(k) ? data.get(k).value : null; },
  async getWithMetadata(k) { return data.has(k) ? { data: data.get(k).value, metadata: data.get(k).metadata } : null; },
  async set(k, value, opts = {}) { data.set(k, { value, metadata: opts.metadata || {} }); },
};
const dispatched = [];
const dispatch = async (p) => { dispatched.push(p); };

let cookie = '';
async function call(method, route, body) {
  const req = new Request('https://jobpilot.test' + route, {
    method,
    headers: { 'Content-Type': 'application/json', cookie, 'x-forwarded-proto': 'https' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handle(req, { blobs, dispatch });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

const check = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);

let r = await call('GET', '/api/init');
check('blocked before login', r.status === 401);
r = await call('POST', '/api/auth/login', { password: 'nope' });
check('wrong password rejected', r.status === 401);
r = await call('POST', '/api/auth/login', { password: 'test-password' });
check('login', r.status === 200 && cookie.startsWith('jp_session='));
r = await call('GET', '/api/init');
check('init', r.status === 200 && r.body.online === true && r.body.live === false, `jobs=${r.body?.jobs.length}`);

r = await call('POST', '/api/settings', { prefs: { keywords: ['React Developer'], sources: { linkedin: true, upwork: true, remote: true } } });
check('settings saved to blobs', r.status === 200 && JSON.parse(data.get('settings.json').value).prefs.keywords[0] === 'React Developer');

r = await call('POST', '/api/search', {});
check('search handed to background', r.body?.started === true && dispatched.length === 1, JSON.stringify(dispatched[0]));
r = await call('POST', '/api/search', {});
check('second search refused while busy', !r.body?.started && /already running/.test(r.body?.note || ''));

r = await call('POST', '/api/apply', { ids: ['x'] });
check('apply refused online', r.status === 400 && /PC/.test(r.body?.error || ''));

console.log('… running the background search (LinkedIn + remote boards, keyword scoring) …');
await runTask(dispatched[0], { blobs });
r = await call('GET', '/api/poll');
const jobs = r.body.jobs;
check('background search saved jobs', jobs.length > 0, `jobs=${jobs.length}, searching=${r.body.status.searching}`);
check('no Upwork jobs online', !jobs.some((j) => j.source === 'upwork'));
check('busy flag cleared', r.body.status.searching === false);

const id = jobs[0].id;
await call('POST', '/api/set-status', { ids: [id], status: 'applied' });
r = await call('GET', '/api/poll');
check('mark applied', r.body.jobs.find((j) => j.id === id).status === 'applied');

const tick1 = await autopilotTick({ blobs, dispatch });
check('autopilot off: tick skipped', tick1 === 'skipped');
await call('POST', '/api/settings', { autopilot: { enabled: true, mode: 'approve' } });
const tick2 = await autopilotTick({ blobs, dispatch });
check('autopilot on: cycle started', tick2 === 'started' && dispatched.at(-1).task === 'cycle');

r = await call('POST', '/api/auth/logout', {});
r = await call('GET', '/api/init');
check('logout', r.status === 401);
