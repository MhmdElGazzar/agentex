'use strict';
// Self-contained tests for annotate-image.js — the annotated copy of a bug screenshot.
// Offline: the playwright-cli calls go through an injected runCli stub (the same seam
// shape as scripts/self_update.js); spawned runs pin the one-JSON-line CLI contract.
// Fixtures are synthesized PNGs. One opt-in test renders for real through a project that
// has @playwright/cli installed:
//   AGENTEX_PWCLI_PROJECT=<project dir> node skills/bug-report-azure/scripts/annotate-image.test.js
// Run: node skills/bug-report-azure/scripts/annotate-image.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { run } = require('./annotate-image.js');

const SCRIPT = path.join(__dirname, 'annotate-image.js');
let passed = 0; const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-annotate-'));

// ── PNG builder — a real, decodable PNG (correct CRCs); noise keeps it past the 2KB floor ──
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter none
    for (let i = 1; i <= width * 4; i++) raw[rowStart + i] = Math.floor(Math.random() * 256);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const W = 400, H = 300;
const SRC = path.join(TMP, 'shot.png');
fs.writeFileSync(SRC, makePng(W, H));
const SRC_BYTES = fs.readFileSync(SRC);
const GOOD = {
  image: SRC,
  banner: 'Checkout total shows <b>$0.00</b> after a discount code',
  boxes: [
    { x: 10, y: 20, width: 50, height: 30, label: 'Expected "Total: $42.00" — actual "Total: $0.00"' },
    { x: 70, y: 2, width: 25, height: 6, label: 'Discount <ok> applied', ok: true },
  ],
};

function writeSpec(name, spec) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, typeof spec === 'string' ? spec : JSON.stringify(spec));
  return p;
}

// runCli stub: records every call; run-code writes `png` (if any) to `out`, then answers
// like the real CLI on Windows/Node 24 by default — the benign exit crash (status 134).
function stubCli({ out, png, status = 134, throwOnRunCode = false }) {
  const calls = [];
  const cli = (args, { timeoutMs }) => {
    calls.push({ args, timeoutMs });
    if (args[1] === 'run-code') {
      if (throwOnRunCode) throw new Error('run-code blew up');
      if (png) fs.writeFileSync(out, png);
    }
    return { status, output: status === 134 ? 'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76' : '' };
  };
  return { cli, calls };
}

function spawnRun(args, cwd = TMP) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  const lines = r.stdout.trim().split('\n');
  return { status: r.status, lines, out: JSON.parse(lines[lines.length - 1]) };
}

test('renders: success judged by the output PNG, not the exit crash; one session, closed last', () => {
  const spec = writeSpec('bug-1-shot.json', GOOD);
  const out = path.join(TMP, 'bug-1-shot.annotated.png');
  const { cli, calls } = stubCli({ out, png: makePng(W, H + 40) });
  const { code, out: res } = run(['--spec', spec], { cwd: TMP, runCli: cli });
  assert.strictEqual(code, 0, JSON.stringify(res));
  assert.deepStrictEqual([res.ok, res.annotated, res.width, res.height], [true, out, W, H + 40]);
  assert.ok(fs.readFileSync(SRC).equals(SRC_BYTES), 'the source screenshot is untouched');
  assert.deepStrictEqual(calls.map((c) => c.args[1]), ['open', 'run-code', 'close']);
  assert.match(calls[0].args[0], /^-s=annotate-/);
  assert.strictEqual(new Set(calls.map((c) => c.args[0])).size, 1, 'the same own session on every call');
  assert.ok(calls.every((c) => !c.args.some((a) => a === 'close-all' || a === 'kill-all')));
  assert.ok(calls[0].timeoutMs <= 90_000 && calls[1].timeoutMs <= calls[0].timeoutMs && calls[2].timeoutMs <= 15_000,
    'open + run-code share one 90 s deadline, close gets 15 s');
});

test('the overlay escapes every text, marks red ✗ / green ✓, and clamps boxes into the image', () => {
  const spec = writeSpec('bug-2-shot.json', { ...GOOD, boxes: [...GOOD.boxes, { x: -5, y: 95, width: 120, height: 20, label: 'edge' }] });
  const { cli, calls } = stubCli({ out: path.join(TMP, 'bug-2-shot.annotated.png'), png: makePng(W, H + 40) });
  assert.strictEqual(run(['--spec', spec], { cwd: TMP, runCli: cli }).code, 0);
  const code = calls[1].args[2];
  assert.ok(code.includes('&lt;b&gt;$0.00&lt;/b&gt;') && !code.includes('<b>$0.00'), 'banner escaped');
  assert.ok(code.includes('Discount &lt;ok&gt; applied ✓') && code.includes('$0.00\\" ✗'), 'labels escaped + marked');
  assert.ok(code.includes('#16a34a') && code.includes('#dc2626') && code.includes('dir='));
  assert.ok(code.includes('left:0%;top:95%;width:100%;height:5%'), 'clamped into the image');
});

