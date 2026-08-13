// AgenTeX run scaffolder — creates the execution output tree for one run in a single call,
// and generates the run's UNIQUE browser-session names. The playwright-cli `default` session
// is prohibited: concurrent executions (e.g. two Claude Code windows on one machine) would
// share it and kill each other's browser.
//
// Usage: node init_run.js [--sessions label1,label2,...]   (default: one label "run")
//   Labels are logical (e.g. spec-file slugs). Each final name is `<label>-<HHMMSS>-<tag>`
//   where <tag> is a random hex suffix collision-checked against every session name any
//   existing execution in this project has ever used — so a name can never match another
//   execution's, even one started in the same second. The label "default" is rejected.
// Prints ONE JSON line:
//   {"runDir": "...", "bugsDir": "...", "sessionTag": "...", "sessions": {name: {dir, logs, screenshots}}}
//   The keys of "sessions" are the FINAL session names — pass them verbatim to `-s=`.
//   An execution may close ONLY sessions carrying its own sessionTag.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let labels = ['run'];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sessions') labels = args[++i].split(',').map(s => s.trim()).filter(Boolean);
}

const fail = msg => { console.log(JSON.stringify({ error: msg })); process.exit(1); };

if (labels.length === 0) fail('at least one session label is required');
labels = labels.map(l => l.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
if (labels.some(l => l === 'default')) {
  fail('the "default" session is prohibited — every execution must use its own uniquely named sessions');
}
labels = labels.map((l, i) => (labels.indexOf(l) === i ? l : `${l}-${i + 1}`));

const d = new Date();
const p = n => String(n).padStart(2, '0');
const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;

let runDir = path.join('executions', `execu_${ts}`);
for (let n = 2; fs.existsSync(runDir); n++) runDir = path.join('executions', `execu_${ts}-${n}`);

// Every session name any execution in this project has already used (past or concurrent).
const taken = new Set();
if (fs.existsSync('executions')) {
  for (const run of fs.readdirSync('executions')) {
    const bs = path.join('executions', run, 'browser-sessions');
    if (fs.existsSync(bs)) for (const s of fs.readdirSync(bs)) taken.add(s);
  }
}

const hhmmss = `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
let tag, names;
do {
  tag = crypto.randomBytes(2).toString('hex');
  names = labels.map(l => `${l}-${hhmmss}-${tag}`);
} while (names.some(n => taken.has(n)));

const bugsDir = path.join(runDir, 'bugs');
fs.mkdirSync(path.join(bugsDir, 'screenshots'), { recursive: true });

const out = { runDir, bugsDir, sessionTag: tag, sessions: {} };
for (const s of names) {
  const dir = path.join(runDir, 'browser-sessions', s);
  const logs = path.join(dir, 'logs');
  const screenshots = path.join(dir, 'screenshots');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(screenshots, { recursive: true });
  out.sessions[s] = { dir, logs, screenshots };
}
console.log(JSON.stringify(out));
