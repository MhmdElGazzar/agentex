#!/usr/bin/env node
// AgenTeX Setup Wizard — Local HTTP Server (Phase 1: Plugin delivery)
// Usage: node scripts/wizard/server.js [projectRoot] [--port=7373]
// Serves the wizard UI on http://127.0.0.1:<port>/setup
// Writes config/project.json + environments/<env>.json on save.
// Zero external dependencies — Node.js built-ins only.

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const { buildConfigs, validate } = require('./engine.js');

// ── CLI args ──────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const projectRoot = path.resolve(args.find(a => !a.startsWith('--')) || process.cwd());
const portArg     = args.find(a => a.startsWith('--port='));
const PORT        = portArg ? parseInt(portArg.split('=')[1]) : 7373;
const FORCE       = args.includes('--force');
const HOST        = '127.0.0.1';
const BASE_URL    = `http://${HOST}:${PORT}`;
const WIZARD_URL  = `${BASE_URL}/setup`;

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
    // Inject mode and API base into the page
    html = html.replace(
      "const MODE = window.WIZARD_MODE || 'local';",
      "const MODE = 'local';"
    ).replace(
      "const API  = window.WIZARD_API  || '';",
      `const API  = '${BASE_URL}';`
    );
    respond(res, 200, 'text/html; charset=utf-8', html);
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
    respondJSON(res, 200, { projectConfig: existingProj, envConfig: existingEnv, envName });
    return;
  }

  // ── POST /api/save  →  write config files + secrets → .env ─────────────
  if (method === 'POST' && url.pathname === '/api/save') {
    readBody(req, body => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { respondJSON(res, 400, { ok: false, error: 'Invalid JSON' }); return; }

      const { projectConfig, envConfig, envName, secrets } = payload;
      if (!projectConfig || !envConfig || !envName) {
        respondJSON(res, 400, { ok: false, error: 'Missing projectConfig, envConfig, or envName' });
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

  // ── POST /api/extract  →  receive AI-extracted data ─────────────────────
  // In Phase 1, Claude reads the file and POSTs the extracted JSON here.
  // The wizard shows it as a preview before the user confirms.
  if (method === 'POST' && url.pathname === '/api/extract') {
    // Handle multipart (file upload from browser) OR plain JSON (from Claude)
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      readBody(req, body => {
        try {
          const data = JSON.parse(body);
          respondJSON(res, 200, data);
        } catch { respondJSON(res, 400, { error: 'Invalid JSON' }); }
      });
    } else {
      // Multipart: just acknowledge — Claude handles the actual extraction
      // via init-test.md command flow
      readBody(req, () => {
        respondJSON(res, 200, { _status: 'file-received', _note: 'Claude will extract and POST back' });
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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function respondJSON(res, status, data) {
  respond(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => cb(body));
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
