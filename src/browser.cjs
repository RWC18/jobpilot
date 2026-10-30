// One visible Chrome window (your installed Chrome) with its own profile in data/chrome-profile.
// You log in to LinkedIn / Upwork there once; the session cookies stay in that profile.
//
// Chrome is started as a normal browser with a local debugging port, not launched by Playwright:
// sign-in pages (LinkedIn, Upwork, "Sign in with Google") refuse browsers that run under automation.
// JobPilot attaches to that Chrome only while it searches or applies, and never during a login.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store.cjs');

const PROFILE_DIR = process.env.JOBPILOT_CHROME_PROFILE || path.join(store.DATA, 'chrome-profile');
const PORT = Number(process.env.JOBPILOT_CDP_PORT) || 9333;
const BASE = `http://127.0.0.1:${PORT}`;

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
];

function chromePath() {
  const found = CHROME_PATHS.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('Google Chrome not found. Install it or set CHROME_PATH.');
  return found;
}

const chromeUp = () => fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);

/** Starts the JobPilot Chrome if it isn't running; opens url in a new tab. */
async function startChrome(url) {
  if (store.ONLINE) throw new Error('No browser in the online version. Apply from the JobPilot app on your PC.');
  if (await chromeUp()) {
    if (url) await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    return;
  }
  const args = [
    `--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900', '--window-position=0,0',
    // Extra flags, e.g. "--no-sandbox" when running as root in Docker.
    ...(process.env.JOBPILOT_CHROME_ARGS || '').split(/\s+/).filter(Boolean),
    url || 'about:blank',
  ];
  spawn(chromePath(), args, { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    if (await chromeUp()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('The JobPilot Chrome window did not start. Close any JobPilot Chrome window and try again.');
}

let connection = null;

async function connect() {
  if (!connection) {
    connection = (async () => {
      await startChrome();
      // Loaded on first use so the Netlify functions never need Playwright.
      const { chromium } = require('playwright-core');
      const browser = await chromium.connectOverCDP(BASE);
      browser.on('disconnected', () => { connection = null; });
      return browser;
    })().catch((e) => { connection = null; throw e; });
  }
  return connection;
}

async function context() {
  return (await connect()).contexts()[0];
}

async function newPage() {
  const page = await (await context()).newPage();
  page.setDefaultTimeout(15000);
  return page;
}

/** Detaches from Chrome; the window and its logins stay open. */
async function detach() {
  const pending = connection;
  connection = null;
  const browser = await pending?.catch(() => null);
  await browser?.close().catch(() => {});
}

const LOGIN_URLS = {
  linkedin: 'https://www.linkedin.com/login',
  upwork: 'https://www.upwork.com/ab/account-security/login',
};

/** Opens a login page in plain Chrome so the user can sign in themselves. */
async function openLogin(site) {
  await detach();
  await startChrome(LOGIN_URLS[site] || site);
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

module.exports = { context, newPage, openLogin, hasHumanCheck, waitOutHumanCheck, close: detach };
