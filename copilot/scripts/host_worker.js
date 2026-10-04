'use strict';

// Copilot-owned browser executor. The shared coordinator still owns allocation,
// scheduling, finalization and cleanup verification. This module owns only the
// assigned session and refuses to pass a spec whose instructions it cannot parse.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { resolveRuntime } = require('./resolve_runtime.js');

const hash = body => crypto.createHash('sha256').update(body).digest('hex');
const relativeEvidence = (assignment, file) =>
  path.relative(assignment.executionDir, file).replace(/\\/g, '/');

function parseInstruction(raw) {
  const text = raw.trim().replace(/[.;]$/, '').replace(/^and\s+/i, '')
    .replace(/\s+and computed visible$/i, '');
  if (/^open\b/i.test(text) && !/\b(?:and|then)\b/i.test(text)) return { type: 'open', desc: text };
  let match = text.match(/^click\s+(?:the\s+)?(?:button\s+)?(?:`([^`]+)`|“([^”]+)”|"([^"]+)"|(.+?))(?:\s+once)?$/i);
  if (match) return { type: 'click', value: (match[1] || match[2] || match[3] || match[4]).trim(), desc: text };
  match = text.match(/^(?:verify|check|assert|expect)\s+(?:that\s+)?(?:the\s+)?(?:text\s+)?(?:`([^`]+)`|“([^”]+)”|"([^"]+)"|(.+?))\s+(?:is\s+)?(?:visible|present|appears|displayed)$/i);
  if (match) return { type: 'visible', value: (match[1] || match[2] || match[3] || match[4]).trim(), desc: text };
  match = text.match(/^(?:verify|check|assert|expect)\s+(?:the\s+)?(?:count\s+)?text\s+is\s+(?:`([^`]+)`|"([^"]+)"|(.+))$/i);
  if (match) return { type: 'visible', value: (match[1] || match[2] || match[3]).trim(), desc: text };
  match = text.match(/^(?:verify|check|assert|expect|compare)\s+(?:the\s+)?visible\s+(?:confirmation\s+)?text\s+(?:with|to|is)\s+(?:`([^`]+)`|"([^"]+)"|(.+))$/i);
  if (match) return { type: 'visible', value: (match[1] || match[2] || match[3]).trim(), desc: text };
  if (/^(?:no|verify no)\s+console error(?:s)?\s+or\s+failed request(?:s)?\s+occurs?$/i.test(text)) {
    return { type: 'browser-errors', desc: text };
  }
  return null;
}

