'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveRuntime } = require('./resolve_runtime.js');

const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

function plan(projectPath, options = {}) {
  if (!projectPath || typeof projectPath !== 'string') throw new Error('--project <existing-directory> is required');
  const runtime = resolveRuntime(options);
  const project = fs.realpathSync(projectPath);
  if (!fs.statSync(project).isDirectory() || inside(runtime.coreRoot, project) ||
      inside(runtime.packageRoot, project)) {
    throw new Error('project must be a separate existing consumer directory');
  }
  const { scaffoldProject, inspectVersionStamp, hasLegacySignals } =
    require(path.join(runtime.coreRoot, 'scripts', 'lib', 'scaffold.js'));
  return {
    ok: true, mode: 'plan', project, pluginVersion: runtime.version,
    projectVersion: inspectVersionStamp(project), legacySignals: hasLegacySignals(project),
    existingAgentsMd: fs.existsSync(path.join(project, 'AGENTS.md')),
    actions: scaffoldProject(project, runtime.coreRoot, { dryRun: true }),
  };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--project') throw new Error('usage: init_plan.js --project <existing-directory>');
    console.log(JSON.stringify(plan(args[1])));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
  }
}

module.exports = { plan };
