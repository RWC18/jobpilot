// The chat agent: GPT with tools over the job store, search, apply queue and autopilot.
const store = require('./store.cjs');
const llm = require('./llm.cjs');
const jobs = require('./jobs.cjs');
const browser = require('./browser.cjs');
const upwork = require('./sources/upwork.cjs');
const { getProfile } = require('./profile.cjs');

const TERMS = ['long', 'short', 'project'];
const SOURCES = ['linkedin', 'upwork', 'remote'];

const tools = [
  fn('search_jobs', 'Search LinkedIn, Upwork and remote job boards for new jobs, then score them. Takes 1-3 minutes.', {
    keywords: { type: 'array', items: { type: 'string' }, description: 'Job titles / skills. Omit to use saved preferences.' },
    terms: { type: 'array', items: { enum: TERMS }, description: 'long = full-time, short = contract/temporary, project = per-project pay' },
    sources: { type: 'array', items: { enum: SOURCES } },
    location: { type: 'string' },
    remote_only: { type: 'boolean' },
  }),
  fn('list_jobs', 'List jobs already found, best match first.', {
    status: { enum: ['new', 'shortlisted', 'queued', 'applied', 'needs_you', 'failed', 'skipped', 'any'] },
    term: { enum: [...TERMS, 'any'] },
    source: { enum: ['linkedin', 'upwork', 'remotive', 'remoteok', 'wwr', 'any'] },
    min_score: { type: 'number' },
    limit: { type: 'number' },
  }),
  fn('rescore_jobs', 'Re-score inbox jobs with AI. By default only jobs that only have a keyword score; all=true re-scores everything (use after a profile change).', {
    all: { type: 'boolean' },
  }),
  fn('get_job', 'Full details of one job.', { id: { type: 'string' } }, ['id']),
  fn('apply_to_jobs', 'Queue jobs for automatic application. They are applied one by one with pauses, within daily limits.', {
    job_ids: { type: 'array', items: { type: 'string' } },
  }, ['job_ids']),
  fn('skip_jobs', 'Mark jobs as not interesting.', { job_ids: { type: 'array', items: { type: 'string' } } }, ['job_ids']),
  fn('write_cover_letter', 'Write a tailored cover letter / proposal for a job.', { id: { type: 'string' } }, ['id']),
  fn('set_autopilot', 'Turn autopilot on/off or change it. mode "approve" shortlists jobs for the user; "auto" applies by itself.', {
    enabled: { type: 'boolean' },
    mode: { enum: ['approve', 'auto'] },
    interval_min: { type: 'number' },
    min_score: { type: 'number' },
    daily_caps: { type: 'object', properties: { linkedin: { type: 'number' }, upwork: { type: 'number' }, remote: { type: 'number' } } },
  }),
  fn('update_preferences', 'Change saved search preferences.', {
    keywords: { type: 'array', items: { type: 'string' } },
    location: { type: 'string' },
    remote_only: { type: 'boolean' },
    terms: { type: 'array', items: { enum: TERMS } },
    sources: { type: 'array', items: { enum: SOURCES } },
    hourly_rate: { type: 'number' },
    exclude_words: { type: 'array', items: { type: 'string' } },
  }),
  fn('get_status', 'Counts, today\'s applications vs limits, autopilot state.', {}),
  fn('open_login', 'Open the LinkedIn or Upwork login page in the JobPilot Chrome window so the user can sign in.', { site: { enum: ['linkedin', 'upwork'] } }, ['site']),
];

