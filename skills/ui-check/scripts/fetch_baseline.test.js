'use strict';
// Tests for fetch_baseline.js — baseline resolution/validation for ui-check: steps.
// Run: node skills/ui-check/scripts/fetch_baseline.test.js
// The script's Figma API base is overridable via FIGMA_API_BASE (test seam) so the
// suite runs against a local mock server — no network, no real token.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const RUNNER = path.join(__dirname, 'fetch_baseline.js');
let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures.push(name); console.error(`  FAIL - ${name}: ${e.message}`); }
}

// ── PNG builder — a real, decodable PNG (correct CRCs), sized past the 2KB floor ──
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
// noise=true → incompressible pixels (never "likely blank"); false → uniform white.
function makePng(width, height, { noise = true } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter none
    for (let i = 1; i <= width * 4; i++) {
      raw[rowStart + i] = noise ? Math.floor(Math.random() * 256) : 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── fixture project + runner ──────────────────────────────────────────────────
function proj(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-uicheck-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' || Buffer.isBuffer(content)
      ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
const FIGMA_CONFIG = {
  name: 'fixture', defaultEnvironment: 'qa',
  figma: { fileKey: 'FILEKEY123', token: { envSecret: 'FIGMA_TOKEN' } },
};
function run(cwd, args, extraEnv = {}) {
  return new Promise(resolve => {
    const env = { ...process.env };
    delete env.FIGMA_TOKEN; delete env.FIGMA_API_BASE;
    Object.assign(env, extraEnv);
    const p = spawn(process.execPath, [RUNNER, ...args], { cwd, env });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', code => {
      const line = out.trim().split('\n').filter(Boolean).pop() || '{}';
      let json; try { json = JSON.parse(line); } catch { json = { unparsed: out + err }; }
      resolve({ code, out: json, raw: out + err });
    });
  });
}
// Mock Figma API: /v1/files/<key>/nodes, /v1/images/<key>, and /render/* PNG hosting.
function figmaServer({ nodes, renderPng, imagesErr } = {}) {
  const calls = [];
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      calls.push({ url: req.url, token: req.headers['x-figma-token'] || null });
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith('/v1/files/')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ nodes: nodes || {} }));
      } else if (u.pathname.startsWith('/v1/images/')) {
        res.setHeader('content-type', 'application/json');
        if (imagesErr) { res.end(JSON.stringify({ err: imagesErr, images: {} })); return; }
        const ids = (u.searchParams.get('ids') || '').split(',');
        const images = {};
        for (const id of ids) images[id] = `http://127.0.0.1:${srv.address().port}/render/${encodeURIComponent(id)}.png`;
        res.end(JSON.stringify({ err: null, images }));
      } else if (u.pathname.startsWith('/render/')) {
        res.setHeader('content-type', 'image/png');
        res.end(renderPng || makePng(200, 400));
      } else { res.statusCode = 404; res.end('{}'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, calls }));
  });
}
const FRAME_NODE = (id, name, w, h, type = 'FRAME', children) => ({
  [id]: { document: { id, name, type, absoluteBoundingBox: { x: 0, y: 0, width: w, height: h }, ...(children ? { children } : {}) } },
});

