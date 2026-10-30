// Runs the auto-apply engine against tools/test-form.html (local, nothing is sent anywhere).
// Uses a throwaway Chrome profile, so it can run while the server is running: node tools/test-apply.cjs
const path = require('path');
const os = require('os');
process.env.JOBPILOT_CHROME_PROFILE ||= path.join(os.tmpdir(), 'jobpilot-test-profile');
const external = require('../src/sources/external.cjs');
const browser = require('../src/browser.cjs');
const store = require('../src/store.cjs');

(async () => {
  const url = 'file:///' + path.join(__dirname, 'test-form.html').replace(/\\/g, '/');
  const job = { id: 'test:1', title: 'Frontend Engineer', company: 'Practice Co', applyUrl: url, description: 'React / Next.js role, remote.' };

  // Keep the page open after apply() so the submitted values can be read back.
  const pages = [];
  const newPage = browser.newPage;
  browser.newPage = async () => { const p = await newPage(); p.close = async () => {}; pages.push(p); return p; };

  try { console.log('apply() returned:', await external.apply(job, { cvPath: store.settings.cvPath })); }
  catch (e) { console.log('apply() stopped:', e.message); }
  for (const p of pages) console.log(await p.locator('body').innerText().catch(() => ''));
  await browser.close();
})();
