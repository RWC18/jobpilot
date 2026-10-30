// LinkedIn: search in the logged-in Chrome window (falls back to the public guest job API),
// apply through Easy Apply in the same window.
const { getText, decode, stripHtml, classifyTerm, jitter, NeedsUser } = require('../util.cjs');
const browser = require('../browser.cjs');
const store = require('../store.cjs');
const { fillForm, errorCount } = require('../apply/formfill.cjs');

// f_JT codes: F full-time, C contract, T temporary, P part-time. LinkedIn has no per-project type, so contract covers it.
const TERM_FILTERS = { long: 'F', short: 'C,T,P', project: 'C' };

function parseCards(html, term) {
  const jobs = [];
  for (const m of html.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const card = m[1];
    const id = (card.match(/urn:li:jobPosting:(\d+)/) || [])[1];
    if (!id) continue;
    const grab = (cls) => decode(((card.match(new RegExp(`class="${cls}[^"]*"[^>]*>([\\s\\S]*?)</`)) || [])[1] || '').replace(/<[^>]+>/g, '').trim());
    jobs.push({
      id: 'linkedin:' + id,
      source: 'linkedin',
      sourceGroup: 'linkedin',
      extId: id,
      title: grab('base-search-card__title'),
      company: grab('hidden-nested-link') || grab('base-search-card__subtitle'),
      location: grab('job-search-card__location'),
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      applyUrl: `https://www.linkedin.com/jobs/view/${id}/`,
      pay: grab('job-search-card__salary-info'),
      postedAt: (card.match(/datetime="([^"]+)"/) || [])[1] || '',
      term,
      easyApply: true,
    });
  }
  return jobs;
}

/**
 * Logged-in search in the JobPilot Chrome. Unlike the guest API it honours the remote filter.
 * Returns null when LinkedIn wants a login, so the caller can fall back to the guest API.
 */
async function searchLoggedIn(page, q, term) {
  await page.goto('https://www.linkedin.com/jobs/search/?' + q, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  if (/\/(login|authwall|checkpoint|uas)/.test(page.url())) return null;
  // The result list loads more cards as it scrolls.
  await page.evaluate(async () => {
    const first = document.querySelector('[data-occludable-job-id]');
    let box = first?.parentElement;
    while (box && box !== document.body && !(box.scrollHeight > box.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    for (let i = 0; i < 14; i++) { (box && box !== document.body ? box : window).scrollBy(0, 500); await new Promise((r) => setTimeout(r, 350)); }
  });
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-occludable-job-id]')].map((el) => ({
    id: el.getAttribute('data-occludable-job-id'),
    lines: el.innerText.split('\n').map((t) => t.trim()).filter(Boolean),
  })));
  return cards.filter((c) => c.lines.length >= 3).map(({ id, lines }) => {
    const rest = lines.filter((l, i) => i > 0 && !/with verification$/i.test(l) && l !== lines[0]);
    const location = rest.find((l) => /\((remote|hybrid|on-site)\)|remote|, /i.test(l)) || rest[1] || '';
    return {
      id: 'linkedin:' + id,
      source: 'linkedin',
      sourceGroup: 'linkedin',
      extId: id,
      title: lines[0],
      company: rest[0] || '',
      location,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      applyUrl: `https://www.linkedin.com/jobs/view/${id}/`,
      pay: rest.find((l) => /[$€£]\s?\d|\/(hr|yr|mo)\b/i.test(l)) || '',
      postedAt: new Date().toISOString(),
      term,
      easyApply: lines.some((l) => /easy apply/i.test(l)),
    };
  }).filter((j) => j.easyApply);
}

async function search({ keywords, location, remoteOnly, terms, log }) {
  const out = [];
  // Use the logged-in Chrome when there is one (the PC app); the online version only has the guest API.
  let page = null;
  let loggedIn = !store.ONLINE;
  try {
    for (const kw of keywords) {
      for (const term of Object.keys(TERM_FILTERS).filter((t) => terms[t])) {
        if (term === 'project' && terms.short) continue; // same LinkedIn filter as contract
        const q = new URLSearchParams({
          keywords: kw,
          location: location || 'Worldwide',
          f_AL: 'true', // Easy Apply only
          f_JT: TERM_FILTERS[term],
          f_TPR: 'r604800', // past week
        });
        if (remoteOnly) q.set('f_WT', '2');
        if (!location || /worldwide/i.test(location)) q.set('geoId', '92000000');
        try {
          if (loggedIn) {
            page ||= await browser.newPage();
            const jobs = await searchLoggedIn(page, q, term);
            if (jobs) { out.push(...jobs); await jitter(2500, 5000); continue; }
            loggedIn = false;
            log?.('Not logged in to LinkedIn in the JobPilot Chrome; using the public search (it ignores the remote filter).', 'warn');
          }
          q.set('start', '0');
          const html = await getText('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?' + q);
          out.push(...parseCards(html, term));
        } catch (e) { log?.(`LinkedIn search "${kw}" failed: ${e.message}`, 'warn'); }
        await jitter(800, 1800);
      }
    }
  } finally {
    if (page) await page.close().catch(() => {});
  }
  const seen = new Set();
  return out.filter((j) => !seen.has(j.id) && seen.add(j.id));
}

