// Search, scoring, the apply queue and autopilot.
const store = require('./store.cjs');
const llm = require('./llm.cjs');
const { getProfile, facts } = require('./profile.cjs');
const { jitter, NeedsUser } = require('./util.cjs');
const linkedin = require('./sources/linkedin.cjs');
const upwork = require('./sources/upwork.cjs');
const remote = require('./sources/remote.cjs');
const external = require('./sources/external.cjs');

const state = { searching: false, applying: null, cycle: false, lastCycleAt: null };
const log = (text, level) => store.addLog(text, level);
const emitStatus = () => store.bus.emit('status');

// ---------- scoring ----------

const GOOD = ['react', 'next.js', 'nextjs', 'typescript', 'javascript', 'frontend', 'front-end', 'front end', 'full stack', 'full-stack', 'fullstack', 'node', 'redux', 'ai', 'llm', 'gpt', 'openai', 'claude', 'agent', 'web app', 'ui'];
const BAD = ['java ', '.net', 'c#', 'php', 'ruby', 'rails', 'django', 'golang','ios', 'android', 'flutter', 'salesforce', 'sap', 'devops engineer', 'data engineer', 'principal', 'staff engineer', 'director', 'head of', 'clearance', 'us citizens only', 'on-site', 'onsite'];

function ruleScore(job) {
  const title = (job.title || '').toLowerCase();
  const desc = (job.description || '').toLowerCase();
  let s = 35;
  for (const w of GOOD) { if (title.includes(w)) s += 12; else if (desc.includes(w)) s += 3; }
  for (const w of BAD) { if (title.includes(w)) s -= 25; else if (desc.includes(w)) s -= 4; }
  if (/senior|sr\.?\b/.test(title)) s += 2;
  if (store.settings.prefs.remoteOnly && !/remote|anywhere|worldwide/.test(`${title} ${desc} ${job.location}`.toLowerCase())) s -= 30;
  return Math.max(0, Math.min(100, Math.round(s)));
}

const SCORE_SYSTEM = `You rank job postings for the candidate in the profile. For each job give a match score 0-100:
90+ = near perfect fit (stack, seniority, remote, location rules all fit), 70-89 = good fit worth applying,
40-69 = partial fit, below 40 = poor fit or the candidate is not eligible (e.g. needs a security clearance or a different main stack).
Check the location rules carefully: a job limited to a region the candidate does not live in (LATAM only, US only, EU residents,
"North America only", a specific country's timezone with residency) scores at most 35, however good the stack fit. Also give a one-sentence reason (max 20 words) and, if the posting makes it clear, the engagement
"term": "long" (full-time/permanent), "short" (contract/temporary/part-time) or "project" (fixed price / per project).
Return JSON {"results":[{"id":..., "score":..., "reason":..., "term":...}]}`;

const MAX_AGE_DAYS = 30;
const isStale = (j) => j.postedAt && Date.now() - new Date(j.postedAt).getTime() > MAX_AGE_DAYS * 864e5;

async function scoreJobs(list) {
  const excl = store.settings.prefs.excludeWords.map((w) => w.toLowerCase()).filter(Boolean);
  for (const job of list) {
    const hay = `${job.title} ${job.description || ''}`.toLowerCase();
    const hit = excl.find((w) => hay.includes(w));
    if (hit) store.updateJob(job.id, { score: 0, scoreReason: `Excluded word "${hit}"`, status: 'skipped' });
    else if (isStale(job)) store.updateJob(job.id, { scoreReason: `Posted over ${MAX_AGE_DAYS} days ago, likely closed`, status: 'skipped' });
  }
  const todo = list.filter((j) => store.getJob(j.id)?.status !== 'skipped');

  // LinkedIn search cards have no description; fetch it for the ones we score.
  for (const job of todo.filter((j) => j.source === 'linkedin' && !j.description).slice(0, 40)) {
    try { store.updateJob(job.id, await linkedin.details(job)); }
    catch (e) { log(`LinkedIn details ${job.extId}: ${e.message}`, 'warn'); }
    await jitter(400, 1100);
  }

  const profile = getProfile();
  for (let i = 0; i < todo.length; i += 8) {
    const batch = todo.slice(i, i + 8).map((j) => store.getJob(j.id));
    try {
      const prefs = store.settings.prefs;
      const out = await llm.askJson(SCORE_SYSTEM, JSON.stringify({
        profile,
        wants: prefs.remoteOnly ? `Remote only, working from ${facts().location || 'their home country'}. On-site/hybrid jobs elsewhere score below 30.` : 'Remote or on-site',
        jobs: batch.map((j) => ({ id: j.id, title: j.title, company: j.company, location: j.location, pay: j.pay, term: j.term, description: (j.description || '').slice(0, 1500) })),
      }));
      for (const r of out.results || []) {
        if (!store.getJob(r.id)) continue;
        const patch = { score: Math.round(Number(r.score) || 0), scoreReason: r.reason || '' };
        if (['long', 'short', 'project'].includes(r.term)) patch.term = r.term;
        store.updateJob(r.id, patch);
      }
    } catch (e) {
      log(`AI scoring failed for ${batch.length} jobs (${e.message.slice(0, 90)}). Using keyword scoring for them.`, 'warn');
      for (const j of batch) store.updateJob(j.id, { score: ruleScore(j), scoreReason: 'Keyword match (AI offline)' });
    }
  }
}

