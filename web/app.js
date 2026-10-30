const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const SOURCE_NAMES = { linkedin: 'LinkedIn', upwork: 'Upwork', remotive: 'Remotive', remoteok: 'RemoteOK', wwr: 'We Work Remotely' };
const TERM_NAMES = { long: 'Long term', short: 'Short term', project: 'Project pay' };
const STATUS_NAMES = { new: 'New', shortlisted: 'Shortlisted', queued: 'Queued', applying: 'Applying…', applied: 'Applied', needs_you: 'Needs you', failed: 'Failed', skipped: 'Skipped' };
const INBOX = ['new', 'shortlisted'];
const TOOL_LABELS = {
  search_jobs: 'Searching job sites…', rescore_jobs: 'Re-scoring jobs with AI…', list_jobs: 'Looking through jobs…', get_job: 'Reading the posting…',
  apply_to_jobs: 'Queueing applications…', skip_jobs: 'Skipping…', write_cover_letter: 'Writing a cover letter…',
  set_autopilot: 'Updating autopilot…', update_preferences: 'Saving preferences…', get_status: 'Checking status…', open_login: 'Opening login…',
};

const state = {
  jobs: [],
  status: null,
  settings: null,
  term: 'all',
  view: 'inbox',
  q: '',
  minScore: 0,
  selected: new Set(),
  busy: false,
};

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Small, safe markdown: paragraphs, lists, bold, italics, code, links. */
function md(text) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext>$1</a>');
  const out = [];
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)/);
    out.push(h ? `<p><b>${inline(h[1])}</b></p>` : `<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

function ago(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(d)) return '';
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------- chat ----------

const messagesEl = $('#messages');

function addMessage(role, content) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (role === 'assistant') el.innerHTML = md(content);
  else el.textContent = content;
  messagesEl.append(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function renderChat(history) {
  messagesEl.innerHTML = '';
  const visible = history.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content);
  if (!visible.length) {
    const first = ((state.settings?.profile || '').match(/^First name:\s*(.+)$/m) || [])[1];
    messagesEl.innerHTML = `<div class="welcome"><b>Hi${first ? ' ' + esc(first.trim()) : ''} 👋</b><br>${state.online ? 'I search LinkedIn and remote job boards and rank jobs against your profile. Open a job to apply, then mark it applied. (Auto-apply runs in the JobPilot app on your PC.)' : 'I search LinkedIn, Upwork and remote job boards, rank jobs against your CV and apply for you.'}
      Tell me what you want — long term, short term or paid per project — or pick a suggestion below.</div>`;
  }
  for (const m of visible) addMessage(m.role, m.content);
}

async function sendChat(text) {
  text = text.trim();
  if (!text || state.busy) return;
  if (messagesEl.querySelector('.welcome')) messagesEl.innerHTML = '';
  state.busy = true;
  addMessage('user', text);
  const thinking = document.createElement('div');
  thinking.className = 'msg assistant thinking';
  thinking.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span>Thinking…</span>';
  messagesEl.append(thinking);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  $('#agentSub').textContent = 'Working…';
  try {
    const reply = await window.jp.chat(text);
    thinking.remove();
    addMessage('assistant', reply);
  } catch (e) {
    thinking.remove();
    addMessage('assistant', '⚠️ ' + e.message);
  } finally {
    state.busy = false;
    $('#agentSub').textContent = 'Ask me to find or apply to jobs';
  }
}

window.jp.onAgentEvent((ev) => {
  const t = messagesEl.querySelector('.thinking span:last-child');
  if (t && ev.type === 'tool') t.textContent = TOOL_LABELS[ev.name] || 'Working…';
});

const input = $('#input');
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; autosize(); sendChat(v); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
input.addEventListener('input', autosize);
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; }
$('#quick').addEventListener('click', (e) => { if (e.target.matches('button')) sendChat(e.target.textContent); });
$('#clearChat').addEventListener('click', async () => { await window.jp.clearChat(); renderChat([]); });
messagesEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-ext]');
  if (a) { e.preventDefault(); window.jp.openUrl(a.href); }
});

// ---------- jobs board ----------

function inView(j) {
  if (state.view === 'inbox') return INBOX.includes(j.status);
  if (state.view === 'queued') return j.status === 'queued' || j.status === 'applying';
  return j.status === state.view;
}

function filtered() {
  const q = state.q.toLowerCase();
  return state.jobs
    .filter(inView)
    .filter((j) => state.term === 'all' || j.term === state.term)
    .filter(passesMin)
    .filter((j) => !q || `${j.title} ${j.company} ${j.location} ${j.source}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (state.view === 'applied') return (b.appliedAt || '').localeCompare(a.appliedAt || '');
      if (a.status === 'shortlisted' && b.status !== 'shortlisted') return -1;
      if (b.status === 'shortlisted' && a.status !== 'shortlisted') return 1;
      return (b.score ?? -1) - (a.score ?? -1);
    });
}

