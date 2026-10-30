// Browser client for the JobPilot server: same shape the UI uses (window.jp).
// Live updates come from a server-sent event stream locally, or from polling on Netlify.
(function () {
  const listeners = { jobs: [], log: [], status: [], agent: [] };
  const emit = (name, data) => listeners[name].forEach((cb) => cb(data));
  const on = (name) => (cb) => listeners[name].push(cb);
  let pollSoon = () => {};

  async function call(route, body) {
    const res = await fetch(route, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/login.html'; throw new Error('Log in first'); }
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (body !== undefined) pollSoon();
    return data;
  }

  function startUpdates(live) {
    if (live) {
      const events = new EventSource('/events');
      for (const name of Object.keys(listeners)) {
        events.addEventListener(name, (e) => emit(name, JSON.parse(e.data)));
      }
      return;
    }
    // Poll every 5 s while something runs in the background, every 20 s otherwise; pause in hidden tabs.
    let lastLog = '';
    let busy = false;
    let timer = null;
    async function poll() {
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          const p = await call('/api/poll');
          emit('jobs', p.jobs);
          emit('status', p.status);
          const fresh = p.log.filter((e) => e.at + e.text > lastLog);
          fresh.forEach((e) => emit('log', e));
          if (p.log.length) lastLog = p.log[p.log.length - 1].at + p.log[p.log.length - 1].text;
          busy = p.status.searching;
        } catch { /* try again next tick */ }
      }
      timer = setTimeout(poll, busy ? 5000 : 20000);
    }
    pollSoon = () => { clearTimeout(timer); timer = setTimeout(poll, 1500); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollSoon(); });
    window.jp.seedLog = (entries) => { const e = entries[entries.length - 1]; if (e) lastLog = e.at + e.text; };
    timer = setTimeout(poll, 5000);
  }

  window.jp = {
    init: () => call('/api/init'),
    startUpdates,
    chat: (text) => call('/api/chat', { text }).then((r) => r.reply),
    clearChat: () => call('/api/clear-chat', {}),
    search: (opts) => call('/api/search', opts || {}),
    apply: (ids) => call('/api/apply', { ids }).then((r) => r.queued),
    setStatus: (ids, status) => call('/api/set-status', { ids, status }),
    openUrl: (url) => window.open(url, '_blank', 'noopener'),
    openCv: () => window.open('/cv', '_blank'),
    login: (site) => call('/api/login', { site }),
    openBrowser: () => call('/api/browser/open', {}),
    logout: () => call('/api/auth/logout', {}),
    runCycle: () => call('/api/run-cycle', {}),
    getSettings: () => call('/api/settings'),
    saveSettings: (patch) => call('/api/settings', patch),
    uploadCv: async (file) => {
      const res = await fetch('/api/cv', { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(file.name) }, body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      return data.cvPath;
    },
    onJobs: on('jobs'),
    onLog: on('log'),
    onStatus: on('status'),
    onAgentEvent: on('agent'),
  };
})();
