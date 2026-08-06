#!/usr/bin/env node
// AgenTeX Setup Wizard — Local HTTP Server (Phase 1: Plugin delivery)
// Usage: node scripts/wizard/server.js [projectRoot] [--port=7373]
// Serves the wizard UI on http://127.0.0.1:<port>/setup
// Writes config/project.json + environments/<env>.json on save.
// Zero external dependencies — Node.js built-ins only.

'use strict';

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const { buildConfigs, validate, validateConfigs, extractFromText } = require('./engine.js');

// ── CLI args ──────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const projectRoot = path.resolve(args.find(a => !a.startsWith('--')) || process.cwd());
const portArg     = args.find(a => a.startsWith('--port='));
const PORT        = portArg ? parseInt(portArg.split('=')[1]) : 7373;
const FORCE       = args.includes('--force');
const HOST        = '127.0.0.1';
const BASE_URL    = `http://${HOST}:${PORT}`;
const WIZARD_URL  = `${BASE_URL}/setup`;

// Per-run secret the served page carries; API calls must echo it back.
const TOKEN       = crypto.randomBytes(24).toString('hex');

const pluginRoot  = path.resolve(__dirname, '..', '..');
const schemaPath  = path.join(__dirname, 'schema.json');
const uiPath      = path.join(__dirname, 'ui.html');

// Reject running inside the plugin itself
if (!FORCE && projectRoot === pluginRoot) {
  console.error('[setup-wizard] error: cannot run from the plugin root — run from your project');
  process.exit(1);
}

// ── Schema ────────────────────────────────────────────────────────────────
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

// ── Server ────────────────────────────────────────────────────────────────
let server;