function splitInstruction(line) {
  // Commas and conjunctions separate actions only outside quoted literals.
  const parts = [];
  let quote = null, current = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (['`', '"', '“', '”'].includes(char)) {
      if (quote === char || (quote === '“' && char === '”')) quote = null;
      else if (!quote) quote = char;
    }
    if (!quote && (char === ',' || char === ';')) { parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.flatMap(part => part.split(/\s+and\s+(?=(?:verify|check|assert|expect|click|open|compare)\b)/i))
    .map(part => part.trim()).filter(Boolean);
}

function parseSpec(body) {
  const lines = body.split(/\r?\n/);
  if (!/^\s*#\s*Spec\s*:/im.test(body) || !/^\s*##\s*Scenarios?\b/im.test(body)) {
    throw new Error('not an AgenTeX saved Markdown spec');
  }
  const scenarioLines = [], scenarioProse = [], acceptanceLines = [], acceptanceProse = [];
  let section = '', scenarioSections = 0, unsupportedSection = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) { if (/^scenarios?\b/i.test(heading[1])) scenarioSections++;
      section = /^scenarios?\b/i.test(heading[1]) ? 'scenario' :
      /^acceptance (?:criteria|criterion)\b/i.test(heading[1]) ? 'acceptance' : 'unsupported'; continue; }
    if (/^#{3,6}\s/.test(line) && ['scenario', 'acceptance'].includes(section)) {
      throw new Error('nested instructions require an explicit supported scenario format');
    }
    if (/^#{1,6}\s/.test(line)) { section = ''; continue; }
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)/);
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (section === 'scenario' && (numbered || bullet)) scenarioLines.push((numbered || bullet)[1]);
    if (section === 'scenario' && !numbered && !bullet && line.trim()) scenarioProse.push(line.trim());
    if (section === 'acceptance' && bullet) acceptanceLines.push(bullet[1]);
    if (section === 'acceptance' && !bullet && line.trim()) acceptanceProse.push(line.trim());
    if (section === 'unsupported' && line.trim()) unsupportedSection = true;
  }
  if (unsupportedSection) throw new Error('unsupported specification section');
  if (scenarioSections !== 1) throw new Error('this host worker requires one explicit scenario section');
  if (!scenarioLines.length) throw new Error('no numbered scenario steps');
  const steps = [];
  const add = (raw, origin) => {
    let parsed = parseInstruction(raw);
    if (!parsed && /^(?:and\s+)?verify the visible confirmation text\.?$/i.test(raw)) {
      const expected = acceptanceLines.join(' ').match(/displays\s+`([^`]+)`/i);
      if (expected) parsed = { type: 'visible', value: expected[1], desc: raw };
    }
    if (!parsed) throw new Error(`unsupported ${origin} instruction at step ${steps.length + 1}`);
    steps.push({ ...parsed, id: `step-${steps.length + 1}` });
  };
  for (const line of scenarioLines) for (const part of splitInstruction(line)) add(part, 'scenario');
  // Acceptance criteria can add assertions, but not extra actions. A request
  // to act there without an executable scenario step is rejected, not skipped.
  for (const line of acceptanceLines) {
    const value = line.trim().replace(/[.;]$/, '');
    if (/^no console error/i.test(value)) { add(value, 'acceptance'); continue; }
    let match = value.match(/^the\s+(.+?)\s+(?:is present|is visible|appears)$/i);
    if (match) { add(`Verify ${match[1].replace(/\s+heading$/i, '')} is visible`, 'acceptance'); continue; }
    match = value.match(/^clicking\s+(.+?)\s+once\s+changes\s+the\s+count\s+from\s+.+?\s+to\s+(?:visible\s+)?(`[^`]+`|"[^"]+")/i);
    if (match) { add(`Verify ${match[2]} is visible`, 'acceptance'); continue; }
    match = value.match(/^clicking\s+.+?\s+displays\s+(`[^`]+`|"[^"]+")/i);
    if (match) { add(`Verify ${match[1]} is visible`, 'acceptance'); continue; }
    throw new Error('unsupported acceptance criterion');
  }
  if (acceptanceProse.length) {
    const prose = acceptanceProse.join(' ');
    const expected = prose.match(/visible\s+paragraph\s+must\s+read\s+`([^`]+)`/i);
    if (expected) add(`Verify \`${expected[1]}\` is visible`, 'acceptance');
    else throw new Error('unsupported acceptance criterion');
  }
  const directives = { screenshotName: 'evidence.png', browserLogs: false };
  if (scenarioProse.length) {
    const prose = scenarioProse.join(' ');
    const screenshot = prose.match(/capture a screenshot named\s+`([A-Za-z0-9._-]+\.png)`/i);
    if (!screenshot || !/console and request logs/i.test(prose) ||
      !/close only the assigned session/i.test(prose) ||
      !/do not access any other host or change source/i.test(prose)) {
      throw new Error('unsupported scenario directive');
    }
    directives.screenshotName = screenshot[1];
    directives.browserLogs = true;
  }
  if (steps[0].type !== 'open') throw new Error('first scenario action must open the configured application');
  return { digest: hash(body), steps, directives };
}

function validateCoverage(result, assignment) {
  const body = fs.readFileSync(path.resolve(assignment.workingDir, assignment.spec), 'utf8');
  let plan;
  try { plan = parseSpec(body); } catch (error) {
    return result.status === 'passed' ? [`unexecutable source spec: ${error.message}`] : [];
  }
  if (result.status !== 'passed') return [];
  const expected = plan.steps.map(step => step.id);
  const actual = result.coverage?.executedStepIds;
  if (result.coverage?.specSha256 !== plan.digest || !Array.isArray(actual) ||
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    result.scenarios?.flatMap(s => s.steps || []).filter(s => s.status === 'passed').length < expected.length) {
    return ['passed result omits required source spec steps'];
  }
  if (plan.directives.browserLogs) {
    for (const file of ['console.txt', 'requests.txt']) {
      if (!fs.existsSync(path.join(assignment.sessionDir, 'logs', file))) return ['passed result omits required browser logs'];
    }
  }
  if (!fs.existsSync(path.join(assignment.sessionDir, 'screenshots', plan.directives.screenshotName))) {
    return ['passed result omits required screenshot'];
  }
  return [];
}

function command(assignment, args, timeoutMs = 30000) {
  const cli = assignment.playwrightCommand;
  return new Promise(resolve => {
    const child = spawn(cli.executable, [...cli.args, `-s=${assignment.session}`, ...args],
      { cwd: assignment.browserWorkingDir, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill(); done({ ok: false, stdout, stderr, error: 'CLI_TIMEOUT' }); }, timeoutMs);
    const done = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-131072); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-32768); });
    child.on('error', error => done({ ok: false, stdout, stderr, error: error.code || 'CLI_LAUNCH' }));
    child.on('close', code => done({ ok: code === 0, stdout, stderr, error: code === 0 ? null : `CLI_EXIT_${code}` }));
  });
}

