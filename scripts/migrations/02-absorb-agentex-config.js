'use strict';
// m02 absorb-agentex-config — KB-era root agentex.config.json held kb.* settings
// (still honored as a fallback by ask_kb.js); their home is now the kb block in
// config/project.json. Carries each kb key only where the JSON field is unset
// (missing, empty, or byte-equal to the shipped template sample — existing JSON
// wins otherwise), then deletes the legacy file. The file is committed, so git is
// the rollback for the deletion.
const fs = require('fs');
const path = require('path');

function isUnset(cur, tplVal) {
  return cur === undefined || cur === null || cur === '' ||
    (tplVal !== undefined && String(cur) === String(tplVal));
}

module.exports = {
  id: 'absorb-agentex-config',
  title: 'Absorb legacy agentex.config.json kb settings into config/project.json',

  detect(ctx) {
    return fs.existsSync(path.join(ctx.projectRoot, 'agentex.config.json'));
  },

  apply(ctx) {
    const legacyFile = path.join(ctx.projectRoot, 'agentex.config.json');
    let legacy;
    try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); }
    catch {
      // Never delete a file we could not read — fix by hand, then re-run.
      ctx.report.manual('agentex.config.json is not valid JSON — left in place; fix or remove it by hand, then re-run /update-agentex');
      return;
    }

    const projectFile = path.join(ctx.projectRoot, 'config', 'project.json');
    let createdNote = '';
    if (!fs.existsSync(projectFile)) {
      ctx.saveJson(projectFile, JSON.parse(JSON.stringify(ctx.templates.project)));
      createdNote = 'created config/project.json from template; ';
    }
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    if (!project.kb || typeof project.kb !== 'object') {
      project.kb = JSON.parse(JSON.stringify(ctx.templates.project.kb || {}));
    }

    const carried = [];
    const legacyKb = (legacy && typeof legacy.kb === 'object' && legacy.kb) || {};
    for (const [k, v] of Object.entries(legacyKb)) {
      if (v === undefined || v === null || v === '') continue;
      const tplVal = (ctx.templates.project.kb || {})[k];
      if (isUnset(project.kb[k], tplVal)) {
        project.kb[k] = v;
        carried.push(`kb.${k}`);
      } else if (String(project.kb[k]) !== String(v)) {
        ctx.report.ok(`kept existing kb.${k} in config/project.json — JSON wins over agentex.config.json`);
      }
    }

    const extraKeys = Object.keys(legacy || {}).filter(k => k !== 'kb');
    if (extraKeys.length) {
      ctx.report.flag(`agentex.config.json held unmigrated top-level key(s): ${extraKeys.join(', ')} — removed with the file; recover from git history if still needed`);
    }

    ctx.saveJson(projectFile, project);
    fs.unlinkSync(legacyFile);
    ctx.report.migrated(this.id,
      `${createdNote}agentex.config.json → config/project.json (${carried.length ? carried.join(', ') : 'nothing new to carry'}); legacy file removed`);
  },
};
