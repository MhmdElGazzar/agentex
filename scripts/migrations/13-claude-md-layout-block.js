'use strict';
// m13 claude-md-layout-block — the AgenTeX layout block in the consumer's CLAUDE.md
// (project-layout-contract): the routing table, the read-knowledge/INDEX.md-first rule
// and the knowledge/watchlist lifecycle, between hash-stamped markers. Through the same
// scaffold action /init-test runs right after the executions/ bullet, so a migrated
// project and a fresh one end byte-equal.
//
//   - absent (or no CLAUDE.md) → appended at the end (the file is created if missing);
//   - stale (pristine, from an older release's table) → refreshed in place;
//   - edited by the user, or broken markers → a [flag] with the fix, zero writes, never a
//     [manual] item, so the stamp is never withheld;
//   - every byte outside the markers stays identical. The block renders no configured
//     value (it defers to config/project.json → qaRecords), so nothing is carried; no
//     other file is opened.
const fs = require('fs');
const path = require('path');
const { parseBlock } = require('../lib/layout.js');
const { ensureLayoutBlock } = require('../lib/scaffold.js');

module.exports = {
  id: 'claude-md-layout-block',
  title: 'Ensure CLAUDE.md carries the current AgenTeX layout block',

  detect(ctx) {
    const file = path.join(ctx.projectRoot, 'CLAUDE.md');
    if (!fs.existsSync(file)) return true;
    return parseBlock(fs.readFileSync(file)).state !== 'current';
  },

  apply(ctx) {
    const a = ensureLayoutBlock(ctx.projectRoot);
    if (a.kind === 'flag') { ctx.report.flag(a.message); return; }
    if (a.state === 'created') ctx.report.migrated(this.id, `${a.path} += AgenTeX layout block`);
    else if (a.state === 'refreshed') ctx.report.migrated(this.id, `${a.path} — AgenTeX layout block refreshed`);
  },
};
