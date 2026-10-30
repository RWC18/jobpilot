// One visible Chrome window (your installed Chrome) with its own profile in data/chrome-profile.
// You log in to LinkedIn / Upwork there once; the session cookies stay in that profile.
const path = require('path');
const store = require('./store.cjs');

const PROFILE_DIR = process.env.JOBPILOT_CHROME_PROFILE || path.join(store.DATA, 'chrome-profile');
let ctxPromise = null;

async function context() {
  if (!ctxPromise) {
    if (store.ONLINE) throw new Error('No browser in the online version. Apply from the JobPilot app on your PC.');
    // Loaded on first use so the Netlify functions never need Playwright.
    const { chromium } = require('playwright-core');
    ctxPromise = chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      // Extra flags, e.g. "--no-sandbox" when running as root in Docker.
      args: ['--window-size=1280,900', '--window-position=0,0', ...(process.env.JOBPILOT_CHROME_ARGS || '').split(/\s+/).filter(Boolean)],
    }).then((ctx) => {
      ctx.on('close', () => { ctxPromise = null; });
      return ctx;
    }).catch((e) => { ctxPromise = null; throw e; });
  }
  return ctxPromise;
}

async function newPage() {
  const ctx = await context();
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  return page;
}

const LOGIN_URLS = {
  linkedin: 'https://www.linkedin.com/login',
  upwork: 'https://www.upwork.com/ab/account-security/login',
};

/** Opens the login page so the user can sign in themselves. */
async function openLogin(site) {
  const page = await newPage();
  await page.goto(LOGIN_URLS[site] || site);
  await page.bringToFront();
  return true;
}

/** Signs the browser is stuck on a human check we must not try to get around. */
async function hasHumanCheck(page) {
  const title = (await page.title().catch(() => '')).toLowerCase();
  if (/just a moment|attention required|security check|verify you are human/.test(title)) return true;
  const sel = 'iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"], #captcha-internal, [id*="captcha" i]:visible';
  return (await page.locator(sel).count().catch(() => 0)) > 0;
}

/** Cloudflare's automatic check often clears by itself in a real Chrome; wait a bit before giving up. */
async function waitOutHumanCheck(page, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await hasHumanCheck(page))) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

async function close() {
  if (ctxPromise) (await ctxPromise).close().catch(() => {});
  ctxPromise = null;
}

module.exports = { context, newPage, openLogin, hasHumanCheck, waitOutHumanCheck, close };
