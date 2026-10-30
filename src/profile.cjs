// The candidate profile is a Markdown file the user can edit in Settings.
const fs = require('fs');
const path = require('path');
const store = require('./store.cjs');

const USER_FILE = path.join(store.DATA, 'profile.md');
const DEFAULT_FILE = path.join(store.ROOT, 'assets', 'profile.example.md');

function getProfile() {
  try { return fs.readFileSync(USER_FILE, 'utf8'); }
  catch { return fs.readFileSync(DEFAULT_FILE, 'utf8'); }
}

function setProfile(text) { fs.writeFileSync(USER_FILE, text); }

/** Pulls "Key: value" lines out of the profile for offline form filling. */
function facts() {
  const out = {};
  for (const line of getProfile().split('\n')) {
    const m = line.match(/^([A-Za-z][\w /()-]{1,50}):\s*(.+)$/);
    if (m) out[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return out;
}

module.exports = { getProfile, setProfile, facts };
