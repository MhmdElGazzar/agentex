#!/usr/bin/env node
'use strict';
// AgenTeX KB Ask runner — asks ONE natural-language question to the KB Ask API.
// Usage:
//   node ask_kb.js --question <text> [--project <id>] [--org <slug>] [--model <m>] [--log <path>]
// Prints ONE JSON line: {"result":"OK|NOT_COVERED|BLOCKED", ...}. Exit: 0 OK/NOT_COVERED, 2 BLOCKED.
// Answers are advisory context only — never a PASS/FAIL verdict.
// Auth: sends KB_ASK_API_KEY as the x-api-key header when set (never logged/printed).
const fs = require('fs');
const path = require('path');

// Pre-fetch exits may use process.exit; post-fetch must only set exitCode (Windows/undici).
function out(obj, code) { console.log(JSON.stringify(obj)); process.exit(code); }
function outAsync(obj, code) { console.log(JSON.stringify(obj)); process.exitCode = code; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = n => 500 * Math.pow(2, n);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    o[key] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
  }
  return o;
}

function loadKbConfig(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, 'agentex.config.json'), 'utf8')).kb || {}; }
  catch { return {}; }
}

// Resolve an env var from process.env, falling back to a KEY=value line in the
// project's .env (the harness does not always load .env into process.env).
function resolveEnv(cwd, name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const re = new RegExp('^' + name + '\\s*=\\s*(.+)$', 'm');
    const m = fs.readFileSync(path.join(cwd, '.env'), 'utf8').match(re);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
  return null;
}

async function askKb({ baseUrl, project, question, org, model, apiKey, timeoutMs, retries }) {
  const body = JSON.stringify({ project, question, org, model });
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey; // secret — never logged
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/kb/ask`, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) { await sleep(backoff(attempt)); continue; }
      return { status: 0, error: String((e && e.message) || e) };
    }
    clearTimeout(timer);
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      // 429: honor Retry-After (seconds; default 2s) as the base, grown exponentially.
      // 5xx: plain exponential backoff.
      let waitMs = backoff(attempt);
      if (res.status === 429) {
        const ra = parseInt(res.headers.get('retry-after'), 10);
        const baseMs = Number.isFinite(ra) ? ra * 1000 : 2000;
        waitMs = baseMs * Math.pow(2, attempt);
      }
      await sleep(waitMs);
      continue;
    }
    return { status: res.status, json, text };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const cfg = loadKbConfig(cwd);

  const question = typeof args.question === 'string' ? args.question : null;
  // Project precedence: --project flag → KB_PROJECT (env/.env) → kb.project in config.
  const project = (typeof args.project === 'string' ? args.project : null) || resolveEnv(cwd, 'KB_PROJECT') || cfg.project || null;
  const org = (typeof args.org === 'string' ? args.org : null) || cfg.org || 'tameeni';
  const model = (typeof args.model === 'string' ? args.model : null) || cfg.model || 'opus';
  const timeoutMs = Number(cfg.timeout_ms) > 0 ? Number(cfg.timeout_ms) : 120000;
  const retries = Number.isInteger(cfg.retries) ? cfg.retries : 2;
  const logPath = typeof args.log === 'string' ? args.log : null;
  const baseUrl = resolveEnv(cwd, 'KB_ASK_BASE_URL');
  const apiKey = resolveEnv(cwd, 'KB_ASK_API_KEY'); // optional — sent as x-api-key when present

  if (!question) out({ result: 'BLOCKED', reason: 'question is required', project }, 2);
  if (!project) out({ result: 'BLOCKED', reason: 'no project: pass --project, set KB_PROJECT in .env, or kb.project in agentex.config.json' }, 2);
  if (!baseUrl) out({ result: 'BLOCKED', reason: 'KB_ASK_BASE_URL is not set (env or .env)' }, 2);

  const r = await askKb({ baseUrl, project, question, org, model, apiKey, timeoutMs, retries });

  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, [
        `POST ${baseUrl.replace(/\/$/, '')}/api/kb/ask`,
        `project=${project} org=${org} model=${model}`,
        `question=${question}`,
        `status=${r.status}`,
        `body=${r.text || r.error || ''}`,
      ].join('\n'));
    } catch {}
  }

  if (r.status === 200 && r.json && r.json.success) {
    const cached = !!r.json.cached;
    const covered = r.json.hasContext !== false && r.json.isNoAnswer !== true;
    if (!covered) {
      return outAsync({ result: 'NOT_COVERED', project, hasContext: !!r.json.hasContext, isNoAnswer: !!r.json.isNoAnswer, sources: r.json.sources || [], cached, logPath }, 0);
    }
    return outAsync({ result: 'OK', project, hasContext: true, isNoAnswer: false, answer: r.json.answer, sources: r.json.sources || [], cached, logPath }, 0);
  }
  if (r.status === 401) {
    return outAsync({ result: 'BLOCKED', project, status: 401, reason: (r.json && r.json.error) || 'Unauthorized — set/fix KB_ASK_API_KEY in .env', logPath }, 2);
  }
  if (r.status === 400 || r.status === 404) {
    return outAsync({ result: 'BLOCKED', project, status: r.status, reason: (r.json && r.json.error) || r.text || 'client error', logPath }, 2);
  }
  if (r.status === 200) {
    return outAsync({ result: 'BLOCKED', project, status: 200, reason: (r.json && r.json.error) || 'unexpected 200 response shape', logPath }, 2);
  }
  return outAsync({ result: 'BLOCKED', project, status: r.status, reason: (r.json && r.json.error) || r.error || 'transient error after retries', transient: true, logPath }, 2);
}

main().catch(e => {
  console.log(JSON.stringify({ result: 'BLOCKED', reason: String((e && e.message) || e) }));
  process.exitCode = 2;
});
