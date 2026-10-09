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
//   A label written in a non-Latin script keeps no ASCII after sanitizing; it falls back to
//   `spec<n>-<digest>` rather than to a bare "-" (see below), and the label as given is
//   echoed back on the session so the run's report can name the spec.
// Prints ONE JSON line:
//   {"runDir": "...", "bugsDir": "...", "sessionTag": "...",
//    "sessions": {name: {dir, logs, screenshots, label}}}
//   The keys of "sessions" are the FINAL session names — pass them verbatim to `-s=`.
//   "label" is the label as given, for display only — never as a path or an argument.
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

// Session names must stay ASCII: they become directory names and `-s=` arguments
// on every platform the plugin runs on. But a label is a SPEC FILE NAME, and a
// spec named in a non-Latin script (تسجيل-الدخول.md, 登录.md) has no ASCII left
// after sanitizing — every such label collapsed to the same "-", so the dedupe
// suffix became the only difference and the session name no longer said which
// spec it belonged to. A tester with an all-Arabic suite got `-`, `-2`, `-3` and
// had to open folders to find the failing spec's screenshots.
//
// So: sanitize, and when nothing survives, fall back to a name that is still
// distinct and still traceable — the label's position plus a short digest of the
// original text (stable across runs, different per spec). The original is
// returned verbatim as `label` on each session so the orchestrator's report can
// show the spec's real name next to its ASCII session.
const original = labels.slice();
const digest = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 4);
labels = labels.map((l, i) => {
  const ascii = l.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return ascii || `spec${i + 1}-${digest(l)}`;
});
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
names.forEach((s, i) => {
  const dir = path.join(runDir, 'browser-sessions', s);
  const logs = path.join(dir, 'logs');
  const screenshots = path.join(dir, 'screenshots');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(screenshots, { recursive: true });
  // `label` is the label AS GIVEN — the spec's own name, non-ASCII included — so a
  // report can say which spec an ASCII session name stands for.
  out.sessions[s] = { dir, logs, screenshots, label: original[i] };
});
console.log(JSON.stringify(out));