function fn(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const brief = (j) => ({ id: j.id, url: j.url, title: j.title, company: j.company, source: j.source, term: j.term, score: j.score, pay: j.pay || undefined, location: j.location, status: j.status, why: j.scoreReason || undefined, note: j.note || undefined });

const handlers = {
  async search_jobs(a) {
    const { added, note } = await jobs.searchAll({ keywords: a.keywords, terms: a.terms, sources: a.sources, location: a.location, remoteOnly: a.remote_only });
    if (note) return { note };
    const top = added.filter((j) => j.status !== 'skipped').sort((x, y) => (y.score ?? 0) - (x.score ?? 0)).slice(0, 12);
    return { new_jobs: added.length, top: top.map(brief) };
  },
  list_jobs(a) {
    let list = store.allJobs();
    if (a.status && a.status !== 'any') list = list.filter((j) => j.status === a.status);
    if (a.term && a.term !== 'any') list = list.filter((j) => j.term === a.term);
    if (a.source && a.source !== 'any') list = list.filter((j) => j.source === a.source);
    if (a.min_score != null) list = list.filter((j) => (j.score ?? 0) >= a.min_score);
    list.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
    return { total: list.length, jobs: list.slice(0, a.limit || 15).map(brief) };
  },
  async rescore_jobs(a) {
    const r = await jobs.rescoreInbox({ all: a.all });
    const top = store.allJobs().filter((j) => ['new', 'shortlisted'].includes(j.status)).sort((x, y) => (y.score ?? 0) - (x.score ?? 0)).slice(0, 10);
    return { ...r, top: top.map(brief) };
  },
  get_job({ id }) {
    const j = store.getJob(id);
    return j ? { ...brief(j), url: j.url, description: (j.description || '').slice(0, 3000) } : { error: 'No such job' };
  },
  apply_to_jobs({ job_ids }) {
    const queued = jobs.enqueue(job_ids);
    return { queued: queued.length, today: store.today(), caps: store.settings.autopilot.dailyCaps };
  },
  skip_jobs({ job_ids }) {
    job_ids.forEach((id) => store.updateJob(id, { status: 'skipped' }));
    return { skipped: job_ids.length };
  },
  async write_cover_letter({ id }) {
    const j = store.getJob(id);
    if (!j) return { error: 'No such job' };
    return { letter: await upwork.writeProposal(j) };
  },
  set_autopilot(a) {
    const patch = { autopilot: {} };
    if (a.enabled != null) patch.autopilot.enabled = a.enabled;
    if (a.mode) patch.autopilot.mode = a.mode;
    if (a.interval_min) patch.autopilot.intervalMin = a.interval_min;
    if (a.daily_caps) patch.autopilot.dailyCaps = { ...store.settings.autopilot.dailyCaps, ...a.daily_caps };
    if (a.min_score != null) patch.prefs = { minScore: a.min_score };
    store.updateSettings(patch);
    jobs.scheduleAutopilot();
    return { autopilot: store.settings.autopilot, min_score: store.settings.prefs.minScore };
  },
  update_preferences(a) {
    const p = {};
    if (a.keywords) p.keywords = a.keywords;
    if (a.location) p.location = a.location;
    if (a.remote_only != null) p.remoteOnly = a.remote_only;
    if (a.terms) p.terms = Object.fromEntries(TERMS.map((t) => [t, a.terms.includes(t)]));
    if (a.sources) p.sources = Object.fromEntries(SOURCES.map((s) => [s, a.sources.includes(s)]));
    if (a.hourly_rate) p.hourlyRate = a.hourly_rate;
    if (a.exclude_words) p.excludeWords = a.exclude_words;
    return { prefs: store.updateSettings({ prefs: p }).prefs };
  },
  get_status() { return jobs.status(); },
  async open_login({ site }) {
    await browser.openLogin(site);
    return { opened: site, tell_user: 'Sign in in the Chrome window that opened. JobPilot never sees the password.' };
  },
};

function systemPrompt() {
  const s = store.settings;
  return `You are JobPilot, a job-hunting agent working for the candidate below. Today is ${new Date().toDateString()}.
You find jobs on LinkedIn (Easy Apply), Upwork and remote boards (Remotive, RemoteOK, We Work Remotely) and apply with the candidate's CV.
Engagement kinds: "long" = long term / full-time, "short" = short term / contract, "project" = paid per project.

How to work:
- Use tools; never invent jobs, links or results.
- When the user asks to find jobs, call search_jobs, then summarise the best matches briefly (title, company, kind, score, one reason).
- Apply only to jobs the user asked for, or when autopilot mode is "auto". Before queueing more than 10 at once, confirm.
- If something needs the user (login, captcha, unknown question), say exactly what to do.
- Be concise. Use short markdown lists. Mention job ids only when useful for follow-ups.
${store.ONLINE ? `
You are running in the ONLINE version (no browser): searches run in the background and fill the board within 1-3 minutes,
Upwork search is unavailable, and you cannot submit applications. When the user wants to apply, give the job links as
markdown links (from get_job / list_jobs), offer a tailored cover letter, and remind them to press "Mark applied" afterwards.
Auto-apply runs only in the JobPilot app on their PC.
` : ''}
Current settings: autopilot ${s.autopilot.enabled ? 'ON' : 'off'} (mode ${s.autopilot.mode}), min score ${s.prefs.minScore},
keywords ${s.prefs.keywords.join(', ')}, kinds ${Object.keys(s.prefs.terms).filter((t) => s.prefs.terms[t]).join('/')}.

CANDIDATE PROFILE:
${getProfile()}`;
}

/**
 * Runs one user turn: the model may call tools several times before answering.
 * onEvent receives {type:'tool', name} while working.
 */
async function send(text, onEvent) {
  const history = [...store.chat, { role: 'user', content: text }];
  store.setChat(history);
  const messages = [{ role: 'system', content: systemPrompt() }, ...history.slice(-30)];

  for (let round = 0; round < 8; round++) {
    let msg;
    try {
      msg = await llm.complete({ messages, tools });
    } catch (e) {
      const reply = `⚠️ ${e.message}\n\nThe buttons on the jobs board still work without AI (search uses keyword scoring).`;
      store.setChat([...history, { role: 'assistant', content: reply }]);
      return reply;
    }
    messages.push(msg);
    if (!msg.tool_calls?.length) {
      store.setChat([...history, { role: 'assistant', content: msg.content || '' }]);
      return msg.content || '';
    }
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      onEvent?.({ type: 'tool', name });
      let result;
      try { result = await handlers[name](JSON.parse(call.function.arguments || '{}')); }
      catch (e) { result = { error: e.message }; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  const reply = 'I hit my step limit for this message. Ask me to continue.';
  store.setChat([...history, { role: 'assistant', content: reply }]);
  return reply;
}

module.exports = { send };
