#!/usr/bin/env node
// annotate-image.js — draw the defect onto a COPY of a screenshot before it is attached to
// an Azure bug: a red box + edge label on the defect, optional green box(es) on something
// correct for comparison, and a dark-red one-line summary banner above the image. The
// agent supplies only boxes + text (SKILL.md Phase A step 3); this script owns the look.
//
// Renders through the project's own playwright-cli (<cwd>/node_modules/@playwright/cli,
// run as `node <bin>`: no npx — which would fetch the deprecated `playwright-cli` package
// when it is missing — and no shell, so no cmd quoting) in its own -s= session:
// open -> run-code -> close. run-code serves the screenshot through page.route and loads
// the overlay with page.setContent, because open/goto refuse file: URLs. Success is judged
// by the OUTPUT FILE (source width, taller by the banner), never by exit code: on Windows
// the CLI can exit non-zero after a successful call (benign UV_HANDLE_CLOSING, see
// skills/test-execution/scripts/preflight.js).
//
// Usage: node annotate-image.js --spec <file>.json
//   { "image": "<png|jpg>", "banner": "<the bug's one-line summary>",
//     "boxes": [{ "x", "y", "width", "height", "label", "ok"?: true }] }
//   Box values are % of the image (the model sees large screenshots downscaled) and are
//   clamped into it. ok:true = green (correct), default red (the defect); the script
//   appends the mark.
// Writes <specDir>/<specStem>.annotated.png: never the source, and a re-render replaces it.
//
// Output: ONE JSON line. Exit codes:
//   0 = annotated | 1 = not rendered (no playwright-cli / render failed) | 2 = bad spec or image
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CHECK_IMAGE = path.join(__dirname, 'check-image.js');
const CRASH_TEXT = /Assertion failed|UV_HANDLE_CLOSING/; // the benign exit crash, as in preflight.js
const RED = '#dc2626';
const GREEN = '#16a34a';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fail = (code, reason, message, detail) =>
  ({ code, out: { ok: false, error: { reason, message, ...(detail ? { detail } : {}) } } });

// Pass 1's structural check, reused: validity + real dimensions for PNG and JPEG.
function imageInfo(file) {
  const r = spawnSync(process.execPath, [CHECK_IMAGE, '--json', file], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout)[0]; } catch { return null; }
}

function specProblems(spec) {
  const problems = [];
  if (typeof spec.banner !== 'string' || !spec.banner.trim()) problems.push('banner must be a non-empty string');
  if (!Array.isArray(spec.boxes) || spec.boxes.length === 0) problems.push('boxes must be a non-empty array');
  else spec.boxes.forEach((b, i) => {
    const nums = b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]));
    if (!nums || b.width <= 0 || b.height <= 0) problems.push(`boxes[${i}]: x, y, width, height must be numbers (% of the image), width/height > 0`);
    if (!b || typeof b.label !== 'string' || !b.label.trim()) problems.push(`boxes[${i}]: label must be a non-empty string`);
  });
  return problems;
}

// The overlay page. The viewport is set to the image width, so 1vw = 1% of the image.
function overlayHtml(spec) {
  const boxes = spec.boxes.map((raw) => {
    const x = Math.min(Math.max(raw.x, 0), 99);
    const y = Math.min(Math.max(raw.y, 0), 99);
    const b = { ...raw, x, y, width: Math.min(raw.width, 100 - x), height: Math.min(raw.height, 100 - y) };
    const color = b.ok ? GREEN : RED;
    const right = b.x + b.width / 2 > 50; // right half: hang the label off the box's right edge
    const place = [
      b.y < 5 ? 'top:100%' : 'bottom:100%', // no room above: below the box
      right ? 'right:0' : 'left:0',
      `max-width:${right ? b.x + b.width : 100 - b.x}vw`, // never past the image edge
    ].join(';');
    return `<div class="x" style="left:${b.x}%;top:${b.y}%;width:${b.width}%;height:${b.height}%;border-color:${color}">`
      + `<b dir="auto" style="background:${color};${place}">${esc(b.label)} ${b.ok ? '✓' : '✗'}</b></div>`;
  }).join('');
  return '<!doctype html><meta charset="utf-8"><style>'
    + 'body{margin:0}#f{width:100vw;font-family:system-ui,"Segoe UI",Roboto,Arial,sans-serif}'
    + '#b{background:#b91c1c;color:#fff;font-weight:700;font-size:max(16px,1.3vw);line-height:1.35;padding:.6em 1em}'
    + '#i{position:relative}#i>img{display:block;width:100vw}'
    + '.x{position:absolute;box-sizing:border-box;border:max(3px,.25vw) solid;border-radius:4px}'
    + '.x>b{position:absolute;width:max-content;color:#fff;font-size:max(13px,1.05vw);line-height:1.3;padding:.15em .5em;border-radius:3px}'
    + `</style><div id="f"><div id="b" dir="auto">${esc(spec.banner)}</div>`
    + `<div id="i"><img src="http://agentex.invalid/i">${boxes}</div></div>`;
}