// ---------- background hand-off (Netlify) ----------

// In the Netlify API function, long work (search, re-score, autopilot) is handed to a background function
// that can run 15 minutes; the request returns at once and the board fills in as results are saved.
let background = null;
function runInBackground(fn) { background = fn; }

async function delegate(task, opts) {
  const busy = store.runtime.busy;
  if (busy && Date.now() - new Date(store.runtime.since).getTime() < 15 * 60000) {
    return { added: [], note: `A ${busy} is already running. Results appear on the board as they come in.` };
  }
  store.setRuntime({ busy: task, since: new Date().toISOString() });
  await background({ task, opts });
  return { added: [], started: true, note: 'Started in the background. New jobs appear on the board in 1-3 minutes.' };
}

/** Re-scores jobs still in the inbox, e.g. after the profile changed or AI scoring was offline. */
async function rescoreInbox({ all = false } = {}) {
  if (background) return delegate('rescore', { all });
  const list = store.allJobs().filter((j) => ['new', 'shortlisted'].includes(j.status) && (all || j.score == null || /^Keyword/.test(j.scoreReason || '')));
  log(`Re-scoring ${list.length} inbox jobs…`);
  await scoreJobs(list);
  const good = list.filter((j) => (store.getJob(j.id).score ?? 0) >= store.settings.prefs.minScore).length;
  log(`Re-scored ${list.length} jobs — ${good} at or above ${store.settings.prefs.minScore}.`, 'success');
  return { rescored: list.length, good };
}

// ---------- search ----------

async function searchAll(opts = {}) {
  if (background) return delegate('search', opts);
  if (state.searching) return { added: [], note: 'A search is already running.' };
  const prefs = store.settings.prefs;
  const keywords = opts.keywords?.length ? opts.keywords : prefs.keywords;
  const terms = opts.terms?.length ? Object.fromEntries(['long', 'short', 'project'].map((t) => [t, opts.terms.includes(t)])) : prefs.terms;
  const sources = opts.sources?.length ? Object.fromEntries(['linkedin', 'upwork', 'remote'].map((s) => [s, opts.sources.includes(s)])) : prefs.sources;
  const args = { keywords, terms, location: opts.location || prefs.location, remoteOnly: opts.remoteOnly ?? prefs.remoteOnly, log };

  state.searching = true; emitStatus();
  const found = [];
  try {
    if (sources.linkedin) { log(`Searching LinkedIn for ${keywords.join(', ')}…`); found.push(...await linkedin.search(args)); }
    if (sources.remote) { log('Searching Remotive, RemoteOK and We Work Remotely…'); found.push(...(await remote.search(args)).filter((j) => terms[j.term])); }
    if (sources.upwork && !store.ONLINE) { // Upwork needs a browser
      log('Searching Upwork…');
      try { found.push(...await upwork.search(args)); }
      catch (e) { log(`Upwork search failed: ${e.message}`, 'warn'); }
    }
    const added = store.addJobs(found);
    log(`Found ${found.length} jobs, ${added.length} new. Scoring…`);
    await scoreJobs(added);
    const good = added.map((j) => store.getJob(j.id)).filter((j) => j.score >= prefs.minScore).length;
    log(`Scored ${added.length} new jobs — ${good} at or above ${prefs.minScore}.`);
    return { added: added.map((j) => store.getJob(j.id)) };
  } finally {
    state.searching = false; emitStatus();
  }
}

// ---------- applying ----------

function capFor(group) { return store.settings.autopilot.dailyCaps[group] ?? 10; }
function capReached(group) { return store.today()[group] >= capFor(group); }

function enqueue(ids) {
  if (store.ONLINE) throw new Error('Applying runs in the JobPilot app on your PC. Online, open the job, apply, then mark it applied.');
  const queued = [];
  for (const id of ids) {
    const j = store.getJob(id);
    if (!j || ['applied', 'applying'].includes(j.status)) continue;
    store.updateJob(id, { status: 'queued', queuedAt: new Date().toISOString(), note: '' });
    queued.push(id);
  }
  processQueue();
  return queued;
}

const APPLIERS = { linkedin: linkedin.apply, upwork: upwork.apply, remotive: external.apply, remoteok: external.apply, wwr: external.apply };

