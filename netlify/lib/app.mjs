// The online (Netlify) version of the JobPilot server: same routes as src/server.cjs, with data kept in
// Netlify Blobs and long work handed to a background function. The function files in netlify/functions
// are thin wrappers around handle(), runTask() and autopilotTick().
import './env.mjs';
import crypto from 'node:crypto';
import { createSync } from './sync.mjs';
import store from '../../src/store.cjs';
import jobsModule from '../../src/jobs.cjs';
import routesModule from '../../src/routes.cjs';
import auth from '../../src/auth.cjs';

const { routes } = routesModule;
const jobs = jobsModule;

/** Shared secret between the API function and the background worker. */
export const workerKey = () => crypto.createHmac('sha256', process.env.JOBPILOT_PASSWORD || 'none').update('jobpilot-worker').digest('hex');

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });

/** auth.cjs expects Node's request shape. */
const nodeLike = (req) => ({ headers: Object.fromEntries(req.headers), socket: { remoteAddress: '' } });

async function withData(blobs, fn) {
  const sync = createSync(blobs, store.DATA);
  await sync.pull();
  store.reload();
  try { return await fn(sync); } finally { await sync.push(); }
}

/** Handles one HTTP request to /api/* or /cv. dispatch({task, opts}) starts the background worker. */
export async function handle(req, { blobs, dispatch }) {
  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname}`;
  const body = async () => (req.method === 'POST' ? JSON.parse((await req.text()) || '{}') : {});

  if (!auth.enabled) return json({ error: 'Set the JOBPILOT_PASSWORD environment variable in Netlify, then redeploy.' }, 503);
  if (route === 'POST /api/auth/login') {
    const r = auth.login(nodeLike(req), (await body()).password);
    return r.error ? json({ error: r.error }, 401) : json({ ok: true }, 200, { 'Set-Cookie': r.cookie });
  }
  if (route === 'POST /api/auth/logout') return json({ ok: true }, 200, { 'Set-Cookie': auth.logoutCookie });
  if (!auth.allowed(nodeLike(req))) return json({ error: 'Log in first' }, 401);

  // The CV lives in its own blob, not in the synced files.
  if (route === 'GET /cv') {
    const cv = await blobs.getWithMetadata('cv', { type: 'arrayBuffer' });
    if (!cv) return json({ error: 'No CV uploaded yet' }, 404);
    return new Response(cv.data, { headers: { 'Content-Type': cv.metadata.type || 'application/pdf', 'Content-Disposition': `inline; filename="${cv.metadata.name}"` } });
  }
  if (route === 'POST /api/cv') {
    const name = decodeURIComponent(req.headers.get('x-file-name') || 'cv.pdf').replace(/[^\w.\- ]/g, '_');
    if (!/\.(pdf|docx)$/i.test(name)) return json({ error: 'Upload a PDF or DOCX' }, 400);
    const type = name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await blobs.set('cv', await req.arrayBuffer(), { metadata: { name, type } });
    return withData(blobs, () => { store.updateSettings({ cvPath: name }); return json({ cvPath: name }); });
  }

  const handler = routes[route];
  if (!handler) return json({ error: 'Not found' }, 404);
  const input = await body();
  return withData(blobs, async () => {
    jobs.runInBackground(dispatch);
    try {
      return json(await handler(input, { canLogout: true, live: false }));
    } catch (e) {
      return json({ error: e.message }, 400);
    }
  });
}

/** Runs one long task (search / rescore / cycle) inside the background function. */
export async function runTask({ task, opts }, { blobs }) {
  jobs.runInBackground(null);
  return withData(blobs, async (sync) => {
    store.setRuntime({ busy: task, since: new Date().toISOString() });
    await sync.push();
    // Save progress every few seconds so the board fills in while the task runs.
    let timer = null;
    const flushSoon = () => { clearTimeout(timer); timer = setTimeout(() => sync.push(), 3000); };
    store.bus.on('jobs', flushSoon);
    store.bus.on('log', flushSoon);
    try {
      if (task === 'search') await jobs.searchAll(opts || {});
      else if (task === 'rescore') await jobs.rescoreInbox(opts || {});
      else if (task === 'cycle') await jobs.runCycle();
    } catch (e) {
      store.addLog(`Background ${task} failed: ${e.message}`, 'error');
    } finally {
      clearTimeout(timer);
      store.bus.off('jobs', flushSoon);
      store.bus.off('log', flushSoon);
      store.setRuntime({ busy: null, since: null, ...(task === 'cycle' ? { lastCycleAt: new Date().toISOString() } : {}) });
    }
  });
}

/** Called hourly: starts an autopilot cycle when autopilot is on and its interval has passed. */
export async function autopilotTick({ blobs, dispatch }) {
  return withData(blobs, async () => {
    const ap = store.settings.autopilot;
    const last = new Date(store.runtime.lastCycleAt || 0).getTime();
    if (!ap.enabled || Date.now() - last < (ap.intervalMin - 5) * 60000) return 'skipped';
    store.setRuntime({ lastCycleAt: new Date().toISOString() });
    await dispatch({ task: 'cycle', opts: {} });
    return 'started';
  });
}