// The project's own @playwright/cli, or null when it is not installed there.
function projectCli(cwd) {
  const dir = path.join(cwd, 'node_modules', '@playwright', 'cli');
  let bin;
  try { bin = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).bin; } catch { return null; }
  const rel = typeof bin === 'string' ? bin : bin && bin['playwright-cli'];
  if (!rel || !fs.existsSync(path.join(dir, rel))) return null;
  return (args, { timeoutMs }) => {
    const r = spawnSync(process.execPath, [path.join(dir, rel), ...args], {
      cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    return { status: r.status, output: [r.stdout, r.stderr, r.error && r.error.message].filter(Boolean).join('\n') };
  };
}

// Returns { code, out }; prints nothing. opts.runCli is the offline-test seam.
function run(argv, { cwd = process.cwd(), runCli } = {}) {
  const at = argv.indexOf('--spec');
  const specArg = at === -1 ? undefined : argv[at + 1];
  if (!specArg) return fail(2, 'usage', '--spec <file>.json is required');
  let spec;
  try { spec = JSON.parse(fs.readFileSync(path.resolve(cwd, specArg), 'utf8')); }
  catch (e) { return fail(2, 'bad-spec', `could not read spec: ${e.message}`); }
  if (!spec || typeof spec.image !== 'string' || !spec.image) return fail(2, 'bad-spec', 'image must be the screenshot path');

  const image = path.resolve(cwd, spec.image);
  const info = imageInfo(image);
  if (!info || !info.ok) return fail(2, 'image-invalid', `${spec.image}: ${info ? info.issues.join(', ') : 'unreadable'}`);
  const problems = specProblems(spec);
  if (problems.length) return fail(2, 'bad-spec', problems.join('; '));

  const annotated = path.join(path.dirname(specArg), `${path.parse(specArg).name}.annotated.png`);
  const out = path.resolve(cwd, annotated);
  if (out.toLowerCase() === image.toLowerCase()) {
    return fail(2, 'would-overwrite-source', `${annotated} is the source screenshot; rename the spec`);
  }

  const cli = runCli || projectCli(cwd);
  if (!cli) {
    return fail(1, 'playwright-cli-unavailable', `@playwright/cli is not in ${path.join(cwd, 'node_modules')}: not rendered, attach the raw screenshot`);
  }

  fs.rmSync(out, { force: true }); // a stale render can never pass for this one
  const code = [
    'async page => {',
    `await page.setViewportSize({ width: ${info.width}, height: ${info.height} });`,
    `await page.route('http://agentex.invalid/i', (r) => r.fulfill({ path: ${JSON.stringify(image)} }));`,
    `await page.setContent(${JSON.stringify(overlayHtml(spec))});`,
    "const w = await page.$eval('#i>img', (i) => i.naturalWidth);",
    `if (w !== ${info.width}) throw new Error('the screenshot did not load into the page (naturalWidth ' + w + ')');`,
    `await page.locator('#f').screenshot({ path: ${JSON.stringify(out)}, scale: 'css' });`,
    '}',
  ].join(' ');

  // Own session, closed even on failure. open + run-code share one 90 s deadline and close
  // gets 15 s, so a run stays inside the Bash tool's 120 s kill and never orphans a browser.
  const session = `-s=annotate-${process.pid}-${Date.now().toString(36)}`;
  const deadline = Date.now() + 90_000;
  let log = '';
  try {
    for (const args of [['open'], ['run-code', code]]) {
      log += `${cli([session, ...args], { timeoutMs: Math.max(1_000, deadline - Date.now()) }).output}\n`;
    }
  } catch (e) {
    log += e.message;
  } finally {
    cli([session, 'close'], { timeoutMs: 15_000 });
  }

  const got = fs.existsSync(out) ? imageInfo(out) : null;
  if (!got || !got.ok || got.width !== info.width || got.height <= info.height) {
    fs.rmSync(out, { force: true }); // never leave a wrong image where it could be attached
    const detail = log.split('\n').map((l) => l.trim()).filter((l) => l && !CRASH_TEXT.test(l)).join(' ').slice(-400);
    return fail(1, 'render-failed', got
      ? `rendered ${got.width}x${got.height}, expected width ${info.width} and height > ${info.height}`
      : 'no annotated image was produced', detail);
  }
  return { code: 0, out: { ok: true, image: spec.image, annotated, width: got.width, height: got.height } };
}

module.exports = { run };

if (require.main === module) {
  const { code, out } = run(process.argv.slice(2));
  console.log(JSON.stringify(out));
  process.exitCode = code;
}
