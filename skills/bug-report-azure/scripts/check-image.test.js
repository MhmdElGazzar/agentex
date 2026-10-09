'use strict';
// Self-contained tests for check-image.js — Pass 1 (structural) screenshot
// validation. Fully offline and dependency-free: fixtures are synthesized
// PNG/JPEG buffers; the script is spawned as the CLI it is (it has no module
// export — it is a pure filter with no tracker coupling, unchanged by the
// tracker-lib rebuild). Run: node skills/bug-report-azure/scripts/check-image.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'check-image.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-ci-'));

// PNG with a real IHDR (width x height) + an IDAT of `idatLen` bytes + padding.
function png(width, height, { idatLen = 4096, pad = 0 } = {}) {
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const ihdr = Buffer.alloc(4 + 4 + 13 + 4);
  ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8); ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; ihdr[17] = 6; // bit depth 8, color type 6 (RGBA)
  chunks.push(ihdr);
  const idat = Buffer.alloc(4 + 4 + idatLen + 4);
  idat.writeUInt32BE(idatLen, 0); idat.write('IDAT', 4);
  for (let i = 0; i < idatLen; i++) idat[8 + i] = (i * 31) % 251;
  chunks.push(idat);
  const iend = Buffer.alloc(12); iend.writeUInt32BE(0, 0); iend.write('IEND', 4);
  chunks.push(iend);
  if (pad) chunks.push(Buffer.alloc(pad));
  return Buffer.concat(chunks);
}

function write(name, buf) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, buf);
  return p;
}

function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function runJson(args) {
  const r = runCli(['--json', ...args]);
  return { status: r.status, results: JSON.parse(r.stdout) };
}

const GOOD = write('good.png', png(1280, 720, { idatLen: 16384 }));
const TINY = write('tiny.png', png(4, 4, { idatLen: 16 }));
const ZERO = write('zero.png', png(0, 0));
const BLANK = write('blank.png', png(1920, 1080, { idatLen: 64, pad: 8192 }));
const NOTIMG = write('not-image.png', Buffer.alloc(5000, 0x41));

test('a real screenshot-shaped PNG passes with its dimensions', () => {
  const { status, results } = runJson([GOOD]);
  assert.strictEqual(status, 0);
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[0].format, 'png');
  assert.strictEqual(results[0].width, 1280);
  assert.strictEqual(results[0].height, 720);
  assert.deepStrictEqual(results[0].issues, []);
});

test('bad magic bytes are not-an-image', () => {
  const { results } = runJson([NOTIMG]);
  assert.strictEqual(results[0].ok, false);
  assert.deepStrictEqual(results[0].issues, ['not-an-image']);
});

test('a 0x0 capture and a tiny file are hard-invalid', () => {
  const { results } = runJson([ZERO, TINY]);
  assert.strictEqual(results[0].ok, false);
  assert.ok(results[0].issues.includes('zero-dimension'));
  assert.strictEqual(results[1].ok, false);
  assert.ok(results[1].issues.includes('too-small'));
});

test('a missing file reports not-found instead of throwing', () => {
  const { results } = runJson([path.join(TMP, 'ghost.png')]);
  assert.strictEqual(results[0].ok, false);
  assert.deepStrictEqual(results[0].issues, ['not-found']);
});

test('likely-blank is a WARNING: flagged but still structurally ok', () => {
  const { results } = runJson([BLANK]);
  assert.ok(results[0].issues.includes('likely-blank'));
  assert.strictEqual(results[0].ok, true, 'the vision pass decides, not the script');
});

test('--strict exits 1 only when something is hard-invalid', () => {
  assert.strictEqual(runCli(['--strict', GOOD, BLANK]).status, 0, 'warnings do not fail strict');
  assert.strictEqual(runCli(['--strict', GOOD, NOTIMG]).status, 1);
});

test('--dir scans only image files in the folder', () => {
  fs.writeFileSync(path.join(TMP, 'notes.txt'), 'not an image');
  const { results } = runJson(['--dir', TMP]);
  assert.ok(results.length >= 5);
  assert.ok(results.every((r) => /\.(png|jpe?g)$/i.test(r.file)));
});

test('no files at all is a usage error (exit 2)', () => {
  assert.strictEqual(runCli([]).status, 2);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
