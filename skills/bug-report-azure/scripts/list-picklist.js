#!/usr/bin/env node
// list-picklist.js — show what a work item type's fields will actually accept: the allowed
// values of its picklists and which fields the process makes mandatory. READ ONLY; it can
// never write anything, so it is safe to run at any point.
//
// You normally do not need to run this by hand. `create-bug.js` validates every payload
// against Azure before writing (validateOnly) and, on a rejection, prints the offending
// field's allowed values itself. This script is for the times you want to look first —
// setting up a new project's config, or answering "what can Environment even be?".
//
// TOOLING: one `az devops invoke` call (see _lib.js `workItemTypeFields` for why this route
// rather than the process-lists API). No direct HTTPS, no writes, no secrets read.
//
// Usage:
//   node list-picklist.js                              # every picklist + required field on Bug
//   node list-picklist.js --field Custom.Environment    # one field (reference OR display name)
//   node list-picklist.js --type "Test Case"            # a different work item type
//   node list-picklist.js --required                    # only the mandatory fields
//   node list-picklist.js --json                        # machine-readable
//
// Config resolution is shared with the rest of the skill (config/project.json's azure block,
// then the AZURE_* env aliases) — see _lib.js loadConfig.

'use strict';

const { loadConfig, parseArgs, workItemTypeFields } = require('./_lib.js');

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig();
const type = args.type || 'Bug';

let fields;
try {
  fields = workItemTypeFields(cfg, type);
} catch (e) {
  console.error(`ERROR: could not read the field list for "${type}".\n${e.message}`);
  process.exit(1);
}

// --field accepts either spelling, because Azure's own error messages use the display name
// ("Environment") while the spec and the API use the reference name ("Custom.Environment").
if (args.field && args.field !== true) {
  const want = String(args.field).toLowerCase();
  const hit = [...fields.values()].find(
    (f) => f.referenceName.toLowerCase() === want || f.name.toLowerCase() === want,
  );
  if (!hit) {
    console.error(`ERROR: "${args.field}" is not a field on ${type} in this project.`);
    console.error('Run without --field to list the fields that have allowed values.');
    process.exit(1);
  }
  if (args.json) { console.log(JSON.stringify(hit, null, 2)); process.exit(0); }
  console.log(`${hit.name}  (${hit.referenceName})`);
  console.log(`  required : ${hit.alwaysRequired ? 'YES' : 'no'}`);
  if (hit.allowedValues.length) {
    console.log('  allowed values:');
    hit.allowedValues.forEach((v) => console.log(`    - ${v}`));
  } else {
    console.log('  allowed values: (free text — no fixed list)');
  }
  process.exit(0);
}

const all = [...fields.values()];
const interesting = args.required
  ? all.filter((f) => f.alwaysRequired)
  : all.filter((f) => f.alwaysRequired || f.allowedValues.length > 0);

if (args.json) { console.log(JSON.stringify(interesting, null, 2)); process.exit(0); }

console.log(`${type} — ${interesting.length} of ${all.length} fields are required and/or have a fixed value list`);
console.log(`(project: ${cfg.project || '(az default)'})\n`);
for (const f of interesting) {
  const req = f.alwaysRequired ? ' [REQUIRED]' : '';
  console.log(`${f.name}  (${f.referenceName})${req}`);
  if (f.allowedValues.length) {
    f.allowedValues.forEach((v) => console.log(`    - ${v}`));
  } else {
    console.log('    (free text)');
  }
  console.log('');
}
