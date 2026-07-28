// The only part of "log in once, reuse the session" that is the same in every application:
// prove you are authenticated, save the session, load it into a fresh browser, prove it again.
//
// HOW the login happens is not this module's business — hand it a page that is already logged
// in, whether that took three lines of username/password or a hundred and fifty of iframe,
// captcha and OTP.
//
// Library use:
//   const { saveSession, resumeSession } = require('<plugin>/skills/optimize-login/scripts/session.js');
//   await saveSession(page, { statePath, landmark: { absent: '#login-button' } });
//   const s = await resumeSession({ statePath, url, landmark: { absent: '#login-button' } });
//   ...continue with s.page...  then  await s.browser.close();
//
// CLI use (verify a saved session is still alive, without writing any project code):
//   node session.js resume --state <path> --url <url> --absent "#login-button"
//   node session.js resume --state <path> --url <url> --present "text=My account"
// Prints exactly one RESULT: line and exits 0 (alive) or 1 (not).
//
// Requires playwright resolvable from the caller (NODE_PATH=<project>/node_modules if needed).
const fs = require('fs');
const path = require('path');

// A landmark is anything true ONLY when logged in. Two forms, and both may be given:
//   { present: <selector> }  something that appears once authenticated (an account menu)
//   { absent:  <selector> }  something that disappears once authenticated (a Login button)
// Never verify by URL: a login page can carry ?returnUrl=/dashboard and satisfy any path-based
// test while the user is still logged out, reporting a login that never happened.
async function isAuthenticated(page, landmark, timeoutMs = 15000) {
  if (!landmark || (!landmark.present && !landmark.absent)) {
    throw new Error('a landmark is required — authentication is never verified by URL');
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = true;
    if (landmark.present) ok = ok && (await page.locator(landmark.present).count().catch(() => 0)) > 0;
    if (landmark.absent) ok = ok && (await page.locator(landmark.absent).count().catch(() => 1)) === 0;
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(1000);
  }
}

// Verify BEFORE saving: a half-finished login writes a state file that looks perfectly valid
// and fails much later, somewhere confusing.
async function saveSession(page, { statePath, landmark, timeoutMs }) {
  if (!(await isAuthenticated(page, landmark, timeoutMs))) {
    throw new Error('refusing to save: the landmark says this page is not authenticated (url=' + page.url() + ')');
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  await page.context().storageState({ path: statePath });
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const localStorageItems = (st.origins || []).reduce((n, o) => n + (o.localStorage || []).length, 0);
  return { statePath, cookies: (st.cookies || []).length, localStorageItems };
}

// Verify AFTER loading too: a session expires on its own schedule while the file stays valid
// forever, so "the state file exists" is never "the session is alive". Age is reported, never
// trusted — observed here: a 15-minute-old session dead, a 47-minute-old one fine.
// Note storageState carries cookies and localStorage ONLY. An application holding its tokens
// in IndexedDB cannot be resumed this way; the check below is what tells you that plainly.
async function resumeSession({ statePath, url, landmark, viewport, timeoutMs, headed }) {
  const { chromium } = require('playwright');
  if (!fs.existsSync(statePath)) throw new Error('no session at ' + statePath + ' — log in first');
  const ageMinutes = +((Date.now() - fs.statSync(statePath).mtimeMs) / 60000).toFixed(1);

  const browser = await chromium.launch({ headless: !(headed || process.env.HEADED), channel: 'chrome' });
  const context = await browser.newContext({ storageState: statePath, viewport: viewport || { width: 1500, height: 1000 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForLoadState('networkidle').catch(() => {});

  if (!(await isAuthenticated(page, landmark, timeoutMs))) {
    await browser.close().catch(() => {});
    throw new Error('session not restored (saved ' + ageMinutes + ' min ago) — log in again');
  }
  await context.storageState({ path: statePath }); // refresh, so the idle clock restarts on use
  return { browser, context, page, ageMinutes };
}

module.exports = { isAuthenticated, saveSession, resumeSession };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
  const fail = (msg) => { console.log(msg); console.log('RESULT: RESUME_FAIL'); process.exit(1); };

  if (argv[0] !== 'resume') {
    console.log('usage: node session.js resume --state <path> --url <url> [--absent <sel>] [--present <sel>]');
    process.exit(argv[0] ? 1 : 0);
  }
  const statePath = flag('state'), url = flag('url');
  const landmark = {};
  if (flag('present')) landmark.present = flag('present');
  if (flag('absent')) landmark.absent = flag('absent');
  if (!statePath || !url) fail('--state and --url are required');
  if (!landmark.present && !landmark.absent) fail('--present or --absent is required (a landmark, not a URL)');

  const watchdog = setTimeout(() => { console.log('watchdog 120s'); console.log('RESULT: RESUME_FAIL'); process.exit(1); }, 120000);
  resumeSession({ statePath, url, landmark })
    .then(async (s) => {
      console.log('session alive (saved ' + s.ageMinutes + ' min ago) at ' + s.page.url());
      await s.browser.close().catch(() => {});
      clearTimeout(watchdog);
      console.log('RESULT: RESUME_PASS');
      process.exit(0);
    })
    .catch((e) => { clearTimeout(watchdog); fail(String(e.message || e).split('\n')[0]); });
}