async function applyOne(job, { dryRun = false } = {}) {
  const cvPath = store.settings.cvPath;
  state.applying = job.id; emitStatus();
  store.updateJob(job.id, { status: 'applying' });
  log(`${dryRun ? 'Dry run' : 'Applying'}: ${job.title} @ ${job.company} (${job.source})`);
  try {
    const result = await APPLIERS[job.source](job, { cvPath, log, dryRun });
    if (result === 'dry-run') {
      store.updateJob(job.id, { status: 'shortlisted', note: 'Dry run passed: form filled, ready to submit' });
      log(`✓ Dry run passed: ${job.title} @ ${job.company}`, 'success');
      return;
    }
    store.updateJob(job.id, { status: 'applied', appliedAt: new Date().toISOString(), note: '' });
    store.bumpToday(job.sourceGroup);
    log(`✓ Applied: ${job.title} @ ${job.company}`, 'success');
  } catch (e) {
    const needs = e instanceof NeedsUser;
    store.updateJob(job.id, { status: needs ? 'needs_you' : 'failed', note: e.message.slice(0, 300) });
    log(`${needs ? 'Needs you' : 'Failed'}: ${job.title} — ${e.message}`, needs ? 'warn' : 'error');
  } finally {
    state.applying = null; emitStatus();
  }
}

let queueRunning = false;
/** Applies to queued jobs one by one. only = limit to these ids (used by dry runs). */
async function processQueue({ dryRun = false, only = null } = {}) {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (;;) {
      const next = store.allJobs()
        .filter((j) => j.status === 'queued' && !capReached(j.sourceGroup) && (!only || only.includes(j.id)))
        .sort((a, b) => (a.queuedAt || '').localeCompare(b.queuedAt || ''))[0];
      if (!next) break;
      await applyOne(next, { dryRun });
      const [lo, hi] = dryRun ? [3, 6] : store.settings.autopilot.delaySec;
      if (store.allJobs().some((j) => j.status === 'queued' && (!only || only.includes(j.id)))) await jitter(lo * 1000, hi * 1000);
    }
    const waiting = store.allJobs().filter((j) => j.status === 'queued').length;
    if (waiting) log(`${waiting} queued jobs wait for tomorrow (daily limits reached).`, 'warn');
  } finally {
    queueRunning = false;
  }
}

// ---------- autopilot ----------

let timer = null;

/**
 * One autopilot cycle: search, then queue the best new matches (as many as today's limits allow,
 * per source) or shortlist them. dryRun: fill the forms of the top 3 but send nothing.
 */
async function runCycle({ dryRun = false } = {}) {
  if (background) return delegate('cycle', { dryRun });
  if (state.cycle) return;
  state.cycle = true; emitStatus();
  try {
    const ap = store.settings.autopilot;
    const prefs = store.settings.prefs;
    const auto = ap.mode === 'auto' && !store.ONLINE; // online there is no browser to apply with
    log(`Autopilot cycle (${dryRun ? 'dry run' : auto ? 'auto-apply' : 'shortlist'} mode)`);
    await searchAll();
    const picks = store.allJobs()
      .filter((j) => j.status === 'new' && j.score >= prefs.minScore && prefs.terms[j.term])
      .sort((a, b) => b.score - a.score);
    if (auto || dryRun) {
      const left = {};
      for (const g of ['linkedin', 'upwork', 'remote']) left[g] = dryRun ? 3 : Math.max(0, capFor(g) - (store.today()[g] || 0));
      const chosen = picks.filter((j) => left[j.sourceGroup]-- > 0).slice(0, dryRun ? 3 : undefined);
      const ids = enqueue(chosen.map((j) => j.id));
      log(`Autopilot queued ${ids.length} ${dryRun ? 'dry-run ' : ''}applications.`);
      await processQueue({ dryRun, only: dryRun ? ids : null });
    } else {
      for (const j of picks) store.updateJob(j.id, { status: 'shortlisted' });
      if (picks.length) log(`Shortlisted ${picks.length} jobs for your approval.`, 'success');
    }
  } catch (e) {
    log(`Autopilot cycle failed: ${e.message}`, 'error');
  } finally {
    state.cycle = false;
    state.lastCycleAt = new Date().toISOString();
    emitStatus();
  }
}

function scheduleAutopilot() {
  if (store.ONLINE) return; // a Netlify scheduled function runs the cycles
  clearInterval(timer);
  timer = null;
  const ap = store.settings.autopilot;
  if (!ap.enabled) return;
  timer = setInterval(runCycle, Math.max(15, ap.intervalMin) * 60000);
  setTimeout(runCycle, 3000);
}

function status() {
  const all = store.allJobs();
  const count = (s) => all.filter((j) => j.status === s).length;
  return {
    ...state,
    searching: state.searching || Boolean(store.runtime.busy),
    online: store.ONLINE,
    autopilot: store.settings.autopilot,
    today: store.today(),
    caps: store.settings.autopilot.dailyCaps,
    counts: { total: all.length, new: count('new'), shortlisted: count('shortlisted'), queued: count('queued'), applied: count('applied'), needs_you: count('needs_you') },
  };
}

function resumeQueue() {
  if (store.ONLINE) return;
  // Jobs that were mid-apply when the app closed go back into the queue.
  for (const j of store.allJobs()) if (j.status === 'applying') store.updateJob(j.id, { status: 'queued' });
  processQueue();
}

module.exports = { runInBackground, searchAll, scoreJobs, rescoreInbox, enqueue, processQueue, runCycle, scheduleAutopilot, status, resumeQueue };