test('a wrong-size or missing output FAILS even when the CLI exits 0 — and is removed', () => {
  const spec = writeSpec('bug-3-shot.json', GOOD);
  const out = path.join(TMP, 'bug-3-shot.annotated.png');
  for (const png of [makePng(W + 8, H + 40), makePng(W, H), null]) {
    const { cli, calls } = stubCli({ out, png, status: 0 });
    const { code, out: res } = run(['--spec', spec], { cwd: TMP, runCli: cli });
    assert.strictEqual(code, 1);
    assert.strictEqual(res.error.reason, 'render-failed');
    assert.ok(!fs.existsSync(out), 'no wrong image left where it could be attached');
    assert.strictEqual(calls[calls.length - 1].args[1], 'close');
  }
});

test('a stale output from an earlier render never passes for this one; close runs after a throw', () => {
  const spec = writeSpec('bug-4-shot.json', GOOD);
  const out = path.join(TMP, 'bug-4-shot.annotated.png');
  fs.writeFileSync(out, makePng(W, H + 40)); // looks exactly like a success
  const { cli, calls } = stubCli({ out, throwOnRunCode: true });
  const { code, out: res } = run(['--spec', spec], { cwd: TMP, runCli: cli });
  assert.strictEqual(code, 1);
  assert.strictEqual(res.error.reason, 'render-failed');
  assert.match(res.error.detail, /run-code blew up/);
  assert.ok(!fs.existsSync(out));
  assert.deepStrictEqual(calls.map((c) => c.args[1]), ['open', 'run-code', 'close']);
});

test('a bad spec is BLOCKED (exit 2, one JSON line) before any render, writing nothing', () => {
  const box = { x: 1, y: 1, width: 5, height: 5, label: 'l' };
  const cases = [
    [[], 'usage'],
    [['--spec', writeSpec('bad-json.json', '{ not json')], 'bad-spec'],
    [['--spec', writeSpec('bad-banner.json', { ...GOOD, banner: ' ' })], 'bad-spec'],
    [['--spec', writeSpec('bad-boxes.json', { ...GOOD, boxes: [] })], 'bad-spec'],
    [['--spec', writeSpec('bad-number.json', { ...GOOD, boxes: [{ ...box, x: '10' }] })], 'bad-spec'],
    [['--spec', writeSpec('bad-size.json', { ...GOOD, boxes: [{ ...box, width: 0 }] })], 'bad-spec'],
    [['--spec', writeSpec('bad-label.json', { ...GOOD, boxes: [{ ...box, label: '' }] })], 'bad-spec'],
  ];
  const before = fs.readdirSync(TMP).sort();
  for (const [args, reason] of cases) {
    const r = spawnRun(args);
    assert.strictEqual(r.status, 2, JSON.stringify(r.out));
    assert.strictEqual(r.lines.length, 1, 'exactly one JSON line');
    assert.deepStrictEqual([r.out.ok, r.out.error.reason], [false, reason]);
  }
  assert.deepStrictEqual(fs.readdirSync(TMP).sort(), before, 'nothing written');
});

test('a missing screenshot is BLOCKED with check-image\'s not-found', () => {
  const r = spawnRun(['--spec', writeSpec('ghost.json', { ...GOOD, image: path.join(TMP, 'ghost.png') })]);
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.out.error.reason, 'image-invalid');
  assert.match(r.out.error.message, /not-found/);
});

test('never overwrites the source: a spec whose output IS the screenshot is BLOCKED', () => {
  const img = path.join(TMP, 'twin.annotated.png');
  fs.writeFileSync(img, makePng(W, H));
  const bytes = fs.readFileSync(img);
  const r = spawnRun(['--spec', writeSpec('twin.json', { ...GOOD, image: img })]);
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.out.error.reason, 'would-overwrite-source');
  assert.ok(fs.readFileSync(img).equals(bytes));
});

test('no @playwright/cli in the project: exit 1, one JSON line, and no install offered', () => {
  const r = spawnRun(['--spec', writeSpec('bug-5-shot.json', GOOD)]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.lines.length, 1);
  assert.strictEqual(r.out.error.reason, 'playwright-cli-unavailable');
  assert.doesNotMatch(r.out.error.message, /npm|install/i, 'filing never turns into an install');
});

test('never force-exits (Windows/Node 24 libuv crash): no process.exit( in the source', () => {
  assert.ok(!fs.readFileSync(SCRIPT, 'utf8').includes('process.exit('));
});

const PW = process.env.AGENTEX_PWCLI_PROJECT;
if (PW && fs.existsSync(path.join(PW, 'node_modules', '@playwright', 'cli', 'package.json'))) {
  test('real render through the project\'s playwright-cli (opt-in)', () => {
    const r = spawnRun(['--spec', writeSpec('bug-6-shot.json', GOOD)], PW);
    assert.strictEqual(r.status, 0, JSON.stringify(r.out));
    assert.strictEqual(r.out.width, W);
    assert.ok(r.out.height > H, 'taller by the banner');
    assert.ok(fs.existsSync(r.out.annotated));
    assert.ok(fs.readFileSync(SRC).equals(SRC_BYTES));
  });
} else {
  console.log('  skip - real render: set AGENTEX_PWCLI_PROJECT to a project with @playwright/cli');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
process.exitCode = failures.length ? 1 : 0;