const passesMin = (j) => state.view !== 'inbox' || (j.score ?? 0) >= state.minScore;

function renderCounts() {
  const base = state.jobs.filter(inView).filter(passesMin);
  for (const b of $$('#termTabs button')) {
    const t = b.dataset.term;
    const n = t === 'all' ? base.length : base.filter((j) => j.term === t).length;
    b.innerHTML = `${TERM_NAMES[t] || 'All'} <span class="n">${n}</span>`;
  }
  const byStatus = (pred) => state.jobs.filter((j) => (state.term === 'all' || j.term === state.term) && pred(j)).length;
  const counts = {
    inbox: byStatus((j) => INBOX.includes(j.status) && (j.score ?? 0) >= state.minScore),
    queued: byStatus((j) => j.status === 'queued' || j.status === 'applying'),
    applied: byStatus((j) => j.status === 'applied'),
    needs_you: byStatus((j) => j.status === 'needs_you'),
    failed: byStatus((j) => j.status === 'failed'),
    skipped: byStatus((j) => j.status === 'skipped'),
  };
  for (const b of $$('#statusTabs button')) {
    const n = counts[b.dataset.status];
    b.innerHTML = `${b.dataset.label || (b.dataset.label = b.textContent)}<b>${n || ''}</b>`;
  }
}

const tpl = $('#jobTpl');
function jobCard(j) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.id = j.id;
  el.classList.toggle('sel', state.selected.has(j.id));
  $('.pick input', el).checked = state.selected.has(j.id);

  const score = j.score ?? null;
  const ring = $('.ring', el);
  ring.classList.add(score == null ? 'low' : score >= 75 ? 'hi' : score >= 50 ? 'mid' : 'low');
  $('.ring .val', el).style.strokeDashoffset = 97.4 * (1 - (score ?? 0) / 100);
  $('.ring span', el).textContent = score ?? '–';

  const title = $('.title', el);
  title.textContent = j.title || 'Untitled';
  title.href = j.url;
  $('.meta', el).textContent = [j.company, j.location, ago(j.postedAt)].filter(Boolean).join(' · ');
  const why = $('.why', el);
  if (j.note && ['needs_you', 'failed', 'queued'].includes(j.status)) { why.textContent = j.note; why.classList.add('note'); }
  else why.textContent = j.scoreReason || '';

  $('.tags', el).innerHTML = [
    `<span class="tag">${esc(SOURCE_NAMES[j.source] || j.source)}</span>`,
    j.term ? `<span class="tag ${j.term}">${TERM_NAMES[j.term]}</span>` : '',
    j.pay ? `<span class="tag pay" title="${esc(j.pay)}">${esc(j.pay)}</span>` : '',
  ].join('');

  const pill = $('.pill', el);
  pill.textContent = j.status === 'applied' && j.appliedAt ? `Applied ${ago(j.appliedAt)}` : STATUS_NAMES[j.status] || j.status;
  pill.classList.add(j.status);

  const applyBtn = $('.act-apply', el);
  const skipBtn = $('.act-skip', el);
  if (j.status === 'applied' || j.status === 'applying' || j.status === 'queued') { applyBtn.remove(); skipBtn.remove(); }
  if (j.status === 'needs_you' || j.status === 'failed') applyBtn.textContent = 'Retry';
  if (state.online) applyBtn.textContent = 'Mark applied';
  if (j.status === 'skipped') { skipBtn.textContent = 'Restore'; applyBtn.remove(); }
  return el;
}

