// Applies on a company's own careers page (Greenhouse, Lever, Ashby, Workable, plain forms),
// which is where Remotive / RemoteOK / We Work Remotely listings send you.
const browser = require('../browser.cjs');
const { fillForm, errorCount } = require('../apply/formfill.cjs');
const { NeedsUser } = require('../util.cjs');

const APPLY_LINK = 'a:has-text("Apply for this"), a:has-text("Apply now"), a:has-text("Apply"), button:has-text("Apply for this"), button:has-text("Apply now"), button:has-text("Apply")';
const SUBMIT = 'button[type="submit"]:visible, input[type="submit"]:visible, button:has-text("Submit application"):visible, button:has-text("Submit"):visible';
const DONE_TEXT = /thank you for (applying|your application)|application (has been )?(received|submitted)|we('ve| have) received your application|successfully applied/i;

/** Follows "Apply" buttons (which may open new tabs) until a page with a form appears. */
async function reachForm(page) {
  for (let hop = 0; hop < 3; hop++) {
    const inputs = await page.locator('form input:visible, form textarea:visible').count();
    if (inputs >= 3) return page;
    const link = page.locator(APPLY_LINK).first();
    if (!(await link.isVisible().catch(() => false))) return page;
    const popup = page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null);
    await link.click();
    const next = await popup;
    if (next) { await page.close().catch(() => {}); page = next; }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2500);
  }
  return page;
}

async function apply(job, { cvPath }) {
  let page = await browser.newPage();
  let keep = false;
  try {
    await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    page = await reachForm(page);

    const body = await page.locator('body').innerText().catch(() => '');
    if (/sign in|log in|create (an )?account/i.test(body) && (await page.locator('input[type="password"]').count())) {
      throw new NeedsUser(`${new URL(page.url()).hostname} wants an account. Apply there yourself.`);
    }
    if ((await page.locator('form input:visible, form textarea:visible').count()) < 2) {
      throw new NeedsUser('No application form found (maybe applies by email).');
    }

    await fillForm(page, { job, cvPath });
    await page.waitForTimeout(1000);
    // Fill again: some forms reveal follow-up questions after the first answers.
    await fillForm(page, { job, cvPath, skipFiles: true });

    if (await browser.hasHumanCheck(page)) throw new NeedsUser('The form has a captcha. Finish it in the Chrome window.');
    const submit = page.locator(SUBMIT).last();
    if (!(await submit.isVisible().catch(() => false))) throw new NeedsUser('No Submit button found.');
    await submit.click();
    await page.waitForTimeout(5000);

    const after = await page.locator('body').innerText().catch(() => '');
    if (DONE_TEXT.test(after)) return 'applied';
    if (await browser.hasHumanCheck(page)) throw new NeedsUser('A captcha appeared after Submit. Finish it in the Chrome window.');
    if (await errorCount(page)) throw new NeedsUser('The form reported errors. Check the Chrome window.');
    return 'applied';
  } catch (e) {
    if (e instanceof NeedsUser) keep = true;
    throw e;
  } finally {
    if (!keep) await page.close().catch(() => {});
  }
}

module.exports = { apply };
