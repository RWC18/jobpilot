// JobPilot web server: serves the UI, a JSON API and a live event stream (SSE).
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const store = require('./store.cjs');
const jobs = require('./jobs.cjs');
const agent = require('./agent.cjs');
const browser = require('./browser.cjs');
const profile = require('./profile.cjs');
const auth = require('./auth.cjs');

const PORT = Number(process.env.PORT) || 4310;
const HOST = process.env.HOST || '127.0.0.1';
// In the Docker image Chrome runs on a virtual screen exposed over VNC; the UI shows it so you can log in to sites.
const VNC_PORT = Number(process.env.JOBPILOT_VNC_PORT) || 0;
const WEB = path.join(store.ROOT, 'web');
const PUBLIC_PATHS = new Set(['/login.html', '/styles.css', '/api/auth/login']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf' };

// ---------- live events ----------

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
let jobsTimer = null;
store.bus.on('jobs', () => { clearTimeout(jobsTimer); jobsTimer = setTimeout(() => broadcast('jobs', store.allJobs()), 200); });
store.bus.on('log', (entry) => broadcast('log', entry));
store.bus.on('status', () => broadcast('status', jobs.status()));
store.bus.on('settings', () => broadcast('status', jobs.status()));

function publicSettings() {
  const s = store.settings;
  return { ...s, openaiApiKey: s.openaiApiKey ? '••••' + s.openaiApiKey.slice(-4) : '', profile: profile.getProfile() };
}

// ---------- API ----------

const api = {
  'GET /api/init': () => ({
    jobs: store.allJobs(), log: store.log.slice(-200), chat: store.chat, status: jobs.status(), settings: publicSettings(),
    remoteBrowser: Boolean(VNC_PORT), canLogout: auth.enabled,
  }),
  'POST /api/browser/open': () => browser.context().then(() => ({ ok: true })),
  'POST /api/chat': ({ text }) => agent.send(text, (ev) => broadcast('agent', ev)).then((reply) => ({ reply })),
  'POST /api/clear-chat': () => { store.setChat([]); return { ok: true }; },
  'POST /api/search': (opts) => jobs.searchAll(opts || {}).then((r) => ({ added: r.added.length, note: r.note })),
  'POST /api/apply': ({ ids }) => ({ queued: jobs.enqueue(ids).length }),
  'POST /api/set-status': ({ ids, status }) => { ids.forEach((id) => store.updateJob(id, { status })); return { ok: true }; },
  'POST /api/login': ({ site }) => browser.openLogin(site).then(() => ({ ok: true })),
  'POST /api/run-cycle': () => { jobs.runCycle(); return { ok: true }; },
  'GET /api/settings': () => publicSettings(),
  'POST /api/settings': (patch) => {
    const { profile: profileText, openaiApiKey, ...rest } = patch;
    if (profileText != null) profile.setProfile(profileText);
    if (openaiApiKey && !openaiApiKey.startsWith('••••')) rest.openaiApiKey = openaiApiKey.trim();
    store.updateSettings(rest);
    jobs.scheduleAutopilot();
    return publicSettings();
  },
};

function readBody(req, limit = 15e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) reject(new Error('Too large')); else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'POST /api/auth/login') {
      const { password } = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
      const r = auth.login(req, password);
      if (r.error) return sendJson(res, 401, { error: r.error });
      res.setHeader('Set-Cookie', r.cookie);
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /api/auth/logout') {
      res.setHeader('Set-Cookie', auth.logoutCookie);
      return sendJson(res, 200, { ok: true });
    }
    if (!auth.allowed(req) && !PUBLIC_PATHS.has(url.pathname)) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/events') {
        res.writeHead(302, { Location: '/login.html' });
        return res.end();
      }
      return sendJson(res, 401, { error: 'Log in first' });
    }
    if (route === 'GET /events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (route === 'GET /cv') {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(store.settings.cvPath)] || 'application/octet-stream' });
      fs.createReadStream(store.settings.cvPath).pipe(res);
      return;
    }
    if (route === 'POST /api/cv') {
      // Raw file upload; the file name comes in a header.
      const name = path.basename(decodeURIComponent(req.headers['x-file-name'] || 'cv.pdf')).replace(/[^\w.\- ]/g, '_');
      if (!/\.(pdf|docx)$/i.test(name)) return sendJson(res, 400, { error: 'Upload a PDF or DOCX' });
      const dest = path.join(store.DATA, 'cv', name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, await readBody(req));
      store.updateSettings({ cvPath: dest });
      return sendJson(res, 200, { cvPath: dest });
    }
    if (api[route]) {
      const raw = req.method === 'POST' ? (await readBody(req, 2e6)).toString() : '';
      return sendJson(res, 200, await api[route](raw ? JSON.parse(raw) : {}));
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.join(WEB, rel);
      if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// ---------- remote browser view (VNC over WebSocket) ----------

if (VNC_PORT) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/websockify' || !auth.allowed(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const vnc = net.connect(VNC_PORT, '127.0.0.1');
      vnc.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d));
      ws.on('message', (d) => vnc.write(d));
      const end = () => { vnc.destroy(); ws.close(); };
      vnc.on('close', end);
      vnc.on('error', end);
      ws.on('close', end);
    });
  });
}

// The API can apply to jobs on your accounts, so anything reachable from outside must have a password.
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
if (!loopback && !auth.enabled) {
  console.error(`Refusing to listen on ${HOST} without a password. Set JOBPILOT_PASSWORD.`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`JobPilot running at http://${loopback ? 'localhost' : HOST}:${PORT}${auth.enabled ? ' (password protected)' : ''}`);
  jobs.scheduleAutopilot();
  jobs.resumeQueue();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await browser.close(); process.exit(0); });