function renderJobs() {
  renderCounts();
  const list = filtered();
  const box = $('#jobs');
  box.innerHTML = '';
  if (!list.length) {
    const empty = state.jobs.length === 0;
    box.innerHTML = `<div class="empty"><div class="big"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></div>
      <b>${empty ? 'No jobs yet' : 'Nothing here'}</b>${empty ? 'Press <i>Search now</i> or ask the agent to find jobs.' : 'Try another tab or lower the minimum match.'}</div>`;
  } else {
    const frag = document.createDocumentFragment();
    for (const j of list.slice(0, 300)) frag.append(jobCard(j));
    box.append(frag);
  }
  renderBulk();
}

function renderBulk() {
  const n = state.selected.size;
  $('#bulk').hidden = n === 0;
  $('#bulkCount').textContent = `${n} selected`;
}

$('#jobs').addEventListener('click', async (e) => {
  const card = e.target.closest('.job');
  if (!card) return;
  const id = card.dataset.id;
  const job = state.jobs.find((j) => j.id === id);
  if (e.target.closest('.title')) { e.preventDefault(); window.jp.openUrl(job.url); return; }
  if (e.target.closest('.act-apply')) {
    if (state.online) { await window.jp.setStatus([id], 'applied'); toast('Marked as applied'); return; }
    await window.jp.apply([id]);
    toast('Queued — applying shortly');
    return;
  }
  if (e.target.closest('.act-skip')) { await window.jp.setStatus([id], job.status === 'skipped' ? 'new' : 'skipped'); return; }
  if (e.target.matches('.pick input')) {
    if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
    card.classList.toggle('sel', e.target.checked);
    renderBulk();
  }
});

$('#termTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.term = b.dataset.term;
  $$('#termTabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderJobs();
});
$('#statusTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.view = b.dataset.status;
  state.selected.clear();
  $$('#statusTabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderJobs();
});
$('#filterText').addEventListener('input', (e) => { state.q = e.target.value; renderJobs(); });
$('#minScore').addEventListener('input', (e) => { state.minScore = +e.target.value; $('#minScoreVal').textContent = state.minScore; renderJobs(); });

$('#bulkClear').addEventListener('click', () => { state.selected.clear(); renderJobs(); });
$('#bulkSkip').addEventListener('click', async () => { await window.jp.setStatus([...state.selected], 'skipped'); state.selected.clear(); renderBulk(); });
$('#bulkApply').addEventListener('click', async () => {
  if (state.online) {
    await window.jp.setStatus([...state.selected], 'applied');
    toast(`${state.selected.size} marked as applied`);
    state.selected.clear();
    renderBulk();
    return;
  }
  const n = await window.jp.apply([...state.selected]);
  state.selected.clear();
  renderBulk();
  toast(`${n} applications queued`);
});

$('#searchBtn').addEventListener('click', async () => {
  try {
    const r = await window.jp.search();
    toast(r.started ? 'Searching in the background; new jobs appear in 1-3 minutes' : r.note || `${r.added} new jobs found`);
  } catch (err) { toast(err.message); }
});

// ---------- status / autopilot ----------

