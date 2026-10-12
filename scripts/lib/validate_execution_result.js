'use strict';
// Optional ingestion adapter for future hosts. Existing Claude callers do not use it.
// Usage: node validate_execution_result.js <assignment.json> <result.json> <source-root> <run-root>
const fs = require('node:fs');
const { validateExecutionResult } = require('./execution_result');

function main(args) {
  if (args.length !== 4) return { ok: false, verdict: 'BLOCKED', exitCode: 2,
    coverage: { required: 0, recorded: 0 }, errors: [{ code: 'usage' }] };
  try {
    const [assignmentFile, resultFile, sourceRoot, runRoot] = args;
    return validateExecutionResult({
      assignment: JSON.parse(fs.readFileSync(assignmentFile, 'utf8')),
      result: JSON.parse(fs.readFileSync(resultFile, 'utf8')),
      sourceRoot, runRoot,
    });
  } catch {
    return { ok: false, verdict: 'BLOCKED', exitCode: 2,
      coverage: { required: 0, recorded: 0 }, errors: [{ code: 'ingestion-error' }] };
  }
}

if (require.main === module) {
  const output = main(process.argv.slice(2));
  console.log(JSON.stringify(output));
  process.exitCode = output.exitCode;
}
module.exports = { main };