server = http.createServer((req, res) => {
  const url    = new URL(req.url, BASE_URL);
  const method = req.method.toUpperCase();

  // ── GET /setup  →  serve wizard HTML ───────────────────────────────────
  if (method === 'GET' && url.pathname === '/setup') {
    let html = fs.readFileSync(uiPath, 'utf8');
    // Inject mode, API base, and this run's token into the page.
    html = html.replace(
      "const MODE = window.WIZARD_MODE || 'local';",
      "const MODE = 'local';"
    ).replace(
      "const API  = window.WIZARD_API  || '';",
      `const API  = '${BASE_URL}';`
    ).replace(
      "const TOKEN = window.WIZARD_TOKEN || '';",
      `const TOKEN = '${TOKEN}';`
    );
    respond(res, 200, 'text/html; charset=utf-8', html);
    return;
  }

  // Everything else under /api/ is for this wizard's own page only. Without
  // this, any site open in the user's browser could read the project config
  // and write its files (a simple POST needs no CORS preflight).
  if (url.pathname.startsWith('/api/') && req.headers['x-wizard-token'] !== TOKEN) {
    respondJSON(res, 403, { error: 'forbidden — this API only serves the wizard page' });
    return;
  }

  // ── GET /favicon.ico  →  204 (keeps the browser console free of 404s) ──
  if (method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET /api/schema  →  return wizard schema ────────────────────────────
  if (method === 'GET' && url.pathname === '/api/schema') {
    respondJSON(res, 200, schema);
    return;
  }

  // ── GET /api/config  →  read current project config files ──────────────
  if (method === 'GET' && url.pathname === '/api/config') {
    const projCfgPath = path.join(projectRoot, 'config', 'project.json');
    const existingProj = safeReadJSON(projCfgPath);
    const envName = existingProj?.defaultEnvironment || 'qa';
    const envCfgPath = path.join(projectRoot, 'environments', `${envName}.json`);
    const existingEnv = safeReadJSON(envCfgPath);
    // A file that exists but won't parse is NOT the same as no file: saying
    // nothing would let the wizard quietly overwrite whatever it couldn't read.
    const unreadable = [
      [projCfgPath, existingProj, 'config/project.json'],
      [envCfgPath, existingEnv, `environments/${envName}.json`],
    ].filter(([p, parsed]) => parsed === null && fs.existsSync(p)).map(([, , label]) => label);
    respondJSON(res, 200, { projectConfig: existingProj, envConfig: existingEnv, envName, unreadable });
    return;
  }

  // ── POST /api/save  →  write config files + secrets → .env ─────────────
  if (method === 'POST' && url.pathname === '/api/save') {
    readBody(req, buf => {
      let payload;
      try { payload = JSON.parse(buf.toString('utf8')); }
      catch { respondJSON(res, 400, { ok: false, error: 'Invalid JSON' }); return; }

      const { projectConfig, envConfig, envName, secrets } = payload;
      if (!projectConfig || !envConfig || !envName) {
        respondJSON(res, 400, { ok: false, error: 'Missing projectConfig, envConfig, or envName' });
        return;
      }

      // Never trust the browser: re-validate, and reject an envName that could
      // escape environments/ (it becomes a file name below).
      const errors = validateConfigs(projectConfig, envConfig, envName);
      if (errors.length) {
        respondJSON(res, 400, { ok: false, error: errors.join('; ') });
        return;
      }

      try {
        // Write config/project.json
        const projDir = path.join(projectRoot, 'config');
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(
          path.join(projDir, 'project.json'),
          JSON.stringify(projectConfig, null, 2) + '\n',
          'utf8'
        );

        // Write environments/<env>.json
        const envDir = path.join(projectRoot, 'environments');
        fs.mkdirSync(envDir, { recursive: true });
        fs.writeFileSync(
          path.join(envDir, `${envName}.json`),
          JSON.stringify(envConfig, null, 2) + '\n',
          'utf8'
        );

        // Write secrets → .env silently (no UI mention)
        if (secrets && Object.keys(secrets).length > 0) {
          writeSecrets(path.join(projectRoot, '.env'), secrets);
          console.log(`[setup-wizard] 🔐 Secrets written to .env`);
        }

        console.log(`[setup-wizard] ✅ Saved:`);
        console.log(`  config/project.json`);
        console.log(`  environments/${envName}.json`);
        respondJSON(res, 200, { ok: true });
      } catch(e) {
        respondJSON(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ── POST /api/extract  →  turn pasted text / an uploaded file into answers ──
  // { text } or a text-ish upload is parsed here and returned as schema-shaped
  // answers for the wizard's preview. Structured JSON (posted by Claude after
  // reading a PDF/Word file) is passed straight through.
  if (method === 'POST' && url.pathname === '/api/extract') {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      readBody(req, buf => {
        let data;
        try { data = JSON.parse(buf.toString('utf8')); }
        catch { respondJSON(res, 400, { error: 'Invalid JSON' }); return; }
        if (data && typeof data.text === 'string') {
          const extracted = extractFromText(data.text);
          console.log(`[setup-wizard] 🔍 extracted ${Object.keys(extracted).length} field(s) from pasted text`);
          respondJSON(res, 200, extracted);
        } else {
          respondJSON(res, 200, data);   // already-structured answers
        }
      });
    } else {
      // Browser file upload (multipart). Text-ish files are parsed here; binary
      // ones (PDF/Word) are saved and announced on stdout so Claude can read them
      // and POST the structured answers back (see commands/init-test.md).
      readBody(req, buf => {
        // Byte-preserving view for splitting the multipart envelope; the file's
        // own bytes are re-decoded as UTF-8 only once we know it is text.
        const { filename, content } = parseSingleFileUpload(buf.toString('binary'));
        if (isProbablyText(content)) {
          const text = Buffer.from(content, 'binary').toString('utf8');
          const extracted = extractFromText(text);
          console.log(`[setup-wizard] 🔍 extracted ${Object.keys(extracted).length} field(s) from ${filename || 'upload'}`);
          respondJSON(res, 200, extracted);
          return;
        }
        try {
          const tmp = path.join(projectRoot, `.agentex-upload-${Date.now()}-${(filename || 'file').replace(/[^\w.\-]/g, '_')}`);
          fs.writeFileSync(tmp, Buffer.from(content, 'binary'));
          console.log(`[setup-wizard] 📄 extract-request: ${tmp}`);
          respondJSON(res, 200, { _status: 'file-received', _path: tmp, _note: 'Claude will extract and POST the answers back' });
        } catch (e) {
          respondJSON(res, 500, { error: e.message });
        }
      });
    }
    return;
  }

  // ── GET /api/done  →  shut down server ─────────────────────────────────
  if (method === 'GET' && url.pathname === '/api/done') {
    respondJSON(res, 200, { ok: true, message: 'Wizard complete — server shutting down' });
    console.log('\n[setup-wizard] ✅ Done. Closing server.');
    setTimeout(() => server.close(() => process.exit(0)), 500);
    return;
  }

  // 404 fallback
  respond(res, 404, 'text/plain', 'Not found');
});

// ── Start ─────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`\n[setup-wizard] 🚀 Wizard running at: ${WIZARD_URL}\n`);
  openBrowser(WIZARD_URL);
  console.log('[setup-wizard] Waiting for user to complete setup...');
  console.log('[setup-wizard] Press Ctrl+C to cancel.\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[setup-wizard] Port ${PORT} is in use. Try --port=7374`);
  } else {
    console.error('[setup-wizard] Server error:', err.message);
  }
  process.exit(1);
});

// ── Helpers ───────────────────────────────────────────────────────────────
/**
 * Write secrets into .env — creates the file if absent, updates existing keys,
 * appends new ones. Never exposes this flow to the UI.
 */
function writeSecrets(envPath, secrets) {
  let lines = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  }

  for (const [key, value] of Object.entries(secrets)) {
    if (!value) continue; // skip empty secrets
    const idx = lines.findIndex(l => l.match(new RegExp(`^${key}\\s*=`)));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }

  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
}

function respond(res, status, ct, body) {
  res.writeHead(status, {
    'Content-Type': ct,
    // No CORS: the UI is same-origin. A wildcard here let any page open in the
    // user's browser read this project's config and write its files.
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function respondJSON(res, status, data) {
  respond(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

/**
 * Hand the caller the raw body Buffer — the encoding is theirs to choose.
 * JSON must decode as UTF-8 (latin1 would mangle Arabic); a binary upload must
 * stay byte-for-byte, so multipart uses 'binary'.
 */
function readBody(req, cb) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => cb(Buffer.concat(chunks)));
}

/**
 * Pull the first file part out of a multipart/form-data body.
 * Minimal by design — the wizard uploads exactly one file.
 */
function parseSingleFileUpload(raw) {
  const head = raw.indexOf('\r\n\r\n');
  if (head === -1) return { filename: '', content: raw };
  const headers = raw.slice(0, head);
  const nameMatch = headers.match(/filename="([^"]*)"/i);
  const boundaryEnd = raw.indexOf('\r\n--', head);
  const content = raw.slice(head + 4, boundaryEnd === -1 ? undefined : boundaryEnd);
  return { filename: nameMatch ? nameMatch[1] : '', content };
}

/** Treat as text when it decodes as UTF-8 without NUL bytes / heavy control noise. */
function isProbablyText(s) {
  if (!s) return false;
  const sample = s.slice(0, 4000);
  if (sample.indexOf('\u0000') !== -1) return false;
  const controls = (sample.match(/[\x01-\x08\x0E-\x1F]/g) || []).length;
  return controls / sample.length < 0.05;
}

function safeReadJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function openBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === 'win32')  execSync(`start "" "${url}"`, { stdio: 'ignore' });
    else if (platform === 'darwin') execSync(`open "${url}"`, { stdio: 'ignore' });
    else execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
  } catch {
    console.log(`[setup-wizard] Could not open browser automatically.`);
    console.log(`[setup-wizard] Please open manually: ${url}`);
  }
}
