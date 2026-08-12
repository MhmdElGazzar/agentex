'use strict';
// Self-contained tests for _lib.js (bug-report-azure shared az runner).
//
// SAFETY RULES UNDER TEST (see _lib.js):
//   - fileArg(): untrusted text (titles, area paths, WIQL) is written to a temp
//     file and only an inert `@<path>` reaches the shell-parsed command line —
//     quote-heavy, metacharacter-laden and Arabic text must never appear raw.
//   - temp @files are cleaned up after every run (dry-run, success AND failure).
//   - writes only run behind execute:true and are printed before they run;
//     reads always run; a dry-run write is printed but NEVER executed.
//   - the PAT travels via AZURE_DEVOPS_EXT_PAT in the environment only — never
//     on the command line, never in stdout.
//   - az failures surface the exact stderr (BLOCKED-style, nothing swallowed).
//   - findByTitle() escapes single quotes in WIQL and @file-routes the query.
//   - loadConfig(): config/project.json azure block wins over .env AZURE_*;
//     missing values stay null (asked, never guessed).
//
// No real `az` is ever called: a fake shim (az.cmd + az) is created in a temp
// dir placed first on PATH; the whole temp dir is removed at the end.
// Run: node skills/bug-report-azure/scripts/_lib.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('./_lib.js');
const IS_WIN = process.platform === 'win32';
const AT_RE = IS_WIN ? /"@([^"]+)"/ : /'@([^']+)'/;
let passed = 0;

// ---- fake az shim ------------------------------------------------------------
// Records every invocation (args, content of any @file / --in-file argument, and
// the PAT seen in its environment) to calls.jsonl, then answers from a routing
// table (responses.json): first entry whose `match` strings are ALL present as
// exact arguments wins.
const SHIM_JS = [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  "const args = process.argv.slice(2);",
  "const atFiles = {};",
  "for (const a of args) {",
  "  if (a.charAt(0) === '@') {",
  "    const p = a.slice(1);",
  "    const exists = fs.existsSync(p);",
  "    atFiles[a] = { exists: exists, content: exists ? fs.readFileSync(p, 'utf8') : null };",
  "  }",
  "}",
  "let inFile = null;",
  "const ix = args.indexOf('--in-file');",
  "if (ix !== -1 && args[ix + 1] && fs.existsSync(args[ix + 1])) {",
  "  try { inFile = fs.readFileSync(args[ix + 1], 'utf8').slice(0, 65536); } catch (e) {}",
  "}",
  "const rec = { args: args, atFiles: atFiles, inFile: inFile, pat: process.env.AZURE_DEVOPS_EXT_PAT || null };",
  "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(rec) + '\\n');",
  "let out = '{}', code = 0, err = '';",
  "try {",
  "  const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'responses.json'), 'utf8'));",
  "  for (const r of routes) {",
  "    if (r.match.every(function (m) { return args.indexOf(m) !== -1; })) {",
  "      out = r.stdout !== undefined ? r.stdout : '{}';",
  "      code = r.exit || 0;",
  "      err = r.stderr || '';",
  "      break;",
  "    }",
  "  }",
  "} catch (e) {}",
  "if (err) process.stderr.write(err);",
  "process.stdout.write(out);",
  "process.exit(code);",
].join('\n');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-libtest-'));
const SHIM = path.join(TMP, 'shim');

function makeShim(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const shimJs = path.join(dir, 'azshim.js');
  fs.writeFileSync(shimJs, SHIM_JS);
  // Absolute shim path embedded: %~dp0 is unreliable when the batch is resolved
  // through PATH inside the nested `cmd /d /s /c "..."` _lib.js uses.
  fs.writeFileSync(path.join(dir, 'az.cmd'), `@echo off\r\nnode "${shimJs}" %*\r\nexit /b %errorlevel%\r\n`);
  fs.writeFileSync(path.join(dir, 'az'), `#!/bin/sh\nexec node "${shimJs.replace(/\\/g, '\\\\')}" "$@"\n`);
  try { fs.chmodSync(path.join(dir, 'az'), 0o755); } catch (e) { /* windows */ }
}

function setRoutes(routes) {
  fs.writeFileSync(path.join(SHIM, 'responses.json'), JSON.stringify(routes));
  fs.rmSync(path.join(SHIM, 'calls.jsonl'), { force: true });
}

function readCalls() {
  const f = path.join(SHIM, 'calls.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Capture console.log lines emitted by _lib (the [run]/[would run] transparency lines).
function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { r: fn(), lines }; } finally { console.log = orig; }
}

async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ok -', name);
}

