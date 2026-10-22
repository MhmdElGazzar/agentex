// AgenTeX Swagger/OpenAPI importer — generates a catalog file (<name>_api.json) and a suite
// file (<name>_suite.json), co-located under integration/api_test_suites/<name>/, from a
// Swagger 2.0 or OpenAPI 3.x JSON document. JSON only (no YAML parser — see
// references/swagger-mapping.md for why). Never overwrites an existing catalog/suite file —
// refuses instead, so two files can never collide on the same internal catalog "name".
//
// Usage:
//   node import_swagger.js <path-or-url> [--name <service>]
//     [--dir ./integration/api_test_suites]
//
// Prints ONE JSON line: {"result":"OK|BLOCKED", ...}. Exit: 0 OK, 2 BLOCKED.
// Everything generated is a best-effort skeleton — review notes are collected in "review".
// The spec model (parsing, $ref resolution, auth, the legacy happy-path + error-case set) lives
// in swagger_model.js, shared with the suite wizard; this CLI's output is unchanged by it.
const fs = require('fs');
const path = require('path');
const M = require('./swagger_model.js');

function out(obj, code) { console.log(JSON.stringify(obj)); process.exit(code); }
function blocked(reason, extra) { out({ result: 'BLOCKED', reason, ...extra }, 2); }

// ---- args ----
const args = process.argv.slice(2);
let source, nameArg, baseDir = './integration/api_test_suites';
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = () => args[++i];
  if (a === '--name') nameArg = v();
  else if (a === '--dir') baseDir = v();
  else if (!a.startsWith('--') && !source) source = a;
}
if (!source) blocked('usage: <path-or-url> [--name <service>] required');

(async () => {
  let doc, model, gen;
  try {
    doc = await M.loadSpec(source);
    model = M.parseSpec(doc, source);
  } catch (e) { blocked(e.message, e.extra); }
  const name = nameArg ? M.slug(nameArg) : M.slug(doc.info && doc.info.title);
  try { gen = M.generateLegacy(model, { name }); }
  catch (e) { blocked(e.message, e.extra); }
  const { catalog, suite, review, baseUrlEnvVar, baseUrlLiteral, auth } = gen;

  // ---- write catalog + suite, co-located under <dir>/<name>/ (never overwrite) ----
  const serviceDir = path.join(baseDir, name);
  const catalogPath = path.join(serviceDir, `${name}_api.json`);
  const suitePath = path.join(serviceDir, `${name}_suite.json`);
  if (fs.existsSync(catalogPath)) blocked(`${catalogPath} already exists — pick a different --name or remove/rename it first`);
  if (fs.existsSync(suitePath)) blocked(`${suitePath} already exists — pick a different --name or remove/rename it first`);

  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  fs.writeFileSync(suitePath, JSON.stringify(suite, null, 2) + '\n');

  const SECRET_HINT = '<set in .env>';
  out({
    result: 'OK', catalogPath, suitePath, operationsImported: catalog.requests.length, casesGenerated: suite.cases.length,
    // House rule (docs/configuration.md): every value goes in the project's .env (the catalog
    // holds only the names; never printed); run_api.js resolves catalog ${VAR} names from the
    // process environment first, then .env.
    envVarsToSet: {
      [baseUrlEnvVar]: baseUrlLiteral,
      ...(auth.tokenEnv ? { [auth.tokenEnv]: SECRET_HINT } : {}),
      ...(auth.userEnv ? { [auth.userEnv]: SECRET_HINT, [auth.passEnv]: SECRET_HINT } : {}),
    },
    envVarsNote: `add these to the project's .env (secrets stay there, never in the catalog/suite files); run_api.js resolves catalog \${VAR} names from the environment, then .env. ${baseUrlEnvVar} is not a secret: you may instead replace the catalog's baseUrl with the literal URL`,
    review,
  }, 0);
})();
