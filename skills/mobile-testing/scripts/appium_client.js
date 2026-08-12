// AgenTeX mobile driver — thin wrapper around webdriverio for driving an Appium session
// with simple flag-driven subcommands. Prints ONE JSON line: {"result":"PASS|FAIL|BLOCKED", ...}.
// Exit: 0 PASS, 1 FAIL, 2 BLOCKED.
//
// Usage:
//   node appium_client.js create-session --caps-file <path.json> [--server <url>]
//   node appium_client.js find --session <id> --using <strategy> --value <selector> [--server <url>]
//   node appium_client.js click --session <id> --element <elementId> [--server <url>]
//   node appium_client.js send-keys --session <id> --element <elementId> --text <text> [--server <url>]
//   node appium_client.js get-text --session <id> --element <elementId> [--server <url>]
//   node appium_client.js screenshot --session <id> --out <path.png> [--server <url>]
//   node appium_client.js swipe --session <id> --from <x>,<y> --to <x>,<y> [--server <url>]
//   node appium_client.js back --session <id> [--server <url>]
//   node appium_client.js source --session <id> [--server <url>]
//   node appium_client.js close-session --session <id> [--server <url>]
//
// The plugin ships NO npm dependencies of its own — `webdriverio` must be a devDependency of
// the CALLING project. It is resolved dynamically against the current working directory (not
// this script's own location), since this file lives inside the plugin install, not the
// consumer's project. See references/appium-client-wrapper.md.
const fs = require('fs');

function out(obj, code) { console.log(JSON.stringify(obj)); process.exitCode = code; }
function blocked(reason, extra) { console.log(JSON.stringify({ result: 'BLOCKED', reason, ...extra })); process.exit(2); }
function fail(reason) { out({ result: 'FAIL', reason }, 1); }

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
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { flags[rest[i].slice(2)] = rest[i + 1]; i++; }
}
const KNOWN = ['create-session', 'find', 'click', 'send-keys', 'get-text', 'screenshot', 'swipe', 'back', 'source', 'close-session'];
if (!subcommand || !KNOWN.includes(subcommand)) blocked(`usage: appium_client.js <${KNOWN.join('|')}> [flags]`);

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

async function attachSession(sessionId, server) {
  return attach({ sessionId, capabilities: {}, requestedCapabilities: {}, ...parseServer(server) });
}

(async () => {
  try {
    if (subcommand === 'create-session') {
      if (!flags['caps-file']) blocked('usage: create-session --caps-file <path.json> [--server <url>]');
      if (!fs.existsSync(flags['caps-file'])) blocked(`caps file not found: ${flags['caps-file']}`);
      let capsDoc;
      try { capsDoc = JSON.parse(fs.readFileSync(flags['caps-file'], 'utf8')); }
      catch (e) { blocked(`invalid JSON in ${flags['caps-file']}: ${e.message}`); }
      const capabilities = (capsDoc.capabilities && capsDoc.capabilities.alwaysMatch) || capsDoc.capabilities || capsDoc;
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
      const elementId = el.ELEMENT || el['element-6066-11e4-a52e-4f735466cecf'];
      if (!elementId) fail(`element not found: ${flags.using}=${flags.value}`);
      else out({ result: 'PASS', element: elementId }, 0);
    } else if (subcommand === 'click') {
      if (!flags.element) blocked('usage: click --session <id> --element <elementId>');
      await browser.elementClick(flags.element);
      out({ result: 'PASS' }, 0);
    } else if (subcommand === 'send-keys') {
      if (!flags.element || flags.text === undefined) blocked('usage: send-keys --session <id> --element <elementId> --text <text>');
      await browser.elementSendKeys(flags.element, flags.text);
      out({ result: 'PASS' }, 0);
    } else if (subcommand === 'get-text') {
      if (!flags.element) blocked('usage: get-text --session <id> --element <elementId>');
      const text = await browser.getElementText(flags.element);
      out({ result: 'PASS', text }, 0);
    } else if (subcommand === 'screenshot') {
      if (!flags.out) blocked('usage: screenshot --session <id> --out <path.png>');
      const b64 = await browser.takeScreenshot();
      fs.mkdirSync(require('path').dirname(flags.out), { recursive: true });
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
    fail(e.message);
  }
})();
