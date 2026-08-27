'use strict';
// Release-gate secret / never-name scanner (design: release-e2e-gate, §6).
//
// The mechanical guarantee that no gate artifact carries a secret or names the
// private tracker org/project: loads the sensitive VALUES in memory from the
// environment (process.env → the plugin repo's untracked .env), then greps
// every given artifact for them. Values are compared in memory and NEVER
// echoed — hits report the file, line number, and which env KEY matched.
//
// What it scans for:
//   - each PAT value (AZURE_PAT / AZURE_DEVOPS_EXT_PAT / AZURE_DEVOPS_PAT)
//     plus its Basic-auth base64 form (base64(":"+PAT))
//   - the AZURE_URL value and its org path segment (ADO URLs embed the org)
//   - the AZURE_PROJECT value
//
// Usage: node scan-secrets.js <file-or-dir> [more...] [--env-from <plugin-repo-root>]
// Output: one JSON line {ok, scannedFiles, keysLoaded, hits:[{file,line,key}]}.
// Exit codes: 0 clean · 1 any hit (gate FAIL) · 2 zero loadable values or usage
// (fail closed — a scan with nothing to scan for could only produce a wrong PASS).
const fs = require('node:fs');
const path = require('node:path');
const pc = require(path.join(__dirname, '..', 'lib', 'project_config.js'));
const { PAT_ENV_NAMES } = require(path.join(__dirname, '..', 'lib', 'tracker', 'adapters', 'ado.js'));

function usageError(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

// [ [key-label, value], ... ] — labels are safe to print, values never are.
function loadNeedles(envFromDir) {
  const needles = [];
  for (const name of PAT_ENV_NAMES) {
    const v = pc.readEnvVar(envFromDir, name);
    if (!v) continue;
    needles.push([name, v]);
    needles.push([`${name} (base64 auth form)`, Buffer.from(':' + v).toString('base64')]);
  }
  const url = pc.readEnvVar(envFromDir, 'AZURE_URL');
  if (url) {
    needles.push(['AZURE_URL', url]);
    const seg = url.replace(/\/+$/, '').split('/').pop();
    if (seg && seg !== url) needles.push(['AZURE_URL (org segment)', seg]);
  }
  const project = pc.readEnvVar(envFromDir, 'AZURE_PROJECT');
  if (project) needles.push(['AZURE_PROJECT', project]);
  return needles;
}

function listFiles(target, acc = []) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) listFiles(path.join(target, entry), acc);
  } else {
    acc.push(target);
  }
  return acc;
}

function scanSecrets({ targets, envFromDir } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) throw usageError('at least one file or directory to scan is required');
  const source = path.resolve(envFromDir || path.resolve(__dirname, '..', '..'));
  const needles = loadNeedles(source);
  if (needles.length === 0) {
    throw usageError(
      `no scannable values resolved — none of ${[...PAT_ENV_NAMES, 'AZURE_URL', 'AZURE_PROJECT'].join(', ')} ` +
      `are set in the environment or in ${path.join(source, '.env')}. Refusing a trivial pass.`);
  }

  const hits = [];
  let scannedFiles = 0;
  for (const target of targets) {
    if (!fs.existsSync(target)) throw usageError(`scan target does not exist: ${target}`);
    for (const file of listFiles(path.resolve(target))) {
      scannedFiles++;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        for (const [key, value] of needles) {
          if (lines[i].includes(value)) hits.push({ file, line: i + 1, key });
        }
      }
    }
  }
  return { ok: hits.length === 0, scannedFiles, keysLoaded: needles.map(([k]) => k), hits };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    const targets = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      if (argv[i].startsWith('--')) {
        if (argv[i + 1] === undefined) throw usageError(`missing value for ${argv[i]}`);
        flags[argv[i].slice(2)] = argv[++i];
      } else {
        targets.push(argv[i]);
      }
    }
    const result = scanSecrets({ targets, envFromDir: flags['env-from'] });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = e.exitCode || 1;
  }
}

module.exports = { scanSecrets };
