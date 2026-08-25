#!/usr/bin/env node
// read-workitem.js — the bug-report-azure skill's READ-ONLY entry point:
// template-bug read, parent-story validation, ad-hoc work-item show, and
// exact-title search. Replaces the agent-run `az boards work-item show` /
// `az boards query` lookups: everything goes through the tracker layer's REST
// adapter (scripts/lib/tracker/) over Node's built-in fetch — no az CLI, no
// process spawning, zero npm dependencies.
//
// READ ONLY BY CONSTRUCTION: there is no --execute flag and no write method is
// ever called; the sibling test asserts both. Reads run freely (invariant 4).
//
// Usage:
//   node read-workitem.js show --id <id> [--expand all]
//   node read-workitem.js find --type <workItemType> --title "<exact title>"
//
// Output: ONE JSON line; exit 0 = ok, 1 = tracker/read failure, 2 = bad
// usage/config (repo convention D2 / invariant 9). Config comes from the
// consumer's config/project.json azure block (legacy AZURE_* fallback); the PAT
// is read from .env by the adapter and sent only in the Authorization header.
'use strict';

const path = require('node:path');
const { resolveTracker, TrackerError } = require(
  path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'tracker', 'index.js'));

// ---- CLI arg parser: --key value / --key=value / --flag ----------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
        else { out[a.slice(2)] = next; i++; }
      }
    } else out._.push(a);
  }
  return out;
}

const USAGE = 'usage: read-workitem.js show --id <id> [--expand all] | find --type <type> --title <title>';

function trackerErrorOut(e) {
  return {
    ok: false,
    error: {
      message: e.message,
      op: e.op, status: e.status, url: e.url,
      serverMessage: e.serverMessage,
      ...(e.credentialHint ? { credentialHint: e.credentialHint } : {}),
    },
  };
}

// The whole script as a callable: returns { code, out } and prints nothing —
// the CLI tail below owns the one JSON line. opts.fetch is the offline-test seam.
async function run(argv, { cwd = process.cwd(), fetch } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  try {
    if (cmd === 'show') {
      if (!args.id) return { code: 2, out: { ok: false, error: { message: `--id is required. ${USAGE}` } } };
      const adapter = resolveTracker(cwd, { fetch });
      const wi = await adapter.getWorkItem(args.id, args.expand ? { expand: args.expand } : {});
      const f = (wi && wi.fields) || {};
      return {
        code: 0,
        out: {
          ok: true,
          workItem: {
            id: wi.id,
            type: f['System.WorkItemType'] || null,
            title: f['System.Title'] || null,
            state: f['System.State'] || null,
            url: `${adapter.config.base}/${encodeURIComponent(adapter.config.project)}/_workitems/edit/${wi.id}`,
            fields: f,
            ...(wi.relations ? { relations: wi.relations } : {}),
          },
        },
      };
    }
    if (cmd === 'find') {
      if (!args.type || !args.title) {
        return { code: 2, out: { ok: false, error: { message: `--type and --title are required. ${USAGE}` } } };
      }
      const adapter = resolveTracker(cwd, { fetch });
      const ids = await adapter.findByTitle(args.type, args.title);
      return { code: 0, out: { ok: true, type: args.type, title: args.title, ids } };
    }
    return { code: 2, out: { ok: false, error: { message: USAGE } } };
  } catch (e) {
    if (e instanceof TrackerError) return { code: 1, out: trackerErrorOut(e) };
    return { code: e.exitCode === 2 ? 2 : 1, out: { ok: false, error: { message: e.message } } };
  }
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    process.exit(code);
  });
}
