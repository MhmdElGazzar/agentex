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
//   node session.js resume ... --headed --channel chrome
// Prints exactly one RESULT: line and exits 0 (alive) or 1 (not).
//
// The `playwright` package comes from YOUR PROJECT (or NODE_PATH) — see loadPlaywright below.
const fs = require('fs');
const path = require('path');

// This file lives in the plugin, which is installed somewhere else entirely
// (~/.claude/plugins/…), and a bare require() resolves from the requiring file's directory
// upwards — i.e. through the PLUGIN's tree, never through the tester's project. So a QA
// project that had already run `npm i -D playwright` still failed here with a bare
// "Cannot find module 'playwright'" stack, and the only cure was a NODE_PATH= prefix
// mentioned in one line of the docs.
//
// Resolve it from the project instead, in the order that keeps every working invocation
// working: a plain require first (honours NODE_PATH and any install next to the plugin),
// then the working directory and its parents (a monorepo hoists to the root), and
// playwright-core for projects that depend on it directly. A genuinely missing package
// gets one actionable line instead of a stack.
function loadPlaywright(cwd = process.cwd()) {
  const paths = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    paths.push(d);
    if (path.dirname(d) === d) break;
  }
  for (const name of ['playwright', 'playwright-core']) {
    try { return require(name); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
    try { return require(require.resolve(name, { paths })); }
    catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; } // a broken install is not a missing one
  }
  throw new Error(
    'playwright is not installed in ' + path.resolve(cwd) + ' — run `npm i -D playwright` there, ' +
    'then `npx playwright install chromium`. (Or point NODE_PATH at a node_modules that has it.) ' +
    'This script drives a real browser through the playwright library; playwright-cli cannot ' +
    'stand in for it, because only the library can load a saved storageState.'
  );
}

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

// Launch options, kept in one place because the browser choice used to be a hidden hard
// requirement: `channel: 'chrome'` demanded a Google Chrome INSTALL, so the script failed on
// exactly the machines a QA project is most likely to run on — a CI box, a Linux dev machine,
// a Windows laptop with only Edge — even though `npx playwright install chromium` had already
// put a working browser there. Playwright's bundled Chromium is the default now; a channel is
// opt-in via --channel / PLAYWRIGHT_CHANNEL, and asking for one that is not installed is an
// error, never a silent substitution: you asked for that browser for a reason.
function launchOptions({ headed, channel } = {}) {
  const opts = { headless: !(headed || process.env.HEADED) };
  const wanted = channel || process.env.PLAYWRIGHT_CHANNEL || '';
  if (wanted) opts.channel = wanted;
  return opts;
}

// Verify AFTER loading too: a session expires on its own schedule while the file stays valid
// forever, so "the state file exists" is never "the session is alive". Age is reported, never
// trusted — observed here: a 15-minute-old session dead, a 47-minute-old one fine.
// Note storageState carries cookies and localStorage ONLY. An application holding its tokens
// in IndexedDB cannot be resumed this way; the check below is what tells you that plainly.
async function resumeSession({ statePath, url, landmark, viewport, timeoutMs, headed, channel, cwd }) {
  const { chromium } = loadPlaywright(cwd);
  if (!fs.existsSync(statePath)) throw new Error('no session at ' + statePath + ' — log in first');
  const ageMinutes = +((Date.now() - fs.statSync(statePath).mtimeMs) / 60000).toFixed(1);

  const opts = launchOptions({ headed, channel });
  let browser;
  try {
    browser = await chromium.launch(opts);
  } catch (e) {
    const first = String((e && e.message) || e).split('\n')[0];
    throw new Error(opts.channel
      ? 'cannot launch the "' + opts.channel + '" browser channel you asked for (--channel / ' +
        'PLAYWRIGHT_CHANNEL): ' + first + '. Install that browser, or drop the flag to use the ' +
        'bundled Chromium — nothing was substituted for it.'
      : 'cannot launch a browser: ' + first + '. Run `npx playwright install chromium` in this project.');
  }

  // Everything past launch closes the browser on the way out. Only the landmark check used to,
  // so a bad URL, a goto timeout or any context error left a headless browser running — one
  // orphan process per attempt, for the rest of the run, discovered through memory rather
  // than through an error.
  try {
    const context = await browser.newContext({ storageState: statePath, viewport: viewport || { width: 1500, height: 1000 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForLoadState('networkidle').catch(() => {});

    if (!(await isAuthenticated(page, landmark, timeoutMs))) {
      throw new Error('session not restored (saved ' + ageMinutes + ' min ago) — log in again');
    }
    await context.storageState({ path: statePath }); // refresh, so the idle clock restarts on use
    return { browser, context, page, ageMinutes };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

module.exports = { isAuthenticated, saveSession, resumeSession, loadPlaywright, launchOptions };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (name) => argv.includes('--' + name);
  const fail = (msg) => { console.log(msg); console.log('RESULT: RESUME_FAIL'); process.exit(1); };

  if (argv[0] !== 'resume') {
    console.log('usage: node session.js resume --state <path> --url <url> [--absent <sel>] [--present <sel>] [--headed] [--channel <chrome|msedge|...>]');
    process.exit(argv[0] ? 1 : 0);
  }
  const statePath = flag('state'), url = flag('url');
  const landmark = {};
  if (flag('present')) landmark.present = flag('present');
  if (flag('absent')) landmark.absent = flag('absent');
  if (!statePath || !url) fail('--state and --url are required');
  if (!landmark.present && !landmark.absent) fail('--present or --absent is required (a landmark, not a URL)');

  const watchdog = setTimeout(() => { console.log('watchdog 120s'); console.log('RESULT: RESUME_FAIL'); process.exit(1); }, 120000);
  resumeSession({ statePath, url, landmark, headed: has('headed'), channel: flag('channel') })
    .then(async (s) => {
      console.log('session alive (saved ' + s.ageMinutes + ' min ago) at ' + s.page.url());
      await s.browser.close().catch(() => {});
      clearTimeout(watchdog);
      console.log('RESULT: RESUME_PASS');
      process.exit(0);
    })
    .catch((e) => { clearTimeout(watchdog); fail(String(e.message || e).split('\n')[0]); });
}
