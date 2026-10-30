// LinkedIn: search through the public guest job API (no login needed),
// apply through Easy Apply in the logged-in Chrome window.
const { getText, decode, stripHtml, classifyTerm, jitter, NeedsUser } = require('../util.cjs');
const browser = require('../browser.cjs');
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

async function search({ keywords, location, remoteOnly, terms, log }) {
  const out = [];
  for (const kw of keywords) {
    for (const term of Object.keys(TERM_FILTERS).filter((t) => terms[t])) {
      if (term === 'project' && terms.short) continue; // same LinkedIn filter as contract
      const q = new URLSearchParams({
        keywords: kw,
        location: location || 'Worldwide',
        f_AL: 'true', // Easy Apply only
        f_JT: TERM_FILTERS[term],
        f_TPR: 'r604800', // past week
        start: '0',
      });
      if (remoteOnly) q.set('f_WT', '2');
      try {
        const html = await getText('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?' + q);
        out.push(...parseCards(html, term));
      } catch (e) { log?.(`LinkedIn search "${kw}" failed: ${e.message}`, 'warn'); }
      await jitter(800, 1800);
    }
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

/** Walks through the Easy Apply dialog. Returns 'applied' or throws NeedsUser with the reason. */
async function apply(job, { cvPath, log }) {
  const page = await browser.newPage();
  let keep = false;
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    if (/\/(login|authwall|checkpoint|uas)/.test(page.url())) throw new NeedsUser('Log in to LinkedIn first (Settings → Connect LinkedIn).');
    if (await browser.hasHumanCheck(page)) throw new NeedsUser('LinkedIn is showing a security check. Solve it in the JobPilot Chrome window.');

    const applied = page.locator('.artdeco-inline-feedback--success:has-text("Applied")').first();
    if (await applied.isVisible().catch(() => false)) return 'applied';

    const btn = page.locator('button.jobs-apply-button:visible, button:has-text("Easy Apply"):visible').first();
    if (!(await btn.isVisible().catch(() => false))) throw new NeedsUser('No Easy Apply button (job closed or applies on company site).');
    await btn.click();

    const modal = '.jobs-easy-apply-modal, [data-test-modal][role="dialog"], div[role="dialog"]';
    await page.waitForSelector(modal, { timeout: 10000 });
    let lastHeading = '';
    let sameStep = 0;

    for (let step = 0; step < 15; step++) {
      await page.waitForTimeout(1200);
      const hasResume = await page.locator(`${modal} .jobs-document-upload-redesign-card__container--selected, ${modal} [aria-label*="Selected" i][aria-label*="resume" i]`).count();
      await fillForm(page, { scopeSel: '.jobs-easy-apply-modal, div[role="dialog"]', job, cvPath, skipFiles: hasResume > 0 });

      // Don't follow the company as a side effect of applying.
      const follow = page.locator(`${modal} input#follow-company-checkbox`);
      if (await follow.isChecked().catch(() => false)) await follow.evaluate((el) => el.click());

      const submit = page.locator(`${modal} button:has-text("Submit application")`).first();
      if (await submit.isVisible().catch(() => false)) {
        await submit.click();
        await page.waitForTimeout(3000);
        await page.locator('button[aria-label="Dismiss"], button:has-text("Done")').first().click().catch(() => {});
        return 'applied';
      }
      const next = page.locator(`${modal} button:has-text("Review"), ${modal} button:has-text("Next"), ${modal} button:has-text("Continue")`).first();
      if (!(await next.isVisible().catch(() => false))) throw new NeedsUser('Could not find the Next button in Easy Apply.');
      await next.click();
      await page.waitForTimeout(1500);

      const heading = await page.locator(`${modal} h3, ${modal} h2`).first().innerText().catch(() => '');
      const progress = await page.locator(`${modal} [role="progressbar"]`).getAttribute('aria-valuenow').catch(() => '');
      const key = heading + progress;
      sameStep = key === lastHeading ? sameStep + 1 : 0;
      lastHeading = key;
      if (sameStep >= 2 && (await errorCount(page, '.jobs-easy-apply-modal'))) {
        throw new NeedsUser('Easy Apply has a question the agent could not answer. Finish it in the Chrome window.');
      }
    }
    throw new NeedsUser('Easy Apply has too many steps.');
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
