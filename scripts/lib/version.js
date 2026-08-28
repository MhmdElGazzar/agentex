'use strict';
// AgenTeX shared version semantics — the ONE compare implementation behind both the
// migration engine's stamp-newer abort (scripts/migrate.js) and the plugin
// self-update check (scripts/self_update.js). Extracted from migrate.js unchanged:
// if these two gates ever used different semantics, the "stamp newer → update the
// plugin" abort and the "newer version available" check could disagree at the seams
// (pre-release suffixes) — exactly the bug class a single shared module closes.

// Dotted-version compare: negative when a < b, 0 when equal, positive when a > b.
function compareVersions(a, b) {
  const pa = String(a).split('.'), pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] || '0', 10), nb = parseInt(pb[i] || '0', 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      if ((pa[i] || '') !== (pb[i] || '')) return (pa[i] || '') < (pb[i] || '') ? -1 : 1;
      continue;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

module.exports = { compareVersions };