// ---- setup: shim first on PATH, AZURE_* env stripped for determinism ---------
makeShim(SHIM);
const ORIG_PATH = process.env.PATH;
const ORIG_CWD = process.cwd();
process.env.PATH = SHIM + path.delimiter + ORIG_PATH;
const savedAzureEnv = {};
for (const k of Object.keys(process.env)) {
  if (k.toUpperCase().startsWith('AZURE_')) { savedAzureEnv[k] = process.env[k]; delete process.env[k]; }
}

(async () => {
  try {
    // 1. shQuote: one argument survives the platform shell intact
    await test('shQuote quotes one argument for the platform shell', async () => {
      if (IS_WIN) {
        assert.strictEqual(lib.shQuote('He said "hi" & left'), '"He said ""hi"" & left"');
        assert.strictEqual(lib.shQuote('plain'), '"plain"');
      } else {
        assert.strictEqual(lib.shQuote("it's"), "'it'\\''s'");
        assert.strictEqual(lib.shQuote('plain'), "'plain'");
      }
    });

    // 2. buildCmd: the printed command is the composed az invocation, fully quoted
    await test('buildCmd composes the quoted az command string', async () => {
      const cmd = lib.buildCmd(['boards', 'query']);
      if (IS_WIN) assert.strictEqual(cmd, '"az.cmd" "boards" "query"');
      else assert.strictEqual(cmd, "'az' 'boards' 'query'");
    });

    // 3. parseArgs: --key value / --key=value / --flag / positionals
    await test('parseArgs handles --key value, --key=value, --flag and positionals', async () => {
      const a = lib.parseArgs(['--spec', 'bug.json', '--execute', '--k=v', 'pos1', '--flag']);
      assert.deepStrictEqual(a, { _: ['pos1'], spec: 'bug.json', execute: true, k: 'v', flag: true });
    });

    // 4. recommendation table agrees with the validation whitelists
    await test('IMPACT_RECOMMENDATION values are all valid severities/priorities', async () => {
      for (const k of Object.keys(lib.IMPACT_RECOMMENDATION)) {
        const r = lib.IMPACT_RECOMMENDATION[k];
        assert.ok(lib.VALID_SEVERITY.includes(r.severity), `${k}: severity "${r.severity}" not in VALID_SEVERITY`);
        assert.ok(lib.VALID_PRIORITY.includes(r.priority), `${k}: priority ${r.priority} not in VALID_PRIORITY`);
      }
    });

    // 5. SAFETY: dry-run write — @file on the command line, raw text absent,
    //    command printed but NOT executed, temp file cleaned up
    await test('dry-run write: @file replaces untrusted text, printed, never executed, temp cleaned', async () => {
      setRoutes([]);
      const EVIL = 'Login "fails" & del *.* | %USERNAME% <script> — تسجيل الدخول';
      const { r, lines } = captureLog(() =>
        lib.az(['boards', 'work-item', 'create', '--title', lib.fileArg(EVIL)], { write: true, execute: false }));
      assert.strictEqual(r.ran, false, 'dry-run write must not run');
      assert.strictEqual(r.ok, true);
      assert.ok(lines.includes('  [would run] ' + r.cmd), 'the exact command must be printed');
      assert.ok(r.cmd.includes('agentex-arg-'), 'command line must reference the temp @file');
      const m = r.cmd.match(AT_RE);
      assert.ok(m, 'command must contain a quoted @<path> argument');
      for (const frag of ['Login', 'fails', '%USERNAME%', '<script>', 'تسجيل']) {
        assert.ok(!r.cmd.includes(frag), `raw untrusted fragment on the command line: ${frag}`);
      }
      assert.strictEqual(fs.existsSync(m[1]), false, 'temp @file must be deleted after a dry-run');
      assert.strictEqual(readCalls().length, 0, 'a dry-run write must never invoke az');
    });

    // 6. reads always run (no execute flag needed) and print nothing
    await test('reads run without execute and are not announced', async () => {
      setRoutes([{ match: ['show'], stdout: '{"id":7,"fields":{"System.Title":"T"}}' }]);
      const { r, lines } = captureLog(() =>
        lib.az(['boards', 'work-item', 'show', '--id', '7', '-o', 'json']));
      assert.strictEqual(r.ran, true);
      assert.strictEqual(r.json.id, 7);
      assert.strictEqual(lines.length, 0, 'reads must not print [run] lines');
      assert.strictEqual(readCalls().length, 1);
    });

    // 7. SAFETY: executed write — az receives the @file, its content round-trips
    //    byte-exact (quotes, metachars, %VAR%, newline, Arabic), the raw text is
    //    never an argument, and the temp files are cleaned afterwards
    await test('executed write: @file content round-trips exactly, raw text never an argument, temp cleaned', async () => {
      setRoutes([{ match: ['create'], stdout: '{"id":314}' }]);
      const NASTY = 'Bug "quoted" & <html> | 100% of %USERNAME% \'single\' — النص العربي\nsecond line';
      const AREA = 'DemoProject\\منطقة الاختبار';
      const { r, lines } = captureLog(() =>
        lib.az(['boards', 'work-item', 'create', '--type', 'Bug',
          '--title', lib.fileArg(NASTY), '--fields', lib.fileArg('System.AreaPath=' + AREA), '-o', 'json'],
        { write: true, execute: true }));
      assert.strictEqual(r.ran, true);
      assert.strictEqual(r.json.id, 314);
      assert.ok(lines.includes('  [run] ' + r.cmd), 'executed write must print the exact command first');
      const call = readCalls()[0];
      const titleArg = call.args[call.args.indexOf('--title') + 1];
      assert.strictEqual(titleArg.charAt(0), '@', 'title must arrive as @<path>');
      assert.strictEqual(call.atFiles[titleArg].exists, true, '@file must exist while az runs');
      assert.strictEqual(call.atFiles[titleArg].content, NASTY, 'title must round-trip byte-exact');
      const fieldsArg = call.args[call.args.indexOf('--fields') + 1];
      assert.strictEqual(call.atFiles[fieldsArg].content, 'System.AreaPath=' + AREA, 'area path must round-trip');
      const joined = call.args.join(' ');
      for (const frag of ['quoted', '%USERNAME%', 'النص', 'منطقة']) {
        assert.ok(!joined.includes(frag), `raw untrusted fragment reached az argv: ${frag}`);
      }
      for (const a of call.args) {
        if (a.charAt(0) === '@') assert.strictEqual(fs.existsSync(a.slice(1)), false, 'temp @file must be deleted after the run');
      }
    });

    // 8. SECRET: PAT flows via env only — az sees it, nothing printed/argv carries it
    await test('PAT: az receives AZURE_DEVOPS_EXT_PAT via env; never on command line or output', async () => {
      setRoutes([{ match: ['create'], stdout: '{"id":1}' }]);
      process.env.AZURE_DEVOPS_EXT_PAT = 'fake-pat-abc-123';
      try {
        const { r, lines } = captureLog(() =>
          lib.az(['boards', 'work-item', 'create', '--title', lib.fileArg('generic title')],
            { write: true, execute: true }));
        const call = readCalls()[0];
        assert.strictEqual(call.pat, 'fake-pat-abc-123', 'az must receive the PAT via its environment');
        assert.ok(!r.cmd.includes('fake-pat'), 'PAT must not be on the command line');
        assert.ok(lines.every((l) => !l.includes('fake-pat')), 'PAT must not be printed');
        assert.ok(call.args.every((a) => !a.includes('fake-pat')), 'PAT must not be an az argument');
        assert.ok(!r.stdout.includes('fake-pat'));
      } finally {
        delete process.env.AZURE_DEVOPS_EXT_PAT;
      }
    });

    // 9. BLOCKED-style failure: nonzero az exit throws with the exact stderr and
    //    command; temp @files are still cleaned up (finally)
    await test('az failure: throws with exact stderr + cmd, temp @file cleaned even on failure', async () => {
      setRoutes([{ match: ['boards'], exit: 1, stderr: 'TF401232: fake write failure' }]);
      let threw = null;
      const { lines } = captureLog(() => {
        try {
          lib.az(['boards', 'work-item', 'create', '--title', lib.fileArg('any title')],
            { write: true, execute: true });
        } catch (e) { threw = e; }
      });
      assert.ok(threw, 'nonzero az exit must throw');
      assert.ok(threw.message.includes('az exited 1'), 'exit status must be surfaced');
      assert.ok(threw.message.includes('TF401232: fake write failure'), 'exact stderr must be surfaced');
      assert.ok(threw.message.includes(IS_WIN ? '"az.cmd"' : "'az'"), 'failing command must be surfaced');
      assert.ok(lines.some((l) => l.startsWith('  [run] ')), 'write must be printed before it runs');
      const call = readCalls()[0];
      const atArg = call.args.find((a) => a.charAt(0) === '@');
      assert.ok(atArg, 'az did receive the @file');
      assert.strictEqual(fs.existsSync(atArg.slice(1)), false, 'temp @file must be deleted after a failed run');
    });

    // 10. findByTitle: WIQL is @file-routed with single quotes doubled (title AND project)
    await test('findByTitle escapes quotes in WIQL and passes it as @file', async () => {
      setRoutes([{ match: ['query'], stdout: '[{"id":88}]' }]);
      const cfg = { org: 'https://dev.azure.com/demo-org', project: "O'Brien Project" };
      const TITLE = 'It\'s "broken" — عنوان الخطأ';
      const { r: ids } = captureLog(() => lib.findByTitle(cfg, 'Bug', TITLE));
      assert.deepStrictEqual(ids, [88]);
      const call = readCalls()[0];
      const wiqlArg = call.args[call.args.indexOf('--wiql') + 1];
      assert.strictEqual(wiqlArg.charAt(0), '@', 'WIQL must be passed as @file');
      const wiql = call.atFiles[wiqlArg].content;
      assert.ok(wiql.includes("[System.Title]='It''s \"broken\" — عنوان الخطأ'"), 'title single quotes must be doubled in WIQL');
      assert.ok(wiql.includes("[System.TeamProject]='O''Brien Project'"), 'project single quotes must be doubled in WIQL');
      assert.ok(call.args.every((a) => a.charAt(0) === '@' || !a.includes("It's")),
        'raw title must not appear as a command argument');
    });

    // 11. showWorkItem: read passes id/org/project through and returns az JSON
    await test('showWorkItem returns az JSON and targets the right work item', async () => {
      setRoutes([{ match: ['show'], stdout: '{"id":4321,"fields":{"System.WorkItemType":"User Story"}}' }]);
      const cfg = { org: 'https://dev.azure.com/demo-org', project: 'DemoProject' };
      const wi = lib.showWorkItem(cfg, 4321);
      assert.strictEqual(wi.id, 4321);
      assert.strictEqual(wi.fields['System.WorkItemType'], 'User Story');
      const call = readCalls()[0];
      assert.ok(call.args.includes('--id') && call.args.includes('4321'));
      assert.ok(call.args.includes('--org') && call.args.includes('https://dev.azure.com/demo-org'));
      assert.ok(call.args.includes('--project') && call.args.includes('DemoProject'));
    });

    // 12. loadConfig: config/project.json azure block wins over .env; .env fills gaps;
    //     trailing slash stripped; assignees split; defaults applied
    await test('loadConfig: project.json wins, .env fills gaps, defaults applied', async () => {
      const dir = path.join(TMP, 'cfg1');
      fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'config', 'project.json'), JSON.stringify({
        azure: {
          org: 'https://dev.azure.com/acme-demo/',
          project: 'ProjA',
          assignee: 'a@example.com, b@example.com',
          bugTemplateId: 777,
        },
      }));
      fs.writeFileSync(path.join(dir, '.env'),
        'AZURE_URL=https://dev.azure.com/should-not-win\nAZURE_TEAM=LegacyTeam\n');
      process.chdir(dir);
      try {
        const cfg = lib.loadConfig();
        assert.strictEqual(cfg.org, 'https://dev.azure.com/acme-demo', 'JSON org wins and trailing slash is stripped');
        assert.strictEqual(cfg.project, 'ProjA');
        assert.strictEqual(cfg.team, 'LegacyTeam', '.env fills keys the JSON block lacks');
        assert.strictEqual(cfg.templateBugId, '777', 'JSON numbers are stringified');
        assert.deepStrictEqual(cfg.assignees, ['a@example.com', 'b@example.com']);
        assert.strictEqual(cfg.valueArea, 'Business');
        assert.strictEqual(cfg.apiVersion, '7.1');
      } finally {
        process.chdir(ORIG_CWD);
      }
    });

    // 13. loadConfig: nothing configured -> nulls (asked at runtime, never guessed)
    await test('loadConfig: unset values stay null, never guessed', async () => {
      const dir = path.join(TMP, 'cfg-empty');
      fs.mkdirSync(dir, { recursive: true });
      process.chdir(dir);
      try {
        const cfg = lib.loadConfig();
        assert.strictEqual(cfg.org, null);
        assert.strictEqual(cfg.project, null);
        assert.strictEqual(cfg.team, null);
        assert.strictEqual(cfg.areaPath, null);
        assert.strictEqual(cfg.environment, null);
        assert.deepStrictEqual(cfg.assignees, []);
        assert.strictEqual(cfg.valueArea, 'Business');
        assert.strictEqual(cfg.apiVersion, '7.1');
      } finally {
        process.chdir(ORIG_CWD);
      }
    });

    console.log(`\n${passed} passed`);
  } finally {
    process.chdir(ORIG_CWD);
    process.env.PATH = ORIG_PATH;
    for (const k of Object.keys(savedAzureEnv)) process.env[k] = savedAzureEnv[k];
    fs.rmSync(TMP, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
