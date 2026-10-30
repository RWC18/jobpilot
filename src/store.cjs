// Tiny JSON-file persistence under data/. Every collection is one file.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = process.env.JOBPILOT_ROOT || path.join(__dirname, '..');
const DATA = process.env.JOBPILOT_DATA || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const bus = new EventEmitter();

function file(name) { return path.join(DATA, name + '.json'); }

function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch { return structuredClone(fallback); }
}

function save(name, value) {
  const f = file(name);
  fs.writeFileSync(f + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(f + '.tmp', f);
}

/** The first PDF/DOCX in data/cv (where uploads go), so a CV dropped there works without settings. */
function firstCv() {
  const dir = path.join(DATA, 'cv');
  try {
    const name = fs.readdirSync(dir).find((f) => /\.(pdf|docx)$/i.test(f));
    return name ? path.join(dir, name) : '';
  } catch { return ''; }
}

function localConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8')); }
  catch { return {}; }
}

const DEFAULT_SETTINGS = {
  openaiApiKey: '',
  chatModel: 'gpt-5.4',
  fastModel: 'gpt-5.4-mini',
  cvPath: firstCv(),
  prefs: {
    keywords: ['React Developer', 'Frontend Engineer', 'Full Stack Engineer', 'Next.js Developer', 'AI Engineer'],
    location: 'Worldwide',
    remoteOnly: true,
    terms: { long: true, short: true, project: true },
    sources: { linkedin: true, upwork: true, remote: true },
    minScore: 70,
    hourlyRate: 35,
    minSalaryUsd: 0,
    excludeWords: ['senior staff', 'principal', 'clearance', 'onsite only'],
  },
  autopilot: {
    enabled: false,
    mode: 'approve', // 'approve' = shortlist for you, 'auto' = apply by itself
    intervalMin: 60,
    dailyCaps: { linkedin: 15, upwork: 4, remote: 10 },
    upworkConnectsPerDay: 40,
    delaySec: [60, 180],
  },
};

let settings, jobs, answers, chat, log, daily, runtime;

/** (Re)reads every collection from disk. The Netlify functions call this after pulling data from Blobs. */
function reload() {
  const saved = load('settings', DEFAULT_SETTINGS);
  // Merge new defaults into older saved settings.
  settings = {
    ...structuredClone(DEFAULT_SETTINGS), ...saved,
    prefs: { ...DEFAULT_SETTINGS.prefs, ...saved.prefs },
    autopilot: { ...DEFAULT_SETTINGS.autopilot, ...saved.autopilot },
  };
  if (!settings.openaiApiKey) settings.openaiApiKey = localConfig().openaiApiKey || process.env.OPENAI_API_KEY || '';
  jobs = load('jobs', {});
  answers = load('answers', {});
  chat = load('chat', []);
  log = load('log', []);
  daily = load('daily', {});
  runtime = load('runtime', {});
}
reload();

const store = {
  bus,
  DATA,
  ROOT,
  reload,
  /** True in the Netlify deployment: no browser there, so applying happens in the PC app. */
  ONLINE: process.env.JOBPILOT_MODE === 'online',

  /** Small shared flags (e.g. a search running in another function). */
  get runtime() { return runtime; },
  setRuntime(patch) { runtime = { ...runtime, ...patch }; save('runtime', runtime); bus.emit('status'); },

  get settings() { return settings; },
  updateSettings(patch) {
    settings = {
      ...settings, ...patch,
      prefs: { ...settings.prefs, ...(patch.prefs || {}) },
      autopilot: { ...settings.autopilot, ...(patch.autopilot || {}) },
    };
    save('settings', settings);
    bus.emit('settings', settings);
    return settings;
  },

  allJobs() { return Object.values(jobs); },
  getJob(id) { return jobs[id]; },
  /** Inserts new jobs, keeps existing ones (and their status) untouched. Returns the new ones. */
  addJobs(list) {
    const added = [];
    for (const j of list) {
      if (jobs[j.id]) continue;
      const now = new Date().toISOString();
      jobs[j.id] = { status: 'new', score: null, foundAt: now, ...j, updatedAt: now };
      added.push(jobs[j.id]);
    }
    if (added.length) { save('jobs', jobs); bus.emit('jobs'); }
    return added;
  },
  updateJob(id, patch) {
    if (!jobs[id]) return null;
    // updatedAt lets the Netlify sync keep the newest copy when two functions edit jobs at once.
    jobs[id] = { ...jobs[id], ...patch, updatedAt: new Date().toISOString() };
    save('jobs', jobs);
    bus.emit('jobs');
    return jobs[id];
  },

  answerFor(label) { return answers[normLabel(label)]; },
  rememberAnswer(label, value) {
    if (!label || value == null || value === '') return;
    answers[normLabel(label)] = value;
    save('answers', answers);
  },

  get chat() { return chat; },
  setChat(messages) { chat = messages.slice(-200); save('chat', chat); },

  get log() { return log; },
  addLog(text, level = 'info') {
    const entry = { at: new Date().toISOString(), text, level };
    log = [...log.slice(-499), entry];
    save('log', log);
    bus.emit('log', entry);
  },

  /** Per-day counters, e.g. applications per source and Upwork connects spent. */
  today() {
    const key = new Date().toISOString().slice(0, 10);
    if (!daily[key]) daily = { [key]: { linkedin: 0, upwork: 0, remote: 0, connects: 0 } };
    return daily[key];
  },
  bumpToday(field, by = 1) {
    const t = store.today();
    t[field] = (t[field] || 0) + by;
    save('daily', daily);
    bus.emit('status');
  },
};

function normLabel(s) {
  return String(s).toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

module.exports = store;
