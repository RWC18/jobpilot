// Browser client for the JobPilot server: same shape the UI uses (window.jp).
(function () {
  async function call(route, body) {
    const res = await fetch(route, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/login.html'; throw new Error('Log in first'); }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const listeners = { jobs: [], log: [], status: [], agent: [] };
  const events = new EventSource('/events');
  for (const name of Object.keys(listeners)) {
    events.addEventListener(name, (e) => { const d = JSON.parse(e.data); listeners[name].forEach((cb) => cb(d)); });
  }
  const on = (name) => (cb) => listeners[name].push(cb);

  window.jp = {
    init: () => call('/api/init'),
    chat: (text) => call('/api/chat', { text }).then((r) => r.reply),
    clearChat: () => call('/api/clear-chat', {}),
    search: (opts) => call('/api/search', opts || {}).then((r) => r.added),
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
