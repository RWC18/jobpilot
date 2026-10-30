// Mirrors the app's data files (normally in data/) between a function's /tmp folder and Netlify Blobs.
// pull() before handling a request, push() after. Jobs and the log are merged on push, because the
// background worker and the API function can save them at the same time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILES = ['settings.json', 'jobs.json', 'answers.json', 'chat.json', 'log.json', 'daily.json', 'runtime.json', 'profile.md'];
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');

export function createSync(blobs, dataDir) {
  const seen = new Map(); // file -> hash of the version last pulled or pushed
  let pushing = Promise.resolve();

  async function pull() {
    fs.mkdirSync(dataDir, { recursive: true });
    await Promise.all(FILES.map(async (name) => {
      const text = await blobs.get(name);
      const file = path.join(dataDir, name);
      if (text == null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, text);
      seen.set(name, text == null ? null : hash(text));
    }));
  }

  async function pushNow() {
    for (const name of FILES) {
      const file = path.join(dataDir, name);
      if (!fs.existsSync(file)) continue;
      let text = fs.readFileSync(file, 'utf8');
      if (hash(text) === seen.get(name)) continue;
      if (name === 'jobs.json' || name === 'log.json') {
        const remote = await blobs.get(name);
        if (remote != null && hash(remote) !== seen.get(name)) text = merge(name, JSON.parse(remote), JSON.parse(text));
      }
      await blobs.set(name, text);
      seen.set(name, hash(text));
    }
  }

  /** Saves changed files; calls are queued so two pushes never interleave. */
  function push() {
    pushing = pushing.then(pushNow, pushNow);
    return pushing;
  }

  return { pull, push };
}

function merge(name, remote, local) {
  if (name === 'jobs.json') {
    const out = { ...remote };
    for (const [id, job] of Object.entries(local)) {
      const other = remote[id];
      if (!other || (job.updatedAt || '') >= (other.updatedAt || '')) out[id] = job;
    }
    return JSON.stringify(out);
  }
  const keys = new Set();
  const entries = [...remote, ...local]
    .filter((e) => { const k = e.at + e.text; return keys.has(k) ? false : keys.add(k); })
    .sort((a, b) => a.at.localeCompare(b.at));
  return JSON.stringify(entries.slice(-500));
}