function renderStatus(s) {
  state.status = s;
  const ap = s.autopilot;
  const mode = ap.enabled ? ap.mode : 'off';
  $$('#apSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.ap === mode); b.setAttribute('aria-checked', b.dataset.ap === mode); });
  $('#apState').textContent = s.cycle ? 'running a cycle…' : ap.enabled ? `every ${ap.intervalMin} min` : '';

  $('#meters').hidden = state.online;
  $('#meters').innerHTML = [['linkedin', 'LinkedIn'], ['upwork', 'Upwork'], ['remote', 'Remote']].map(([k, label]) => {
    const used = s.today[k] || 0;
    const cap = s.caps[k] || 0;
    return `<div class="meter" title="Applications today / daily limit"><div class="top"><span>${label}</span><b>${used}/${cap}</b></div>
      <div class="bar"><i style="width:${cap ? Math.min(100, (used / cap) * 100) : 0}%"></i></div></div>`;
  }).join('');

  const btn = $('#searchBtn');
  btn.disabled = s.searching;
  btn.innerHTML = s.searching ? '<span class="spin"></span><span>Searching…</span>'
    : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>Search now</span>';
}

$('#apSeg').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const v = b.dataset.ap;
  if (v === 'auto' && !confirm('Auto-apply sends applications without asking you, within the daily limits in Settings. Turn it on?')) return;
  await window.jp.saveSettings({ autopilot: v === 'off' ? { enabled: false } : { enabled: true, mode: v } });
  toast(v === 'off' ? 'Autopilot off' : v === 'auto' ? 'Auto-apply on' : 'Shortlist mode on');
});

// ---------- activity ----------

function addLog(entry) {
  const li = document.createElement('li');
  li.className = entry.level;
  li.innerHTML = `<time>${new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span>${esc(entry.text)}</span>`;
  const ol = $('#log');
  ol.prepend(li);
  while (ol.children.length > 200) ol.lastChild.remove();
  $('#liveLine').textContent = entry.text;
}

// ---------- settings ----------

const form = $('#settingsForm');
const F = (name) => form.elements[name];

async function openSettings() {
  const s = await window.jp.getSettings();
  state.settings = s;
  F('keywords').value = s.prefs.keywords.join('\n');
  F('location').value = s.prefs.location;
  F('remoteOnly').checked = s.prefs.remoteOnly;
  for (const t of ['long', 'short', 'project']) F('term_' + t).checked = s.prefs.terms[t];
  for (const k of ['linkedin', 'upwork', 'remote']) F('src_' + k).checked = s.prefs.sources[k];
  F('hourlyRate').value = s.prefs.hourlyRate;
  F('minScore').value = s.prefs.minScore;
  F('excludeWords').value = s.prefs.excludeWords.join(', ');
  for (const k of ['linkedin', 'upwork', 'remote']) F('cap_' + k).value = s.autopilot.dailyCaps[k];
  F('intervalMin').value = s.autopilot.intervalMin;
  F('delayMin').value = s.autopilot.delaySec[0];
  F('delayMax').value = s.autopilot.delaySec[1];
  F('upworkConnectsPerDay').value = s.autopilot.upworkConnectsPerDay;
  F('profile').value = s.profile;
  F('openaiApiKey').value = s.openaiApiKey;
  F('chatModel').value = s.chatModel;
  F('fastModel').value = s.fastModel;
  $('#cvPath').textContent = s.cvPath;
  $('#scrim').hidden = false;
  $('#drawer').hidden = false;
}

function closeSettings() { $('#scrim').hidden = true; $('#drawer').hidden = true; }

