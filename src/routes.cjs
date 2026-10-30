// JSON API routes shared by the local server (server.cjs) and the Netlify function (netlify/lib/app.mjs).
const store = require('./store.cjs');
const jobs = require('./jobs.cjs');
const agent = require('./agent.cjs');
const browser = require('./browser.cjs');
const profile = require('./profile.cjs');

function publicSettings() {
  const s = store.settings;
  return { ...s, openaiApiKey: s.openaiApiKey ? '••••' + s.openaiApiKey.slice(-4) : '', profile: profile.getProfile() };
}

/** Jobs without their long descriptions: the board never shows them and they would make every update heavy. */
const publicJobs = () => store.allJobs().map(({ description, ...j }) => j);

/**
 * Routes keyed "METHOD /path". Each handler gets the parsed JSON body and an extras object
 * ({ onAgentEvent, remoteBrowser, canLogout, live }) from the host.
 */
const routes = {
  'GET /api/init': (_b, x) => ({
    jobs: publicJobs(), log: store.log.slice(-200), chat: store.chat, status: jobs.status(), settings: publicSettings(),
    remoteBrowser: Boolean(x.remoteBrowser), canLogout: Boolean(x.canLogout), live: x.live !== false, online: store.ONLINE,
  }),
  // Polling fallback for hosts without a live event stream (Netlify).
  'GET /api/poll': () => ({ jobs: publicJobs(), log: store.log.slice(-60), status: jobs.status() }),
  'POST /api/chat': ({ text }, x) => agent.send(text, x.onAgentEvent).then((reply) => ({ reply })),
  'POST /api/clear-chat': () => { store.setChat([]); return { ok: true }; },
  'POST /api/search': (opts) => jobs.searchAll(opts || {}).then((r) => ({ added: r.added.length, note: r.note, started: r.started })),
  'POST /api/apply': ({ ids }) => ({ queued: jobs.enqueue(ids).length }),
  'POST /api/set-status': ({ ids, status }) => {
    const extra = status === 'applied' ? { appliedAt: new Date().toISOString() } : {};
    ids.forEach((id) => store.updateJob(id, { status, ...extra }));
    return { ok: true };
  },
  'POST /api/login': ({ site }) => browser.openLogin(site).then(() => ({ ok: true })),
  'POST /api/browser/open': () => browser.context().then(() => ({ ok: true })),
  'POST /api/run-cycle': async () => {
    const cycle = jobs.runCycle();
    if (store.ONLINE) await cycle; // online it only hands the cycle to the background function
    return { ok: true };
  },
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

module.exports = { routes };
