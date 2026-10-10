// AgenTeX mobile driver — thin wrapper around webdriverio for driving an Appium session
// with simple flag-driven subcommands. Prints ONE JSON line: {"result":"PASS|FAIL|BLOCKED", ...}.
// Exit: 0 PASS, 1 FAIL (the app answered, and the answer was wrong), 2 BLOCKED (usage,
// missing dependency/secret, or infrastructure: the Appium server or session never answered).
//
// Usage:
//   node appium_client.js create-session --caps-file <path.json> [--allow-reset] [--server <url>]
//   node appium_client.js find --session <id> --using <strategy> --value <selector> [--server <url>]
//   node appium_client.js click --session <id> --element <elementId> [--server <url>]
//   node appium_client.js send-keys --session <id> --element <elementId> (--text <text> | --text-env <NAME>) [--server <url>]
//   node appium_client.js get-text --session <id> --element <elementId> [--server <url>]
//   node appium_client.js screenshot --session <id> --out <path.png> [--server <url>]
//   node appium_client.js swipe --session <id> --from <x>,<y> --to <x>,<y> [--server <url>]
//   node appium_client.js back --session <id> [--server <url>]
//   node appium_client.js source --session <id> [--server <url>]
//   node appium_client.js close-session --session <id> [--server <url>]
//
// Secrets: `send-keys --text-env NAME` reads the text from the environment variable NAME, or
// from NAME in the project's .env (same lookup as every other runner) — so a password never
// sits on the command line. The typed text is never printed: webdriverio runs with
// logLevel 'silent', any stray library output is diverted to stderr, and every line this
// script writes has the typed text redacted.
//
// The plugin ships NO npm dependencies of its own — `webdriverio` must be a devDependency of
// the CALLING project. It is resolved dynamically against the current working directory (not
// this script's own location), since this file lives inside the plugin install, not the
// consumer's project. See references/appium-client-wrapper.md.
const fs = require('fs');
const path = require('path');
const pc = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'project_config.js'));

// ---- stdout is ours alone: exactly one JSON line. Library chatter goes to stderr. ----
const rawStdoutWrite = process.stdout.write.bind(process.stdout);
const rawStderrWrite = process.stderr.write.bind(process.stderr);
let secretText = null; // the text being typed, once known — redacted from every output
function redact(s) {
  s = String(s);
  return secretText ? s.split(secretText).join('***') : s;
}
process.stdout.write = (chunk, ...rest) => rawStderrWrite(redact(chunk), ...rest);
process.stderr.write = (chunk, ...rest) => rawStderrWrite(redact(chunk), ...rest);

function emit(obj) { rawStdoutWrite(redact(JSON.stringify(obj)) + '\n'); }
function out(obj, code) { emit(obj); process.exitCode = code; }
function blocked(reason, extra) { emit({ result: 'BLOCKED', reason, ...extra }); process.exit(2); }
function fail(reason) { out({ result: 'FAIL', reason }, 1); }

// Infrastructure, not a defect: the Appium server or the session never answered (driver
// contract: the app under test is not on trial for an environment that never let it answer).
const INFRA_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE']);
const INFRA_PATTERN = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|socket hang up|fetch failed|Unable to connect to|invalid session id|no such session|session is either terminated or not started|session not created/i;
function isInfrastructure(e) {
  if (!e) return false;
  const codes = [e.code, e.cause && e.cause.code, e.errno].filter(Boolean);
  if (codes.some(c => INFRA_CODES.has(String(c)))) return true;
  return INFRA_PATTERN.test(`${e.name || ''} ${e.message || ''} ${(e.cause && e.cause.message) || ''}`);
}

// ---- resolve webdriverio from the caller's project, not the plugin's own install ----
function loadWebdriverio() {
  try {
    const resolved = require.resolve('webdriverio', { paths: [process.cwd()] });
    return require(resolved);
  } catch (e) {
    return null;
  }
}

// ---- args ----
const [, , subcommand, ...rest] = process.argv;
const flags = {};
const BOOLEAN_FLAGS = ['allow-reset'];
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue;
  const k = rest[i].slice(2);
  if (BOOLEAN_FLAGS.includes(k)) { flags[k] = true; continue; }
  flags[k] = rest[i + 1]; i++;
}
if (flags.text) secretText = flags.text;
const KNOWN = ['create-session', 'find', 'click', 'send-keys', 'get-text', 'screenshot', 'swipe', 'back', 'source', 'close-session'];
if (!subcommand || !KNOWN.includes(subcommand)) blocked(`usage: appium_client.js <${KNOWN.join('|')}> [flags]`);

// send-keys text: --text <text>, or --text-env <NAME> (process env, then the project's .env).
let sendText;
if (subcommand === 'send-keys') {
  const usage = 'usage: send-keys --session <id> --element <elementId> (--text <text> | --text-env <NAME>)';
  if (flags.text !== undefined && flags['text-env'] !== undefined) blocked(`${usage} — pass --text or --text-env, not both`);
  if (flags['text-env'] !== undefined) {
    const name = flags['text-env'];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '')) blocked(`--text-env expects an environment variable name, got ${JSON.stringify(name)}`);
    const value = pc.readEnvVar(process.cwd(), name);
    if (value === null || value === '') blocked(`env var ${name} is not set in the environment or the project's .env`);
    sendText = value;
    secretText = value;
  } else if (flags.text !== undefined) {
    sendText = flags.text;
  }
  if (!flags.element || sendText === undefined) blocked(usage);
}

