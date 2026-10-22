'use strict';
// The one run-folder timestamp: local time, YYYY-MM-DD_HH-MM-SS. Used by test-execution's
// init_run.js (executions/execu_<stamp>) and by the studio's own runs, so a run folder is named
// the same wherever it came from.
function runStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

module.exports = { runStamp };