/** Fetches the full description + employment type from the guest job page. */
async function details(job) {
  const html = await getText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${job.extId}`);
  const desc = (html.match(/class="description__text[^"]*"[^>]*>([\s\S]*?)(<button|<ul class="description__job-criteria-list)/) || [])[1] || '';
  const criteria = {};
  for (const m of html.matchAll(/criteria-subheader">\s*([\s\S]*?)\s*<\/h3>\s*<span[^>]*>\s*([\s\S]*?)\s*<\/span>/g)) {
    criteria[decode(m[1]).trim()] = decode(m[2]).trim();
  }
  const description = stripHtml(desc).slice(0, 6000);
  const type = criteria['Employment type'] || '';
  return { description, seniority: criteria['Seniority level'] || '', term: type ? classifyTerm(type, description) : job.term };
}

// LinkedIn's 2026 design uses scrambled class names, so buttons are found by their accessible names
// (English first, Russian as a fallback) and the Easy Apply window is a native <dialog>.
const BTN = {
  easyApply: /easy apply|простая подача заявки/i,
  next: /^(next|continue|далее|продолжить)$/i,
  review: /^(review|проверить)$/i,
  submit: /^(submit application|submit|отправить заявку|отправить)$/i,
  done: /^(done|dismiss|готово|закрыть)$/i,
};
const DIALOG = 'dialog[open], [role="dialog"]';

/** Walks through the Easy Apply dialog. Returns 'applied' or throws NeedsUser with the reason. */
async function apply(job, { cvPath, log, dryRun = false }) {
  const page = await browser.newPage();
  let keep = false;
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    if (/\/(login|authwall|checkpoint|uas)/.test(page.url())) throw new NeedsUser('Log in to LinkedIn first (Settings → Connect LinkedIn).');
    if (await browser.hasHumanCheck(page)) throw new NeedsUser('LinkedIn is showing a security check. Solve it in the JobPilot Chrome window.');

    const topText = await page.locator('main').first().innerText().catch(() => '');
    if (/\bApplied (\d+|on)\b|Application submitted|Вы откликнулись|Заявка отправлена/i.test(topText.slice(0, 1500))) return 'applied';

    const btn = page.getByRole('button', { name: BTN.easyApply }).first();
    if (!(await btn.isVisible().catch(() => false))) throw new NeedsUser('No Easy Apply button (job closed or applies on the company site).');
    await btn.click();

    const dialog = page.locator(DIALOG).first();
    await dialog.waitFor({ timeout: 10000 });
    let lastKey = '';
    let sameStep = 0;

    for (let step = 0; step < 15; step++) {
      await page.waitForTimeout(1300);
      // Resumes uploaded before are listed by file name; pick those instead of uploading a duplicate.
      const dialogText = await dialog.innerText().catch(() => '');
      await fillForm(page, { scopeSel: 'dialog[open]', job, cvPath, skipFiles: /\.pdf|\.docx/i.test(dialogText) });

      // Don't follow the company as a side effect of applying.
      const follow = dialog.getByRole('checkbox', { name: /follow|подпис/i }).first();
      if (await follow.isChecked().catch(() => false)) await follow.evaluate((el) => el.click());

      const submit = dialog.getByRole('button', { name: BTN.submit }).first();
      if (await submit.isVisible().catch(() => false)) {
        if (dryRun) {
          // Test mode: everything is filled in; close without sending.
          log?.(`Dry run: ready to submit ${job.title}; closing without sending.`);
          await dialog.getByRole('button', { name: /^(dismiss|закрыть)$/i }).first().click();
          await page.locator(DIALOG).getByRole('button', { name: /^(discard|не сохранять|удалить)$/i }).first().click().catch(() => {});
          return 'dry-run';
        }
        await submit.click();
        await page.waitForTimeout(3500);
        await page.locator(DIALOG).getByRole('button', { name: BTN.done }).first().click().catch(() => {});
        return 'applied';
      }
      const next = dialog.getByRole('button', { name: BTN.review }).or(dialog.getByRole('button', { name: BTN.next })).first();
      if (!(await next.isVisible().catch(() => false))) throw new NeedsUser('Could not find the Next button in Easy Apply. Finish it in the Chrome window.');
      await next.click();
      await page.waitForTimeout(1500);

      const text = await dialog.innerText().catch(() => '');
      const key = ((text.match(/(\d+)\s*\/\s*(\d+)/) || [''])[0]) + text.split('\n').slice(0, 6).join('|');
      sameStep = key === lastKey ? sameStep + 1 : 0;
      lastKey = key;
      if (sameStep >= 2 && (await errorCount(page, 'dialog[open]'))) {
        throw new NeedsUser('Easy Apply has a question the agent could not answer. Finish it in the Chrome window.');
      }
    }
    throw new NeedsUser('Easy Apply has too many steps. Finish it in the Chrome window.');
  } catch (e) {
    // Leave the tab open when the user has to finish something.
    if (e instanceof NeedsUser) keep = true;
    else log?.(`LinkedIn apply error: ${e.message}`, 'warn');
    throw e;
  } finally {
    if (!keep) await page.close().catch(() => {});
  }
}

module.exports = { search, details, apply };
