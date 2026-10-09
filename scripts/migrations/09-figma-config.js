'use strict';
// m09 figma-config — the 0.15 ui-check feature added a "figma" block to the
// config/project.json template ({ fileKey, token: { envSecret: "FIGMA_TOKEN" } })
// and a FIGMA_TOKEN key to the secrets-only .env scaffold. Additive + idempotent:
// an existing figma block is never rewritten (user-filled values win), an existing
// FIGMA_TOKEN line is never touched, and files this project doesn't have are not
// created here (m07 fill-gaps scaffolds missing files from the current templates,
// which already carry both entries).
const fs = require('fs');
const path = require('path');

function projectConfigPath(ctx) { return path.join(ctx.projectRoot, 'config', 'project.json'); }
function envPath(ctx) { return path.join(ctx.projectRoot, '.env'); }

function configMissingFigma(ctx) {
  const file = projectConfigPath(ctx);
  if (!fs.existsSync(file)) return false;           // m07's job, from the new template
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).figma === undefined; }
  catch { return false; }                           // unreadable config: not this migration's business
}

function envMissingFigmaKey(ctx) {
  const file = envPath(ctx);
  if (!fs.existsSync(file)) return false;           // m07 scaffolds .env with the key
  return !/^\s*(?:export\s+)?FIGMA_TOKEN\s*=/m.test(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  id: 'figma-config',
  title: 'Add the figma block (config/project.json) and FIGMA_TOKEN key (.env) for ui-check baselines',

  detect(ctx) {
    return configMissingFigma(ctx) || envMissingFigmaKey(ctx);
  },

  apply(ctx) {
    const done = [];
    if (configMissingFigma(ctx)) {
      const file = projectConfigPath(ctx);
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Same shape the template ships; empty fileKey until the user sets it.
      config.figma = JSON.parse(JSON.stringify(
        ctx.templates.project.figma || { fileKey: '', token: { envSecret: 'FIGMA_TOKEN' } }));
      ctx.saveJson(file, config);
      done.push('config/project.json += figma block (empty fileKey, token by env-var name)');
    }
    if (envMissingFigmaKey(ctx)) {
      const file = envPath(ctx);
      const content = fs.readFileSync(file, 'utf8');
      const nl = content.endsWith('\n') || content === '' ? '' : '\n';
      // Key only — the value is the user's secret, typed by them, never generated.
      fs.appendFileSync(file, `${nl}\n# Figma personal access token for ui-check: design baselines.\nFIGMA_TOKEN=\n`);
      done.push('.env += FIGMA_TOKEN key (empty — fill in your token)');
    }
    ctx.report.migrated(this.id, done.join('; '));
  },
};