(async () => {
  // ── image source ─────────────────────────────────────────────────────────────
  await test('image source: valid PNG copied to --out with dims, exit 0', async () => {
    const png = makePng(300, 500);
    const dir = proj({ 'test/baselines/checkout.png': png });
    const outFile = path.join(dir, 'ev', 'baseline.png');
    const { code, out } = await run(dir, ['--source', 'image', '--path', 'test/baselines/checkout.png',
      '--out', outFile, '--log', path.join(dir, 'ev', 'check.log')]);
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.result, 'OK');
    assert.strictEqual(out.width, 300);
    assert.strictEqual(out.height, 500);
    assert.strictEqual(out.baseline, outFile);
    assert.ok(fs.existsSync(outFile), 'baseline copied to --out');
    assert.ok(fs.readFileSync(outFile).equals(png), 'copied bytes identical');
  });

  await test('image source: missing file -> BLOCKED naming the path, exit 2', async () => {
    const dir = proj({});
    const { code, out } = await run(dir, ['--source', 'image', '--path', 'nope/missing.png',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')]);
    assert.strictEqual(code, 2);
    assert.strictEqual(out.result, 'BLOCKED');
    assert.match(out.reason, /missing\.png/);
  });

  await test('image source: not an image -> BLOCKED, exit 2', async () => {
    const dir = proj({ 'fake.png': 'this is text pretending to be a png' });
    const { code, out } = await run(dir, ['--source', 'image', '--path', 'fake.png',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /not a (real )?PNG|not-an-image|not an image/i);
  });

  await test('image source: likely-blank large image -> BLOCKED', async () => {
    const dir = proj({ 'blank.png': makePng(2000, 2000, { noise: false }) });
    const { code, out } = await run(dir, ['--source', 'image', '--path', 'blank.png',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /blank/i);
  });

  await test('image source: needs no figma config at all', async () => {
    const dir = proj({ 'base.png': makePng(120, 120) }); // no config/project.json
    const { code, out } = await run(dir, ['--source', 'image', '--path', 'base.png',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')]);
    assert.strictEqual(code, 0, JSON.stringify(out));
  });

  // ── figma source: config gates ───────────────────────────────────────────────
  await test('figma: no figma block in config -> BLOCKED naming the block', async () => {
    const dir = proj({ 'config/project.json': { name: 'x' } });
    const { code, out } = await run(dir, ['--source', 'figma', '--id', '1:2',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /figma/i);
    assert.match(out.reason, /config\/project\.json/);
  });

  await test('figma: token env var unset -> BLOCKED naming FIGMA_TOKEN', async () => {
    const dir = proj({ 'config/project.json': FIGMA_CONFIG });
    const { code, out } = await run(dir, ['--source', 'figma', '--id', '1:2',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')]);
    assert.strictEqual(code, 2);
    assert.match(out.reason, /FIGMA_TOKEN/);
  });

  // ── figma source: happy path ─────────────────────────────────────────────────
  await test('figma: happy path — node metadata + rendered PNG downloaded', async () => {
    const { srv, port, calls } = await figmaServer({
      nodes: FRAME_NODE('1:2', 'Checkout / Desktop', 1440, 900),
      renderPng: makePng(1440, 900),
    });
    const dir = proj({ 'config/project.json': FIGMA_CONFIG, '.env': 'FIGMA_TOKEN=sekret-tok-1\n' });
    const outFile = path.join(dir, 'ev', 'baseline.png');
    const logFile = path.join(dir, 'ev', 'check.log');
    const { code, out, raw } = await run(dir, ['--source', 'figma', '--id', '1:2',
      '--out', outFile, '--log', logFile], { FIGMA_API_BASE: `http://127.0.0.1:${port}` });
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.result, 'OK');
    assert.strictEqual(out.node.id, '1:2');
    assert.strictEqual(out.node.name, 'Checkout / Desktop');
    assert.strictEqual(out.node.type, 'FRAME');
    assert.strictEqual(out.width, 1440);
    assert.strictEqual(out.height, 900);
    assert.deepStrictEqual(out.variants, []);
    assert.strictEqual(out.fileKeyMismatch, false);
    assert.ok(fs.existsSync(outFile), 'render downloaded to --out');
    // token sent as header to the API, never to the render host, never printed/logged
    const api = calls.filter(c => c.url.startsWith('/v1/'));
    assert.ok(api.length >= 2 && api.every(c => c.token === 'sekret-tok-1'), 'X-Figma-Token on API calls');
    const render = calls.filter(c => c.url.startsWith('/render/'));
    assert.ok(render.length === 1 && render[0].token === null, 'no token to the render URL host');
    assert.ok(!raw.includes('sekret-tok-1'), 'token never printed');
    assert.ok(!fs.readFileSync(logFile, 'utf8').includes('sekret-tok-1'), 'token never logged');
  });

  await test('figma: full frame URL accepted, node-id normalized 123-456 -> 123:456', async () => {
    const { srv, port, calls } = await figmaServer({
      nodes: FRAME_NODE('123:456', 'Home / Mobile', 390, 844),
      renderPng: makePng(390, 844),
    });
    const dir = proj({ 'config/project.json': FIGMA_CONFIG, '.env': 'FIGMA_TOKEN=t\n' });
    const url = 'https://www.figma.com/design/FILEKEY123/My-App?node-id=123-456&t=abc123';
    const { code, out } = await run(dir, ['--source', 'figma', '--id', url,
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')],
      { FIGMA_API_BASE: `http://127.0.0.1:${port}` });
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.node.id, '123:456');
    assert.strictEqual(out.fileKeyMismatch, false);
    assert.ok(calls.some(c => c.url.includes('ids=123%3A456') || c.url.includes('ids=123:456')), 'API id normalized');
  });

  await test('figma: URL with a DIFFERENT file key -> BLOCKED + fileKeyMismatch surfaced', async () => {
    const { srv, port, calls } = await figmaServer({});
    const dir = proj({ 'config/project.json': FIGMA_CONFIG, '.env': 'FIGMA_TOKEN=t\n' });
    const url = 'https://www.figma.com/design/OTHERKEY999/Other?node-id=1-2';
    const { code, out } = await run(dir, ['--source', 'figma', '--id', url,
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')],
      { FIGMA_API_BASE: `http://127.0.0.1:${port}` });
    srv.close();
    assert.strictEqual(code, 2);
    assert.strictEqual(out.fileKeyMismatch, true);
    assert.match(out.reason, /OTHERKEY999/);
    assert.match(out.reason, /FILEKEY123/);
    assert.strictEqual(calls.length, 0, 'mismatched URL never fetched');
  });

  await test('figma: unknown node -> BLOCKED naming the node id', async () => {
    const { srv, port } = await figmaServer({ nodes: {} }); // id absent from response
    const dir = proj({ 'config/project.json': FIGMA_CONFIG, '.env': 'FIGMA_TOKEN=t\n' });
    const { code, out } = await run(dir, ['--source', 'figma', '--id', '9:9',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')],
      { FIGMA_API_BASE: `http://127.0.0.1:${port}` });
    srv.close();
    assert.strictEqual(code, 2);
    assert.match(out.reason, /9:9/);
  });

  await test('figma: render failure (no image URL) -> BLOCKED', async () => {
    const { srv, port } = await figmaServer({
      nodes: FRAME_NODE('1:2', 'X', 100, 100), imagesErr: 'render failed',
    });
    const dir = proj({ 'config/project.json': FIGMA_CONFIG, '.env': 'FIGMA_TOKEN=t\n' });
    const { code, out } = await run(dir, ['--source', 'figma', '--id', '1:2',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')],
      { FIGMA_API_BASE: `http://127.0.0.1:${port}` });
    srv.close();
    assert.strictEqual(code, 2);
    assert.match(out.reason, /render/i);
  });

  await test('figma: component set -> variants enumerated with names + dims', async () => {
    const children = [
      { id: '1:10', name: 'Checkout / Desktop', type: 'COMPONENT', absoluteBoundingBox: { width: 1440, height: 900 } },
      { id: '1:11', name: 'Checkout / Mobile', type: 'COMPONENT', absoluteBoundingBox: { width: 390, height: 844 } },
    ];
    const { srv, port } = await figmaServer({
      nodes: FRAME_NODE('1:2', 'Checkout', 1830, 950, 'COMPONENT_SET', children),
      renderPng: makePng(1830, 950),
    });
    const dir = proj({ 'config/project.json': FIGMA_CONFIG, '.env': 'FIGMA_TOKEN=t\n' });
    const { code, out } = await run(dir, ['--source', 'figma', '--id', '1:2',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')],
      { FIGMA_API_BASE: `http://127.0.0.1:${port}` });
    srv.close();
    assert.strictEqual(code, 0, JSON.stringify(out));
    assert.strictEqual(out.variants.length, 2);
    assert.deepStrictEqual(out.variants[0], { id: '1:10', name: 'Checkout / Desktop', width: 1440, height: 900 });
    assert.deepStrictEqual(out.variants[1], { id: '1:11', name: 'Checkout / Mobile', width: 390, height: 844 });
  });

  await test('figma: --scale forwarded to the images API', async () => {
    const { srv, port, calls } = await figmaServer({
      nodes: FRAME_NODE('1:2', 'X', 200, 400), renderPng: makePng(400, 800),
    });
    const dir = proj({ 'config/project.json': FIGMA_CONFIG, '.env': 'FIGMA_TOKEN=t\n' });
    const { code } = await run(dir, ['--source', 'figma', '--id', '1:2', '--scale', '2',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')],
      { FIGMA_API_BASE: `http://127.0.0.1:${port}` });
    srv.close();
    assert.strictEqual(code, 0);
    assert.ok(calls.some(c => c.url.startsWith('/v1/images/') && c.url.includes('scale=2')), 'scale param sent');
  });

  await test('figma: invalid JSON in config/project.json -> BLOCKED naming the file, exit 2', async () => {
    const dir = proj({ 'config/project.json': '{ "name": "broken", ' }); // corrupt JSON
    const { code, out } = await run(dir, ['--source', 'figma', '--id', '1:2',
      '--out', path.join(dir, 'b.png'), '--log', path.join(dir, 'c.log')]);
    assert.strictEqual(code, 2, JSON.stringify(out));
    assert.strictEqual(out.result, 'BLOCKED');
    assert.match(out.reason, /invalid JSON/i);
    assert.match(out.reason, /project\.json/);
  });

  await test('usage: missing required args -> BLOCKED, exit 2', async () => {
    const dir = proj({});
    const { code, out } = await run(dir, ['--source', 'figma']);
    assert.strictEqual(code, 2);
    assert.strictEqual(out.result, 'BLOCKED');
  });

  console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed` : `\n${passed} passed`);
  process.exitCode = failures.length ? 1 : 0;
})();