async function saveSettings() {
  const lines = (v) => v.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
  const lo = +F('delayMin').value || 60;
  const settings = await window.jp.saveSettings({
    prefs: {
      keywords: lines(F('keywords').value),
      location: F('location').value.trim() || 'Worldwide',
      remoteOnly: F('remoteOnly').checked,
      terms: { long: F('term_long').checked, short: F('term_short').checked, project: F('term_project').checked },
      sources: { linkedin: F('src_linkedin').checked, upwork: F('src_upwork').checked, remote: F('src_remote').checked },
      hourlyRate: +F('hourlyRate').value || 35,
      minScore: +F('minScore').value || 0,
      excludeWords: lines(F('excludeWords').value),
    },
    autopilot: {
      dailyCaps: { linkedin: +F('cap_linkedin').value, upwork: +F('cap_upwork').value, remote: +F('cap_remote').value },
      intervalMin: Math.max(15, +F('intervalMin').value || 60),
      delaySec: [lo, Math.max(lo, +F('delayMax').value || lo)],
      upworkConnectsPerDay: +F('upworkConnectsPerDay').value,
    },
    profile: F('profile').value,
    openaiApiKey: F('openaiApiKey').value,
    chatModel: F('chatModel').value.trim(),
    fastModel: F('fastModel').value.trim(),
  });
  state.settings = settings;
  setMinScore(settings.prefs.minScore);
  closeSettings();
  toast('Settings saved');
}

$('#settingsBtn').addEventListener('click', openSettings);
$('#closeDrawer').addEventListener('click', closeSettings);
$('#cancelSettings').addEventListener('click', closeSettings);
$('#scrim').addEventListener('click', closeSettings);
$('#saveSettings').addEventListener('click', saveSettings);
$('#openCv').addEventListener('click', () => window.jp.openCv());
$('#pickCv').addEventListener('click', () => $('#cvFile').click());
$('#cvFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try { $('#cvPath').textContent = await window.jp.uploadCv(file); toast('CV uploaded'); }
  catch (err) { toast(err.message); }
  e.target.value = '';
});
$$('[data-login]').forEach((b) => b.addEventListener('click', async () => {
  await window.jp.login(b.dataset.login);
  if (state.remote) { closeSettings(); openViewer(); }
  else toast('Sign in in the Chrome window that opened');
}));

// ---------- remote browser (deployed version) ----------

async function openViewer() {
  await window.jp.openBrowser();
  const frame = $('#viewerFrame');
  if (!frame.src) frame.src = 'browser.html';
  $('#viewerScrim').hidden = false;
  $('#viewer').hidden = false;
}
function closeViewer() { $('#viewerScrim').hidden = true; $('#viewer').hidden = true; }
$('#browserBtn').addEventListener('click', openViewer);
$('#closeViewer').addEventListener('click', closeViewer);
$('#viewerScrim').addEventListener('click', closeViewer);
$('#logoutBtn').addEventListener('click', async () => { await window.jp.logout(); location.href = '/login.html'; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeSettings(); });

function setMinScore(v) {
  state.minScore = v;
  $('#minScore').value = v;
  $('#minScoreVal').textContent = v;
}

// ---------- boot ----------

(async function boot() {
  const data = await window.jp.init();
  state.jobs = data.jobs;
  state.settings = data.settings;
  state.remote = data.remoteBrowser;
  state.online = data.online;
  if (data.online) {
    // No browser online: applying happens in the PC app, so hide what drives it.
    $('#apSeg [data-ap="auto"]').hidden = true;
    $('#bulkApply').textContent = 'Mark applied';
    for (const id of ['#secAccounts', '#secLimits', '#srcUpwork']) $(id).hidden = true;
  }
  $('#browserBtn').hidden = !data.remoteBrowser;
  $('#logoutBtn').hidden = !data.canLogout;
  setMinScore(data.settings.prefs.minScore);
  renderChat(data.chat);
  renderStatus(data.status);
  data.log.forEach(addLog);
  renderJobs();
  window.jp.startUpdates(data.live);
  window.jp.seedLog?.(data.log);

  let pending = null;
  window.jp.onJobs((jobs) => {
    state.jobs = jobs;
    // Updates come in bursts while scoring; redraw at most every 250 ms.
    clearTimeout(pending);
    pending = setTimeout(renderJobs, 250);
  });
  window.jp.onStatus(renderStatus);
  window.jp.onLog(addLog);
})();
