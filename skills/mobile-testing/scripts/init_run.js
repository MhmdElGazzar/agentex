// AgenTeX mobile run scaffolder — creates the execution output tree for one run in a single call.
//
// Usage: node init_run.js [--sessions label1,label2,...]   (default: one label "run")
//   Labels are logical (spec-file slugs or device names). Each becomes an ASCII folder name
//   under mobile-sessions/: lower-cased, anything outside [a-z0-9._-] turned into "-". A label
//   with no ASCII left (a spec named in a non-Latin script) falls back to `spec<n>-<digest>`.
//   Duplicates get a `-<n>` suffix. Refused (JSON error, exit 1): the label "default" (every
//   run names its sessions), a path separator or ".." (no writing outside the run folder),
//   an empty list, a flag with no value, or an unknown argument.
//   Two runs started in the same second get distinct folders (`execu_<ts>`, `execu_<ts>-2`, ...).
// Prints ONE JSON line:
//   {"runDir": "...", "bugsDir": "...", "sessions": {name: {dir, logs, screenshots, label}}}
//   "label" is the label as given, for display only — never as a path or an argument.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fail = msg => { console.log(JSON.stringify({ error: msg })); process.exit(1); };

let labels = ['run'];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sessions') {
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) fail('--sessions needs a value: --sessions label1,label2,...');
    labels = value.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    fail(`unknown argument ${args[i]} — usage: init_run.js [--sessions label1,label2,...]`);
  }
}

if (labels.length === 0) fail('at least one session label is required');

for (const l of labels) {
  if (/[\\/]/.test(l) || l.split(/[\\/]/).includes('..') || l === '..' || l === '.') {
    fail(`session label ${JSON.stringify(l)} is a path — labels must not contain "/", "\\" or ".."`);
  }
}

const original = labels.slice();
const digest = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 4);
labels = labels.map((l, i) => {
  const ascii = l.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return ascii || `spec${i + 1}-${digest(l)}`;
});
if (labels.some(l => l === 'default')) {
  fail('the "default" session label is prohibited — name each session (e.g. after its spec or device)');
}
labels = labels.map((l, i) => (labels.indexOf(l) === i ? l : `${l}-${i + 1}`));

const d = new Date();
const p = n => String(n).padStart(2, '0');
const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;

// Claim the run folder atomically: mkdir without `recursive` fails if it already exists,
// so two runs started in the same second (even concurrently) never share one.
fs.mkdirSync('executions', { recursive: true });
let runDir;
for (let n = 1; ; n++) {
  runDir = path.join('executions', n === 1 ? `execu_${ts}` : `execu_${ts}-${n}`);
  try { fs.mkdirSync(runDir); break; }
  catch (e) { if (e.code !== 'EEXIST') fail(`cannot create ${runDir}: ${e.message}`); }
}
const bugsDir = path.join(runDir, 'bugs');
fs.mkdirSync(path.join(bugsDir, 'screenshots'), { recursive: true });

const out = { runDir, bugsDir, sessions: {} };
labels.forEach((s, i) => {
  const dir = path.join(runDir, 'mobile-sessions', s);
  const logs = path.join(dir, 'logs');
  const screenshots = path.join(dir, 'screenshots');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(screenshots, { recursive: true });
  out.sessions[s] = { dir, logs, screenshots, label: original[i] };
});
console.log(JSON.stringify(out));
