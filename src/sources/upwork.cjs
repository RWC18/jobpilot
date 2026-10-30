// Upwork: search and send proposals in the logged-in Chrome window.
// Upwork has no public job API anymore, so both steps go through the browser.
const browser = require('../browser.cjs');
const llm = require('../llm.cjs');
const store = require('../store.cjs');
const { getProfile } = require('../profile.cjs');
const { fillForm, errorCount } = require('../apply/formfill.cjs');
const { classifyTerm, jitter, NeedsUser } = require('../util.cjs');

// t=1 fixed price (per project). t=0 hourly; duration_v3 splits short gigs from ongoing work.
const TERM_QUERY = {
  project: 't=1',
  short: 't=0&duration_v3=week,month',
  long: 't=0&duration_v3=semester,ongoing',
};

/** Job tiles from one search results page. */
async function tilesFrom(url, getPage) {
  const page = await getPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!(await browser.waitOutHumanCheck(page))) throw new NeedsUser('Upwork is showing a human check. Solve it once in the JobPilot Chrome window, then search again.');
  await page.waitForSelector('article[data-test="JobTile"], [data-test="job-tile-list"] section', { timeout: 15000 }).catch(() => {});
  return page.$$eval('article[data-test="JobTile"], [data-test="job-tile-list"] section', (els) => els.map((el) => {
    const a = el.querySelector('a[href*="/jobs/"]');
    return { href: a?.getAttribute('href') || '', title: (a?.innerText || '').trim(), text: el.innerText };
  }));
}

async function search({ keywords, terms, log }) {
  let page = null;
  const getPage = async () => (page ||= await browser.newPage());
  const out = [];
  try {
    for (const kw of keywords) {
      for (const term of Object.keys(TERM_QUERY).filter((t) => terms[t])) {
        const url = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(kw)}&sort=recency&per_page=20&${TERM_QUERY[term]}`;
        let tiles;
        try { tiles = await tilesFrom(url, getPage); }
        catch (e) {
          log?.(`Upwork search: ${e.message}`, 'warn');
          if (e instanceof NeedsUser) return out;
          continue;
        }
        for (const t of tiles) {
          const extId = (t.href.match(/~([0-9a-z]+)/i) || [])[1];
          if (!extId) continue;
          const pay = (t.text.match(/(Fixed price|Hourly)[^\n]*(\n[^\n]*(budget|\$)[^\n]*)?/i) || [''])[0].replace(/\s+/g, ' ').trim();
          out.push({
            id: 'upwork:' + extId,
            source: 'upwork',
            sourceGroup: 'upwork',
            extId,
            title: t.title,
            company: 'Upwork client',
            location: 'Remote',
            url: `https://www.upwork.com/jobs/~${extId}`,
            applyUrl: `https://www.upwork.com/ab/proposals/job/~${extId}/apply/`,
            pay,
            postedAt: new Date().toISOString(),
            term: term === 'project' ? 'project' : classifyTerm(term === 'short' ? 'contract' : 'full-time', t.text),
            description: t.text.slice(0, 4000),
          });
        }
        await jitter(2500, 6000);
      }
    }
  } finally {
    if (page) await page.close().catch(() => {});
  }
  const seen = new Set();
  return out.filter((j) => !seen.has(j.id) && seen.add(j.id));
}

async function writeProposal(job) {
  return llm.askText(
    `You write Upwork proposals for the freelancer in the profile. 120-180 words. Open with a line that shows you read the job,
then 2-3 concrete relevant results from the profile, a short plan for this job, and a question back to the client.
No greetings like "Dear Hiring Manager", no emojis, no placeholders. Sign with the freelancer's first name.`,
    `PROFILE:\n${getProfile()}\n\nJOB: ${job.title}\n${job.pay}\n${job.description}`,
  );
}

async function apply(job, { cvPath, log }) {
  const page = await browser.newPage();
  let keep = false;
  try {
    await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded' });
    if (!(await browser.waitOutHumanCheck(page))) throw new NeedsUser('Upwork is showing a human check. Solve it in the Chrome window.');
    if (/login|account-security/.test(page.url())) throw new NeedsUser('Log in to Upwork first (Settings → Connect Upwork).');
    await page.waitForSelector('textarea', { timeout: 20000 });

    const bodyText = await page.locator('body').innerText();
    if (/already submitted a proposal|you have already applied/i.test(bodyText)) return 'applied';
    const connects = Number((bodyText.match(/requires\s+(\d+)\s+Connects/i) || [])[1] || 0);
    const cap = store.settings.autopilot.upworkConnectsPerDay;
    if (connects && store.today().connects + connects > cap) {
      throw new NeedsUser(`Needs ${connects} Connects; today's limit (${cap}) would be passed.`);
    }

    // Prefer paying by project for fixed-price jobs.
    await page.locator('label:has-text("By project") input, input[value="default"]').first().evaluate((el) => el.click()).catch(() => {});

    const hourly = page.locator('#step-rate, input[data-test="currency-input"], input[aria-describedby*="rate" i]').first();
    if (job.term !== 'project' && (await hourly.isVisible().catch(() => false))) {
      await hourly.fill(String(store.settings.prefs.hourlyRate));
    }

    let letter;
    try { letter = await writeProposal(job); }
    catch (e) { throw new NeedsUser('AI is unavailable to write the proposal: ' + e.message.slice(0, 120)); }
    const coverBox = page.locator('textarea[aria-labelledby*="cover_letter" i], .cover-letter-area textarea, textarea').first();
    await coverBox.fill(letter);

    await fillForm(page, { job, cvPath, skipFiles: true });

    const send = page.locator('button:has-text("Send for"), button:has-text("Submit proposal"), button:has-text("Submit a proposal")').first();
    if (!(await send.isVisible().catch(() => false))) throw new NeedsUser('Could not find the Send button on the proposal page.');
    await send.click();
    await page.waitForTimeout(2500);

    // Fixed-price jobs ask to confirm the terms once more.
    const understand = page.locator('[role="dialog"] input[type="checkbox"]').first();
    if (await understand.isVisible().catch(() => false)) {
      await understand.check({ force: true }).catch(() => understand.evaluate((el) => el.click()));
      await page.locator('[role="dialog"] button:has-text("Submit"), [role="dialog"] button:has-text("Continue")').first().click();
      await page.waitForTimeout(2500);
    }
    if (await errorCount(page)) throw new NeedsUser('Upwork rejected a field on the proposal. Check the Chrome window.');
    if (connects) store.bumpToday('connects', connects);
    log?.(`Upwork proposal sent (${connects || '?'} Connects)`);
    return 'applied';
  } catch (e) {
    if (e instanceof NeedsUser) keep = true;
    throw e;
  } finally {
    if (!keep) await page.close().catch(() => {});
  }
}

module.exports = { search, apply, writeProposal };