function resultMarker(output) {
  const block = output.match(/### Result\r?\n([^\r\n]+)/);
  const value = block ? JSON.parse(block[1]) : output.trim();
  const match = String(value).match(/AGENTEX_STEP_RESULT:(\{[^\r\n]*\})/);
  if (!match) throw new Error('CLI did not return a structured step result');
  return JSON.parse(match[1]);
}

async function browserStep(assignment, step) {
  if (step.type === 'open') {
    const outcome = await command(assignment, ['open', assignment.targetUrl], 45000);
    return { ok: outcome.ok, infrastructure: !outcome.ok, error: outcome.error };
  }
  if (step.type === 'browser-errors') {
    const consoleOut = await command(assignment, ['console', 'error']);
    const requestsOut = await command(assignment, ['requests']);
    if (!consoleOut.ok || !requestsOut.ok) return { ok: false, infrastructure: true, error: consoleOut.error || requestsOut.error };
    const hasConsoleError = /\b(error|exception)\b/i.test(consoleOut.stdout.replace(/###?\s*Console.*?\n/i, '')) &&
      !/no (console )?errors/i.test(consoleOut.stdout);
    const hasFailedRequest = /\b(4\d\d|5\d\d|failed|net::ERR_)\b/i.test(requestsOut.stdout);
    return { ok: !hasConsoleError && !hasFailedRequest, infrastructure: false,
      error: hasConsoleError ? 'browser console error' : hasFailedRequest ? 'failed application request' : null };
  }
  const literal = JSON.stringify(step.value);
  const source = step.type === 'click'
    ? `async (page) => { const target = page.getByRole('button', {name:${literal}, exact:true}); const count = await target.count(); if (count !== 1 || !(await target.isVisible())) return 'AGENTEX_STEP_RESULT:'+JSON.stringify({ok:false, reason:'button absent or ambiguous'}); await target.click(); return 'AGENTEX_STEP_RESULT:'+JSON.stringify({ok:true}); }`
    : `async (page) => { const target = page.getByText(${literal}, {exact:true}); const count = await target.count(); let visible = false; for (let i=0;i<count;i++) if (await target.nth(i).isVisible()) { visible=true; break; } return 'AGENTEX_STEP_RESULT:'+JSON.stringify({ok:visible, reason:visible?null:'expected visible text absent'}); }`;
  const outcome = await command(assignment, ['run-code', source]);
  if (!outcome.ok) return { ok: false, infrastructure: true, error: outcome.error };
  try {
    const parsed = resultMarker(outcome.stdout);
    return { ok: parsed.ok === true, infrastructure: false, error: parsed.reason || null };
  } catch { return { ok: false, infrastructure: true, error: 'CLI_RESULT_MISSING' }; }
}

async function executeAssignment(assignment) {
  const started = Date.now(), startedAt = new Date(started).toISOString();
  const steps = [], failures = [], defects = [], screenshots = [], executedStepIds = [];
  let status = 'passed', plan;
  try {
    if (assignment.loginMode !== 'none') throw new Error('Copilot host worker requires an explicit executable login flow');
    const specFile = path.resolve(assignment.workingDir, assignment.spec);
    if (!specFile.startsWith(fs.realpathSync(assignment.workingDir) + path.sep)) throw new Error('spec escapes consumer project');
    plan = parseSpec(fs.readFileSync(specFile, 'utf8'));
    for (const step of plan.steps) {
      const outcome = await browserStep(assignment, step);
      const stepStatus = outcome.ok ? 'passed' : outcome.infrastructure ? 'blocked' : 'failed';
      steps.push({ desc: step.desc, status: stepStatus, ...(outcome.error ? { note: outcome.error } : {}) });
      if (!outcome.ok) {
        status = outcome.infrastructure ? 'blocked' : 'failed';
        failures.push({ kind: outcome.infrastructure ? 'infrastructure' : 'product',
          detail: outcome.error || 'browser assertion failed' });
        if (!outcome.infrastructure) defects.push({ title: `Expected browser result missing: ${step.desc}`,
          severity: 'Low', expected: step.value || step.desc, actual: outcome.error || 'not observed', evidence: [] });
        break;
      }
      executedStepIds.push(step.id);
    }
  } catch (error) {
    status = 'blocked';
    steps.push({ desc: 'Interpret assigned specification', status: 'blocked', note: error.message });
    failures.push({ kind: 'automation', detail: error.message });
  }
  if (plan) {
    const shot = path.join(assignment.artifacts.screenshots, plan.directives.screenshotName);
    const capture = await command(assignment, ['screenshot', `--filename=${shot}`]);
    if (capture.ok && fs.existsSync(shot)) screenshots.push({ path: relativeEvidence(assignment, shot), caption: 'Browser result' });
    if (plan.directives.browserLogs) {
      for (const [name, args] of [['console.txt', ['console', 'error']], ['requests.txt', ['requests']]]) {
        const observation = await command(assignment, args);
        fs.writeFileSync(path.join(assignment.artifacts.logs, name),
          `AgenTeX sanitized browser diagnostic\ncommandStatus=${observation.ok ? 'OK' : observation.error}\nbytes=${Buffer.byteLength(observation.stdout)}\nRaw content withheld.\n`,
          { flag: 'wx', mode: 0o600 });
      }
    }
  }
  const cleanup = await command(assignment, ['close']);
  if (!cleanup.ok && status === 'passed') status = 'blocked';
  if (!cleanup.ok) failures.push({ kind: 'infrastructure', detail: 'owned browser session cleanup failed' });
  const endedAt = new Date().toISOString();
  const result = { schemaVersion: 1, runDir: assignment.runDir, session: assignment.session, spec: assignment.spec,
    status, startedAt, endedAt, durationMs: Date.now() - started,
    scenarios: [{ name: path.basename(assignment.spec, '.md'), session: assignment.session, status,
      steps, screenshots }], defects, failures,
    cleanup: { attempted: true, closed: cleanup.ok, error: cleanup.ok ? null : cleanup.error },
    ...(plan ? { coverage: { specSha256: plan.digest, executedStepIds } } : {}) };
  fs.writeFileSync(assignment.artifacts.result, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return { outcome: 'completed' };
}

async function runCopilotParallel(options) {
  const runtime = resolveRuntime();
  const { runParallel } = require(path.join(runtime.coreRoot, 'skills', 'agentex-test', 'scripts', 'parallel.js'));
  return runParallel({ ...options, worker: executeAssignment, resultValidator: validateCoverage });
}

module.exports = { parseSpec, validateCoverage, executeAssignment, runCopilotParallel };
