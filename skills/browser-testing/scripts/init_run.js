// AgenTeX run scaffolder — creates the execution output tree for one run in a single call.
//
// Usage: node init_run.js [--sessions name1,name2,...]   (default: one session "default")
// Prints ONE JSON line: {"runDir": "...", "bugsDir": "...", "sessions": {name: {dir, logs, screenshots}}}
const fs = require('fs');
const path = require('path');

let sessions = ['default'];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sessions') sessions = args[++i].split(',').map(s => s.trim()).filter(Boolean);
}

const d = new Date();
const p = n => String(n).padStart(2, '0');
const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
const runDir = path.join('executions', `execu_${ts}`);
const bugsDir = path.join(runDir, 'bugs');
fs.mkdirSync(path.join(bugsDir, 'screenshots'), { recursive: true });

const out = { runDir, bugsDir, sessions: {} };
for (const s of sessions) {
  const dir = path.join(runDir, 'browser-sessions', s);
  const logs = path.join(dir, 'logs');
  const screenshots = path.join(dir, 'screenshots');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(screenshots, { recursive: true });
  out.sessions[s] = { dir, logs, screenshots };
}
console.log(JSON.stringify(out));
