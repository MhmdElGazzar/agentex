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
const fs = require('fs');
const path = require('path');

function out(obj, code) { console.log(JSON.stringify(obj)); process.exit(code); }
function blocked(reason, extra) { out({ result: 'BLOCKED', reason, ...extra }, 2); }

function slug(s) {
  const r = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return r || 'imported-api';
}
const upper = s => slug(s).toUpperCase().replace(/-/g, '_');

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

// ---- load & parse (JSON only) ----
(async () => {
  let raw;
  if (/^https?:\/\//i.test(source)) {
    try { raw = await (await fetch(source)).text(); }
    catch (e) { blocked(`could not fetch ${source}: ${e.message}`); }
  } else {
    if (!fs.existsSync(source)) blocked(`file not found: ${source}`);
    raw = fs.readFileSync(source, 'utf8');
  }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) {
    blocked(`${source} is not valid JSON (${e.message}) — this importer only reads JSON specs. ` +
      `If your doc is YAML, export/convert to JSON first (many Swagger UIs also serve a JSON ` +
      `variant, e.g. /v2/api-docs, /v3/api-docs, or a "swagger.json" link).`);
  }

  const isSwagger2 = doc.swagger === '2.0';
  const isOpenApi3 = typeof doc.openapi === 'string' && doc.openapi.startsWith('3');
  if (!isSwagger2 && !isOpenApi3) blocked('document has neither "swagger": "2.0" nor "openapi": "3.x" — not a recognized spec');

  const name = nameArg ? slug(nameArg) : slug(doc.info && doc.info.title);
  const envPrefix = nameArg ? upper(nameArg) : 'API';
  const review = [];

  // ---- base URL ----
  let baseUrlLiteral;
  if (isOpenApi3) {
    baseUrlLiteral = doc.servers && doc.servers[0] && doc.servers[0].url;
  } else {
    const scheme = (doc.schemes && doc.schemes[0]) || 'https';
    if (doc.host) baseUrlLiteral = `${scheme}://${doc.host}${doc.basePath || ''}`;
  }
  if (!baseUrlLiteral) {
    baseUrlLiteral = 'https://REPLACE_ME';
    review.push('no base URL found in the spec (servers[] / host+basePath) — set it manually');
  } else if (!/^https?:\/\//i.test(baseUrlLiteral)) {
    // OpenAPI servers[].url is commonly relative (e.g. "/api/v3") — resolve it against the
    // spec source's own origin when we fetched it from a URL; a local file has no origin to
    // resolve against, so flag it instead of guessing.
    if (/^https?:\/\//i.test(source)) {
      const resolved = new URL(baseUrlLiteral, source).href.replace(/\/$/, '');
      review.push(`spec declared a relative server URL ("${baseUrlLiteral}") — resolved to "${resolved}" against the spec's own host; verify this is correct`);
      baseUrlLiteral = resolved;
    } else {
      review.push(`spec declared a relative server URL ("${baseUrlLiteral}") and the source is a local file, so it can't be resolved automatically — set the real base URL manually`);
    }
  }
  const baseUrlEnvVar = `${envPrefix}_BASE_URL`;

  // ---- auth (one scheme applies to the whole generated catalog file) ----
  const schemesRaw = isOpenApi3 ? ((doc.components && doc.components.securitySchemes) || {}) : (doc.securityDefinitions || {});
  let auth = { type: 'none' };
  const schemeNames = Object.keys(schemesRaw);
  if (schemeNames.length) {
    // pick the first supported scheme; note the rest if there were several
    let picked = null;
    for (const key of schemeNames) {
      const s = schemesRaw[key];
      if (s.type === 'http' && s.scheme === 'bearer') { picked = { type: 'bearer', tokenEnv: `${envPrefix}_TOKEN` }; break; }
      if (s.type === 'http' && s.scheme === 'basic') { picked = { type: 'basic', userEnv: `${envPrefix}_USER`, passEnv: `${envPrefix}_PASS` }; break; }
      if (isSwagger2 && s.type === 'basic') { picked = { type: 'basic', userEnv: `${envPrefix}_USER`, passEnv: `${envPrefix}_PASS` }; break; }
      if (s.type === 'apiKey' && s.in === 'header') { picked = { type: 'apiKey', headerName: s.name, tokenEnv: `${envPrefix}_TOKEN` }; break; }
    }
    if (picked) {
      auth = picked;
      if (schemeNames.length > 1) review.push(`spec declares ${schemeNames.length} security schemes (${schemeNames.join(', ')}) — only "${auth.type}" was used; the catalog format supports one auth shape per file`);
    } else {
      review.push(`spec's security scheme(s) (${schemeNames.join(', ')}) aren't supported by the runner (oauth2/openIdConnect/apiKey-in-query) — auth left as "none", set it manually`);
    }
  }

  // ---- $ref resolution (internal "#/..." pointers only) ----
  // Real specs almost always reference reusable schemas via $ref rather than inlining them, so
  // every schema consumer below must deref before reading .type/.properties/.items — otherwise
  // request bodies degrade to a bare '{"$ref":...}' placeholder value instead of a real object
  // (this was the exact bug caught importing the public Petstore spec: every write endpoint's
  // body became the literal string "example").
  const flaggedRefs = new Set();
  function deref(schema, seen) {
    if (!schema || typeof schema !== 'object' || typeof schema.$ref !== 'string') return schema;
    const ref = schema.$ref;
    if (!ref.startsWith('#/')) {
      if (!flaggedRefs.has(ref)) { flaggedRefs.add(ref); review.push(`schema $ref "${ref}" is external (not "#/...") — not resolved, left as a placeholder`); }
      return schema;
    }
    seen = seen || new Set();
    if (seen.has(ref)) {
      if (!flaggedRefs.has(ref)) { flaggedRefs.add(ref); review.push(`schema $ref "${ref}" is part of a circular reference chain — resolved to an empty schema instead of looping`); }
      return {};
    }
    const parts = ref.slice(2).split('/').map(p => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
    let node = doc;
    for (const part of parts) { node = node == null ? undefined : node[part]; }
    if (node === undefined) {
      if (!flaggedRefs.has(ref)) { flaggedRefs.add(ref); review.push(`schema $ref "${ref}" does not resolve within the document — left as a placeholder`); }
      return schema;
    }
    seen.add(ref);
    return deref(node, seen);
  }

  // ---- helpers for example values ----
  // Shared by exampleFor (params) and bodyValueFor (JSON bodies) so a format-aware placeholder
  // (e.g. a real date-time string, not the literal "example") only needs to be taught once.
  // Untyped/unrecognized formats fall back to the generic 'example' placeholder, flagged for
  // review by the caller same as before.
  function primitivePlaceholder(schema) {
    switch (schema.type) {
      case 'integer': case 'number': return 1;
      case 'boolean': return false;
      case 'string':
        if (schema.format === 'date-time') return '2024-01-01T00:00:00Z';
        if (schema.format === 'date') return '2024-01-01';
        return 'example';
      default: return 'example';
    }
  }
  // Swagger 2.0 path/query parameter objects carry "type" directly (no nested schema);
  // OpenAPI 3.x parameter objects nest it under "schema". Normalize to whichever exists.
  function paramSchema(p) { return deref(p.schema || p); }
  function exampleFor(schema) {
    schema = deref(schema);
    if (!schema) return { value: 'example', inferred: true };
    if (schema.example !== undefined) return { value: schema.example, inferred: false };
    if (schema.default !== undefined) return { value: schema.default, inferred: false };
    if (Array.isArray(schema.enum) && schema.enum.length) return { value: schema.enum[0], inferred: true };
    if (schema.type === 'array') {
      // Only a single representative value is generated — real OpenAPI array-query
      // serialization (style/explode: repeated keys vs. comma-joined) isn't attempted, since
      // a 1-element array is indistinguishable from a scalar under the common default
      // (style: form, explode: true). Flagged in review by the caller.
      const item = exampleFor(schema.items || {});
      return { value: item.value, inferred: true, isArray: true };
    }
    return { value: primitivePlaceholder(schema), inferred: true };
  }
  function notFoundValueFor(schema) {
    return (schema && (schema.type === 'integer' || schema.type === 'number')) ? 999999999 : '__REPLACE_ME__';
  }
  // Recursive body-value builder — unlike exampleFor (which intentionally flattens arrays to a
  // single representative scalar, correct for query/path params), a JSON request body needs
  // real nested arrays/objects: photoUrls must stay an array, category must stay an object, or
  // a strict server rejects the whole body as a type mismatch. depth caps pathological/self-
  // referential inline schemas (rare; $ref cycles are already guarded in deref()).
  function bodyValueFor(schema, depth) {
    schema = deref(schema);
    depth = depth || 0;
    if (!schema || depth > 6) return 'example';
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    if (schema.type === 'array') return [bodyValueFor(schema.items || {}, depth + 1)];
    if (schema.type === 'object' || schema.properties) {
      const o = {};
      for (const [prop, propSchema] of Object.entries(schema.properties || {})) o[prop] = bodyValueFor(propSchema, depth + 1);
      return o;
    }
    return primitivePlaceholder(schema);
  }
  function bodyExampleFor(schema) { return bodyValueFor(schema); }
  function responseSchema(responses, code) {
    const r = responses && responses[code];
    if (!r) return null;
    const schema = isOpenApi3 ? (r.content && r.content['application/json'] && r.content['application/json'].schema) : r.schema;
    return deref(schema);
  }
  function firstCode(responses, test) {
    return Object.keys(responses || {}).find(c => c !== 'default' && test(parseInt(c, 10)));
  }

  // ---- walk paths ----
  const requests = [];
  const cases = [];
  const methods = ['get', 'post', 'put', 'patch', 'delete'];
  for (const [urlPath, pathItem] of Object.entries(doc.paths || {})) {
    const pathLevelParams = pathItem.parameters || [];
    for (const method of methods) {
      const op = pathItem[method];
      if (!op) continue;
      const opParams = [...pathLevelParams, ...(op.parameters || [])];
      const byName = new Map();
      for (const p of opParams) byName.set(p.name, p); // operation-level overrides path-level
      const usableParams = [...byName.values()].filter(p => p.in === 'path' || p.in === 'query');
      const skippedParams = [...byName.values()].filter(p => p.in !== 'path' && p.in !== 'query' && p.in !== 'body');
      if (skippedParams.length) review.push(`${method.toUpperCase()} ${urlPath}: skipped ${skippedParams.map(p => `${p.name} (in: ${p.in})`).join(', ')} — only path/query params are supported`);

      const reqName = slug(op.operationId) !== 'imported-api' ? slug(op.operationId) : slug(`${method}-${urlPath}`);
      const declaredParams = usableParams.map(p => p.name);

      // request body (POST/PUT/PATCH)
      let bodySchema, body;
      if (['post', 'put', 'patch'].includes(method)) {
        if (isOpenApi3 && op.requestBody) bodySchema = op.requestBody.content && op.requestBody.content['application/json'] && op.requestBody.content['application/json'].schema;
        else { const bodyParam = opParams.find(p => p.in === 'body'); if (bodyParam) bodySchema = bodyParam.schema; }
        if (bodySchema) { body = bodyExampleFor(bodySchema); review.push(`${method.toUpperCase()} ${urlPath}: request body generated from schema — verify/adjust values`); }
      }

      requests.push({
        name: reqName,
        description: op.summary || op.description || undefined,
        method: method.toUpperCase(),
        path: urlPath,
        params: declaredParams,
        ...(body !== undefined ? { body } : {}),
      });

      // happy-path suite case
      const okCode = firstCode(op.responses, c => c >= 200 && c < 300);
      const okSchema = okCode && responseSchema(op.responses, okCode);
      const happyParams = {};
      for (const p of usableParams) {
        const ex = exampleFor(paramSchema(p));
        happyParams[p.name] = ex.value;
        if (ex.isArray) review.push(`${method.toUpperCase()} ${urlPath}: param "${p.name}" is array-typed — using a single representative value, not full array serialization (style/explode) — verify it's accepted`);
      }
      const expectHappy = { status: okCode ? parseInt(okCode, 10) : 200 };
      // Only assert schema-required properties, not every documented one — optional fields are
      // routinely omitted by a real server (null/absent), so asserting on all of them would
      // fail correct responses. If the schema declares no required[], no fields are asserted
      // (nothing is safe to assume present) rather than falling back to "all properties".
      if (okSchema && okSchema.type !== 'array' && okSchema.properties && Array.isArray(okSchema.required) && okSchema.required.length) {
        const requiredDeclared = okSchema.required.filter(k => k in okSchema.properties);
        if (requiredDeclared.length) expectHappy.fields = requiredDeclared;
      }
      cases.push({ name: `${reqName}-happy-path`, entry: `${name}.${reqName}`, params: happyParams, expect: expectHappy });

      // error-case suite case, if a 4xx is documented and there's a param to break
      const errCode = firstCode(op.responses, c => c >= 400 && c < 500);
      if (errCode && usableParams.length) {
        const errParams = {};
        for (const p of usableParams) errParams[p.name] = notFoundValueFor(paramSchema(p));
        cases.push({ name: `${reqName}-error-case`, entry: `${name}.${reqName}`, params: errParams, expect: { status: parseInt(errCode, 10) } });
        review.push(`${method.toUpperCase()} ${urlPath}: error case uses a placeholder param value — verify it actually produces ${errCode}`);
      }
    }
  }
  if (!requests.length) blocked('no operations found in "paths" — nothing to import');

  // ---- write catalog + suite, co-located under <dir>/<name>/ (never overwrite) ----
  const serviceDir = path.join(baseDir, name);
  const catalogPath = path.join(serviceDir, `${name}_api.json`);
  const suitePath = path.join(serviceDir, `${name}_suite.json`);
  if (fs.existsSync(catalogPath)) blocked(`${catalogPath} already exists — pick a different --name or remove/rename it first`);
  if (fs.existsSync(suitePath)) blocked(`${suitePath} already exists — pick a different --name or remove/rename it first`);

  const catalog = { name, description: doc.info && doc.info.description || `Imported from ${source}`, baseUrl: `\${${baseUrlEnvVar}}`, auth, requests };
  const suite = { name: `${name}-suite`, cases };

  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  fs.writeFileSync(suitePath, JSON.stringify(suite, null, 2) + '\n');

  out({
    result: 'OK', catalogPath, suitePath, operationsImported: requests.length, casesGenerated: cases.length,
    envVarsToSet: { [baseUrlEnvVar]: baseUrlLiteral, ...(auth.tokenEnv ? { [auth.tokenEnv]: '<set in your shell, never in .env>' } : {}), ...(auth.userEnv ? { [auth.userEnv]: '<set in your shell>', [auth.passEnv]: '<set in your shell>' } : {}) },
    review,
  }, 0);
})();