const wdio = loadWebdriverio();
if (!wdio) blocked('webdriverio not found — run: npm install -D webdriverio');
const { remote, attach } = wdio;

function parseServer(server) {
  const url = new URL(server || 'http://127.0.0.1:4723');
  return {
    protocol: url.protocol.replace(':', ''),
    hostname: url.hostname,
    port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname === '/' ? '/' : url.pathname,
  };
}

// logLevel 'silent' on EVERY remote()/attach(): webdriverio's default logs each command and
// its payload (send-keys text included) to stdout.
async function attachSession(sessionId, server) {
  return attach({ sessionId, capabilities: {}, requestedCapabilities: {}, logLevel: 'silent', ...parseServer(server) });
}

(async () => {
  try {
    if (subcommand === 'create-session') {
      if (!flags['caps-file']) blocked('usage: create-session --caps-file <path.json> [--allow-reset] [--server <url>]');
      if (!fs.existsSync(flags['caps-file'])) blocked(`caps file not found: ${flags['caps-file']}`);
      let capsDoc;
      try { capsDoc = JSON.parse(fs.readFileSync(flags['caps-file'], 'utf8')); }
      catch (e) { blocked(`invalid JSON in ${flags['caps-file']}: ${e.message}`); }
      const capabilities = (capsDoc.capabilities && capsDoc.capabilities.alwaysMatch) || capsDoc.capabilities || capsDoc;
      // Appium's default (noReset false) wipes the app's data on session start. Here the
      // default is the opposite, and a reset runs only with --allow-reset, which the agent
      // passes after the user approved that reset for this run.
      const wantsReset = capabilities['appium:fullReset'] === true || capabilities['appium:noReset'] === false;
      if (wantsReset && !flags['allow-reset']) {
        blocked('caps request an app-data reset (appium:fullReset true or appium:noReset false) — get the user\'s approval, then rerun with --allow-reset');
      }
      if (!wantsReset && capabilities['appium:noReset'] === undefined) capabilities['appium:noReset'] = true;
      const browser = await remote({ capabilities, logLevel: 'silent', ...parseServer(flags.server) });
      out({ result: 'PASS', sessionId: browser.sessionId }, 0);
      process.exit(0); // don't wait on any lingering handles; the Appium session itself persists server-side
      return;
    }

    if (!flags.session) blocked(`usage: ${subcommand} --session <id> ... [--server <url>]`);
    const browser = await attachSession(flags.session, flags.server);

    if (subcommand === 'find') {
      if (!flags.using || !flags.value) blocked('usage: find --session <id> --using <strategy> --value <selector>');
      const el = await browser.findElement(flags.using, flags.value);
      const elementId = el && (el.ELEMENT || el['element-6066-11e4-a52e-4f735466cecf']);
      if (!elementId) fail(`element not found: ${flags.using}=${flags.value}`);
      else out({ result: 'PASS', element: elementId }, 0);
    } else if (subcommand === 'click') {
      if (!flags.element) blocked('usage: click --session <id> --element <elementId>');
      await browser.elementClick(flags.element);
      out({ result: 'PASS' }, 0);
    } else if (subcommand === 'send-keys') {
      await browser.elementSendKeys(flags.element, sendText);
      out({ result: 'PASS' }, 0);
    } else if (subcommand === 'get-text') {
      if (!flags.element) blocked('usage: get-text --session <id> --element <elementId>');
      const text = await browser.getElementText(flags.element);
      out({ result: 'PASS', text }, 0);
    } else if (subcommand === 'screenshot') {
      if (!flags.out) blocked('usage: screenshot --session <id> --out <path.png>');
      const b64 = await browser.takeScreenshot();
      fs.mkdirSync(path.dirname(flags.out), { recursive: true });
      fs.writeFileSync(flags.out, Buffer.from(b64, 'base64'));
      out({ result: 'PASS', path: flags.out }, 0);
    } else if (subcommand === 'swipe') {
      if (!flags.from || !flags.to) blocked('usage: swipe --session <id> --from <x>,<y> --to <x>,<y>');
      const [fx, fy] = flags.from.split(',').map(Number);
      const [tx, ty] = flags.to.split(',').map(Number);
      await browser.performActions([{
        type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: fx, y: fy },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 300, x: tx, y: ty },
          { type: 'pointerUp', button: 0 },
        ],
      }]);
      out({ result: 'PASS' }, 0);
    } else if (subcommand === 'back') {
      await browser.back();
      out({ result: 'PASS' }, 0);
    } else if (subcommand === 'source') {
      const source = await browser.getPageSource();
      out({ result: 'PASS', source }, 0);
    } else if (subcommand === 'close-session') {
      await browser.deleteSession();
      out({ result: 'PASS' }, 0);
    }
  } catch (e) {
    if (isInfrastructure(e)) {
      blocked(`infrastructure: the Appium server or session did not answer (${e.message}) — not an app defect; check the server is running and the session is alive`, { infrastructure: true });
    }
    fail(e.message);
  }
})();
