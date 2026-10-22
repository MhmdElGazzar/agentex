'use strict';
// AgenTeX Swagger/OpenAPI spec model — shared by import_swagger.js (the CLI, legacy case set)
// and the suite studio's wizard (four-kind case set). JSON only. No I/O except loadSpec.
//
//   loadSpec(source)                       → Promise<doc>; throws SpecError (message + extra)
//   parseSpec(doc, source)                 → model; throws SpecError for an unknown document
//   listOperations(model)                  → [{id, method, path, summary, operationId, auth:
//                                              "token"|"public", needs:[{param,in,type,...}],
//                                              destructive, write, request}]
//   generate(model, selection, values, opts) → {catalog, suite, summary} — the wizard's cases:
//       happy (2xx + required response fields), not-found (404, Auto non-existent ID, only
//       with an ID in the path), no-token (401, auth "none", only where auth is required),
//       missing-field (400, omit the first required query param or top-level body field).
//       Write-operation cases carry the write skip. A 404/400 message comes only from a
//       documented example (404 equals, 400 contains); otherwise the case is status-only with
//       a review note — never from an observed response.
//   generateLegacy(model, {name})          → the importer's happy-path + error-case set,
//       byte-identical to the pre-extraction import_swagger.js.

class SpecError extends Error {
  constructor(message, extra) { super(message); this.extra = extra || {}; }
}

function slug(s) {
  const r = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return r || 'imported-api';
}
const upper = s => slug(s).toUpperCase().replace(/-/g, '_');
// Env-var prefix = the service name in UPPER_SNAKE (e.g. PET_STORE_BASE_URL) — never the bare
// "API" prefix, which collides with the project's own API_BASE_URL / API_TOKEN.
const envPrefixFor = name => (upper(name) === 'API' ? 'API_SERVICE' : upper(name));

const WRITE_SKIP = 'review: write operation — remove this line to enable';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
// Generated non-existent IDs for not-found cases (source "auto"). (Q8)
const AUTO_IDS = { integer: 999999999, uuid: '00000000-0000-4000-8000-000000000000', string: 'agentex-does-not-exist' };
// A12: a write operation is destructive when it is a DELETE, carries x-destructive: true, or
// its summary / operationId uses one of these verbs.
const DESTRUCTIVE_VERBS = ['delete', 'remove', 'destroy', 'purge', 'erase', 'wipe', 'drop', 'truncate', 'terminate', 'revoke', 'reset', 'cancel'];
// A12: where an error example keeps its message — the first string found wins.
const MESSAGE_PATHS = ['message', 'error.message', 'detail', 'title', 'error'];

// ---- load (file or URL) ----
async function loadSpec(source) {
  let raw;
  if (/^https?:\/\//i.test(source)) {
    let res;
    try { res = await fetch(source); raw = await res.text(); }
    catch (e) { throw new SpecError(`could not fetch ${source}: ${e.message}`); }
    if (!res.ok) throw new SpecError(`could not fetch ${source}: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`, { status: res.status });
  } else {
    const fs = require('fs');
    if (!fs.existsSync(source)) throw new SpecError(`file not found: ${source}`);
    raw = fs.readFileSync(source, 'utf8');
  }
  try { return JSON.parse(raw); }
  catch (e) {
    throw new SpecError(`${source} is not valid JSON (${e.message}) — this importer only reads JSON specs. ` +
      `If your doc is YAML, export/convert to JSON first (many Swagger UIs also serve a JSON ` +
      `variant, e.g. /v2/api-docs, /v3/api-docs, or a "swagger.json" link).`);
  }
}

function parseSpec(doc, source) {
  const isSwagger2 = !!doc && doc.swagger === '2.0';
  const isOpenApi3 = !!doc && typeof doc.openapi === 'string' && doc.openapi.startsWith('3');
  if (!isSwagger2 && !isOpenApi3) throw new SpecError('document has neither "swagger": "2.0" nor "openapi": "3.x" — not a recognized spec');
  return { doc, source, isSwagger2, isOpenApi3 };
}

// Schema helpers bound to one document; review notes go into the given array.
function helpers(model, review) {
  const { doc, isOpenApi3 } = model;
  // ---- $ref resolution (internal "#/..." pointers only) ----
  // Real specs almost always reference reusable schemas via $ref rather than inlining them, so
  // every schema consumer below must deref before reading .type/.properties/.items — otherwise
  // request bodies degrade to a bare '{"$ref":...}' placeholder value instead of a real object.
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
  // Shared by exampleFor (params) and bodyValueFor (JSON bodies) so a format-aware placeholder
  // only needs to be taught once. Untyped/unrecognized formats fall back to 'example'.
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
      // serialization (style/explode) isn't attempted. Flagged in review by the caller.
      const item = exampleFor(schema.items || {});
      return { value: item.value, inferred: true, isArray: true };
    }
    return { value: primitivePlaceholder(schema), inferred: true };
  }
  function notFoundValueFor(schema) {
    return (schema && (schema.type === 'integer' || schema.type === 'number')) ? 999999999 : '__REPLACE_ME__';
  }
  // Recursive body-value builder: a JSON request body needs real nested arrays/objects. depth
  // caps pathological/self-referential inline schemas ($ref cycles are guarded in deref()).
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
  function responseSchema(responses, code) {
    const r = responses && responses[code];
    if (!r) return null;
    const schema = isOpenApi3 ? (r.content && r.content['application/json'] && r.content['application/json'].schema) : r.schema;
    return deref(schema);
  }
  function firstCode(responses, test) {
    return Object.keys(responses || {}).find(c => c !== 'default' && test(parseInt(c, 10)));
  }
  return { deref, primitivePlaceholder, paramSchema, exampleFor, notFoundValueFor, bodyValueFor, responseSchema, firstCode };
}

// ---- base URL ----
function baseUrlFor(model, review) {
  const { doc, source, isOpenApi3 } = model;
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
    // OpenAPI servers[].url is commonly relative (e.g. "/api/v3") — resolve it against the spec
    // source's own origin when it came from a URL; a local file has no origin, so flag it.
    if (/^https?:\/\//i.test(source)) {
      const resolved = new URL(baseUrlLiteral, source).href.replace(/\/$/, '');
      review.push(`spec declared a relative server URL ("${baseUrlLiteral}") — resolved to "${resolved}" against the spec's own host; verify this is correct`);
      baseUrlLiteral = resolved;
    } else {
      review.push(`spec declared a relative server URL ("${baseUrlLiteral}") and the source is a local file, so it can't be resolved automatically — set the real base URL manually`);
    }
  }
  return baseUrlLiteral;
}

// ---- auth (one scheme applies to the whole generated catalog file) ----
function authFor(model, envPrefix, review) {
  const { doc, isOpenApi3, isSwagger2 } = model;
  const schemesRaw = isOpenApi3 ? ((doc.components && doc.components.securitySchemes) || {}) : (doc.securityDefinitions || {});
  let auth = { type: 'none' };
  const schemeNames = Object.keys(schemesRaw);
  if (schemeNames.length) {
    // Preference, regardless of declaration order: bearer > apiKey (header) > basic.
    const kindOf = (key) => {
      const s = schemesRaw[key] || {};
      const scheme = String(s.scheme || '').toLowerCase();
      if (s.type === 'http' && scheme === 'bearer') return 'bearer';
      if (s.type === 'apiKey' && s.in === 'header') {
        if (typeof s.name === 'string' && s.name.trim()) return 'apiKey';
        review.push(`security scheme "${key}" is apiKey-in-header but declares no header "name" — not used; set auth.headerName manually`);
        return null;
      }
      if ((s.type === 'http' && scheme === 'basic') || (isSwagger2 && s.type === 'basic')) return 'basic';
      return null;
    };
    const kinds = schemeNames.map(key => ({ key, kind: kindOf(key) }));
    let picked = null;
    for (const want of ['bearer', 'apiKey', 'basic']) {
      const hit = kinds.find(k => k.kind === want);
      if (!hit) continue;
      if (want === 'bearer') picked = { type: 'bearer', tokenEnv: `${envPrefix}_TOKEN` };
      else if (want === 'apiKey') picked = { type: 'apiKey', headerName: schemesRaw[hit.key].name.trim(), tokenEnv: `${envPrefix}_TOKEN` };
      else picked = { type: 'basic', userEnv: `${envPrefix}_USER`, passEnv: `${envPrefix}_PASS` };
      break;
    }
    if (picked) {
      auth = picked;
      if (schemeNames.length > 1) review.push(`spec declares ${schemeNames.length} security schemes (${schemeNames.join(', ')}) — only "${auth.type}" was used; the catalog format supports one auth shape per file`);
    } else {
      review.push(`spec's security scheme(s) (${schemeNames.join(', ')}) aren't supported by the runner (oauth2/openIdConnect/apiKey-in-query) — auth left as "none", set it manually`);
    }
  }
  return auth;
}

// ---- legacy generation: the importer's own case set, unchanged ----
function generateLegacy(model, opts) {
  const { doc, source, isOpenApi3 } = model;
  const name = opts.name;
  const envPrefix = envPrefixFor(name);
  const review = [];
  const baseUrlLiteral = baseUrlFor(model, review);
  const baseUrlEnvVar = `${envPrefix}_BASE_URL`;
  const auth = authFor(model, envPrefix, review);
  const h = helpers(model, review);

  const requests = [];
  const cases = [];
  const usedNames = new Set();
  let writeOps = 0;
  for (const [urlPath, pathItem] of Object.entries(doc.paths || {})) {
    const pathLevelParams = pathItem.parameters || [];
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const isWrite = !['get', 'head'].includes(method);
      if (isWrite) writeOps++;
      const opTag = `${method.toUpperCase()} ${urlPath}`;
      // Per-item review notes are written INTO the generated request/case objects (a "review"
      // array) and also echoed to the command's stdout "review" list.
      const reqReview = [], happyReview = [], errReview = [];
      const note = (arr, msg) => { arr.push(msg); review.push(`${opTag}: ${msg}`); };
      const opParams = [...pathLevelParams, ...(op.parameters || [])];
      const byName = new Map();
      for (const p of opParams) byName.set(p.name, p); // operation-level overrides path-level
      const usableParams = [...byName.values()].filter(p => p.in === 'path' || p.in === 'query');
      const skippedParams = [...byName.values()].filter(p => p.in !== 'path' && p.in !== 'query' && p.in !== 'body');
      if (skippedParams.length) note(reqReview, `skipped ${skippedParams.map(p => `${p.name} (in: ${p.in})`).join(', ')} — only path/query params are supported`);

      const baseReqName = slug(op.operationId) !== 'imported-api' ? slug(op.operationId) : slug(`${method}-${urlPath}`);
      // Request names must be unique within the catalog (entries are <catalog>.<request>).
      let reqName = baseReqName;
      for (let n = 2; usedNames.has(reqName); n++) reqName = `${baseReqName}-${n}`;
      usedNames.add(reqName);
      if (reqName !== baseReqName) note(reqReview, `duplicate request name "${baseReqName}" (another operation already produced it) — renamed to "${reqName}"; rename it to something meaningful`);
      const declaredParams = usableParams.map(p => p.name);
      const queryParams = usableParams.filter(p => p.in === 'query').map(p => p.name);

      // request body (POST/PUT/PATCH)
      let bodySchema, body;
      if (['post', 'put', 'patch'].includes(method)) {
        const isJson = t => /^application\/(.+\+)?json\b/i.test(t);
        if (isOpenApi3 && op.requestBody) {
          const content = op.requestBody.content || {};
          const jsonType = Object.keys(content).find(isJson);
          if (jsonType) bodySchema = content[jsonType].schema;
          else if (Object.keys(content).length) note(reqReview, `request body dropped — only JSON bodies are supported, the spec declares ${Object.keys(content).join(', ')}; add the body manually if this call needs one`);
        } else {
          const bodyParam = opParams.find(p => p.in === 'body');
          const consumes = op.consumes || doc.consumes;
          if (bodyParam && Array.isArray(consumes) && consumes.length && !consumes.some(isJson)) {
            note(reqReview, `request body dropped — only JSON bodies are supported, the spec consumes ${consumes.join(', ')}; add the body manually if this call needs one`);
          } else if (bodyParam) bodySchema = bodyParam.schema;
        }
        if (bodySchema) { body = h.bodyValueFor(bodySchema); note(reqReview, 'request body generated from schema — verify/adjust values'); }
      }

      requests.push({
        name: reqName,
        description: op.summary || op.description || undefined,
        method: method.toUpperCase(),
        path: urlPath,
        params: declaredParams,
        ...(queryParams.length ? { query: queryParams } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(reqReview.length ? { review: reqReview } : {}),
      });
      // Generated write-method cases are opt-in: written disabled until the user reviews them.
      const skip = isWrite ? { skip: WRITE_SKIP } : {};

      // happy-path suite case
      const okCode = h.firstCode(op.responses, c => c >= 200 && c < 300);
      const okSchema = okCode && h.responseSchema(op.responses, okCode);
      const happyParams = {};
      for (const p of usableParams) {
        const ex = h.exampleFor(h.paramSchema(p));
        happyParams[p.name] = ex.value;
        if (ex.inferred) note(happyReview, `param "${p.name}" = ${JSON.stringify(ex.value)} is inferred (the spec gives no example/default) — replace it with a value that exists in your target`);
        if (ex.isArray) note(happyReview, `param "${p.name}" is array-typed — using a single representative value, not full array serialization (style/explode) — verify it's accepted`);
      }
      const expectHappy = { status: okCode ? parseInt(okCode, 10) : 200 };
      if (!okCode) note(happyReview, 'no 2xx response is documented — expect.status 200 is a guess; set the real success status');
      // Only assert schema-required properties, not every documented one — optional fields are
      // routinely omitted by a real server. No required[] → no fields asserted.
      if (okSchema && okSchema.type !== 'array' && okSchema.properties && Array.isArray(okSchema.required) && okSchema.required.length) {
        const requiredDeclared = okSchema.required.filter(k => k in okSchema.properties);
        if (requiredDeclared.length) expectHappy.fields = requiredDeclared;
      }
      cases.push({ name: `${reqName}-happy-path`, entry: `${name}.${reqName}`, ...skip, params: happyParams, expect: expectHappy, ...(happyReview.length ? { review: happyReview } : {}) });

      // error-case suite case, if a 4xx is documented and there's a param to break
      const errCode = h.firstCode(op.responses, c => c >= 400 && c < 500);
      if (errCode && usableParams.length) {
        const errParams = {};
        for (const p of usableParams) errParams[p.name] = h.notFoundValueFor(h.paramSchema(p));
        note(errReview, `error case uses a placeholder param value — verify it actually produces ${errCode}`);
        cases.push({ name: `${reqName}-error-case`, entry: `${name}.${reqName}`, ...skip, params: errParams, expect: { status: parseInt(errCode, 10) }, review: errReview });
      }
    }
  }
  if (!requests.length) throw new SpecError('no operations found in "paths" — nothing to import');
  if (writeOps) review.push(`${writeOps} write operation(s) (POST/PUT/PATCH/DELETE): their suite cases are written with "skip" and will not run until you review each one and remove its "skip" line`);

  // "target": "catalog" — an imported service is called at its own ${<NAME>_BASE_URL} with its
  // own auth; the active environment's api block (the project's own API) never redirects it.
  const catalog = { name, description: doc.info && doc.info.description || `Imported from ${source}`, target: 'catalog', baseUrl: `\${${baseUrlEnvVar}}`, auth, requests };
  const suite = { name: `${name}-suite`, cases };
  return { catalog, suite, review, baseUrlEnvVar, baseUrlLiteral, auth };
}

// ---- the wizard's operation list and four-kind generator ----
function bodySchemaOf(model, op, method, opParams) {
  if (!['post', 'put', 'patch'].includes(method)) return null;
  const isJson = t => /^application\/(.+\+)?json\b/i.test(t);
  if (model.isOpenApi3) {
    const content = (op.requestBody && op.requestBody.content) || {};
    const jsonType = Object.keys(content).find(isJson);
    return jsonType ? content[jsonType].schema : null;
  }
  const bodyParam = opParams.find(p => p.in === 'body');
  return bodyParam ? bodyParam.schema : null;
}
function typeOf(schema) {
  if (!schema) return 'string';
  if (schema.type === 'integer' || schema.type === 'number' || schema.type === 'boolean' || schema.type === 'string') return schema.type;
  if (schema.type === 'object' || schema.type === 'array' || schema.properties) return 'json';
  return 'string';
}
function wordsOf(s) { return String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
function isDestructive(method, op) {
  if (method === 'delete' || op['x-destructive'] === true) return true;
  const words = [...wordsOf(op.summary), ...wordsOf(op.operationId)];
  return words.some(w => DESTRUCTIVE_VERBS.includes(w));
}

function walkOperations(model, review) {
  const { doc } = model;
  const h = helpers(model, review);
  const usedNames = new Set();
  const ops = [];
  for (const [urlPath, pathItem] of Object.entries(doc.paths || {})) {
    const pathLevelParams = pathItem.parameters || [];
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const opParams = [...pathLevelParams, ...(op.parameters || [])];
      const byName = new Map();
      for (const p of opParams) byName.set(p.name, p);
      const params = [...byName.values()];
      const security = op.security !== undefined ? op.security : doc.security;
      const auth = Array.isArray(security) && security.length ? 'token' : 'public';
      const needs = [];
      for (const p of params.filter(q => q.in === 'path')) needs.push({ param: p.name, in: 'path', type: typeOf(h.paramSchema(p)), format: (h.paramSchema(p) || {}).format, schema: h.paramSchema(p) });
      for (const p of params.filter(q => q.in === 'query' && q.required)) needs.push({ param: p.name, in: 'query', type: typeOf(h.paramSchema(p)), schema: h.paramSchema(p) });
      const bodySchema = h.deref(bodySchemaOf(model, op, method, opParams));
      if (bodySchema && Array.isArray(bodySchema.required)) {
        for (const field of bodySchema.required) {
          const fs_ = h.deref((bodySchema.properties || {})[field]) || {};
          const clash = needs.some(n => n.param === field);
          needs.push({ param: clash ? `body_${field}` : field, field, in: 'body', type: typeOf(fs_), schema: fs_ });
        }
      }
      const baseReqName = slug(op.operationId) !== 'imported-api' ? slug(op.operationId) : slug(`${method}-${urlPath}`);
      let request = baseReqName;
      for (let n = 2; usedNames.has(request); n++) request = `${baseReqName}-${n}`;
      usedNames.add(request);
      const write = !['get', 'head'].includes(method);
      ops.push({
        id: `${method.toUpperCase()} ${urlPath}`, method: method.toUpperCase(), path: urlPath,
        summary: op.summary || op.description || '', operationId: op.operationId || '',
        auth, needs, write, destructive: write && isDestructive(method, op), request, op,
      });
    }
  }
  return { ops, h };
}

function listOperations(model) {
  return walkOperations(model, []).ops.map(({ op, needs, ...o }) => ({ ...o, needs: needs.map(({ schema, ...n }) => n) }));
}

function exampleBody(model, h, response) {
  if (!response) return undefined;
  if (model.isOpenApi3) {
    const media = response.content && (response.content['application/json'] || Object.entries(response.content).find(([t]) => /json/i.test(t))?.[1]);
    if (!media) return undefined;
    if (media.example !== undefined) return media.example;
    if (media.examples && typeof media.examples === 'object') {
      const first = Object.values(media.examples)[0];
      if (first && first.value !== undefined) return first.value;
    }
    const schema = h.deref(media.schema);
    return schema && schema.example !== undefined ? schema.example : undefined;
  }
  if (response.examples && typeof response.examples === 'object') {
    const v = response.examples['application/json'] !== undefined ? response.examples['application/json'] : Object.values(response.examples)[0];
    if (v !== undefined) return v;
  }
  const schema = h.deref(response.schema);
  return schema && schema.example !== undefined ? schema.example : undefined;
}
function messageOf(body) {
  if (!body || typeof body !== 'object') return null;
  for (const p of MESSAGE_PATHS) {
    const v = p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), body);
    if (typeof v === 'string' && v) return { path: p, text: v };
  }
  return null;
}
function autoIdFor(need) {
  if (need.type === 'integer' || need.type === 'number') return AUTO_IDS.integer;
  if (need.format === 'uuid') return AUTO_IDS.uuid;
  return AUTO_IDS.string;
}

// selection: operation ids ("GET /path"); values: {param: {value, source}} (source ui |
// project | manual | placeholder); opts: {name, capturedToken?: {scheme, headerName?}}.
function generate(model, selection, values, opts) {
  const name = slug(opts.name);
  const envPrefix = envPrefixFor(name);
  const specReview = [];
  const baseUrlLiteral = baseUrlFor(model, specReview);
  const baseUrlVar = `${envPrefix}_BASE_URL`;
  let auth = authFor(model, envPrefix, specReview);
  const cap = opts.capturedToken;
  if ((auth.type === 'none' || auth.type === 'basic') && cap && (cap.scheme === 'bearer' || cap.scheme === 'apiKey')) {
    auth = cap.scheme === 'bearer' ? { type: 'bearer', tokenEnv: `${envPrefix}_TOKEN` } : { type: 'apiKey', headerName: cap.headerName || 'X-API-Key', tokenEnv: `${envPrefix}_TOKEN` };
  }
  if (auth.type === 'bearer' || auth.type === 'apiKey') auth = { ...auth, tokenStore: name };

  const { ops, h } = walkOperations(model, specReview);
  const wanted = new Set(selection || []);
  const chosen = ops.filter(o => wanted.has(o.id));
  const vals = values || {};
  const requests = [];
  const cases = [];
  const endpoints = [];
  for (const o of chosen) {
    const responses = o.op.responses || {};
    const reqReview = [];
    const query = o.needs.filter(n => n.in === 'query').map(n => n.param);
    const bodyNeeds = o.needs.filter(n => n.in === 'body');
    let body;
    if (bodyNeeds.length) {
      body = {};
      for (const n of bodyNeeds) body[n.field] = { $param: n.param, type: n.type };
      reqReview.push('request body holds the spec\'s required top-level fields only — add optional fields by hand if the call needs them');
    }
    requests.push({
      name: o.request, description: o.summary || undefined, method: o.method, path: o.path,
      params: o.needs.map(n => n.param),
      ...(query.length ? { query } : {}),
      ...(body ? { body } : {}),
      ...(reqReview.length ? { review: reqReview } : {}),
    });
    const entry = `${name}.${o.request}`;
    const skip = o.write ? { skip: WRITE_SKIP } : {};
    // The catalog's auth applies to every request in it; a public operation's cases are sent
    // without a credential, as the spec describes it (and never BLOCKED on a missing token).
    const publicAuth = o.auth === 'public' && auth.type !== 'none' ? { auth: 'none' } : {};
    const baseParams = {}, baseSources = {};
    for (const n of o.needs) {
      const v = vals[n.param];
      if (v && v.value !== undefined && v.value !== null && v.value !== '' && v.source && v.source !== 'placeholder') {
        baseParams[n.param] = v.value; baseSources[n.param] = v.source;
      } else {
        baseParams[n.param] = v && v.value !== undefined && v.value !== null && v.value !== '' ? v.value : h.exampleFor(n.schema).value;
        baseSources[n.param] = 'placeholder';
      }
    }
    const opCases = [];
    const add = c => { opCases.push(c); cases.push(c); };

    // happy
    const okCode = h.firstCode(responses, c => c >= 200 && c < 300);
    const okSchema = okCode && h.responseSchema(responses, okCode);
    const happyExpect = { status: okCode ? parseInt(okCode, 10) : 200 };
    const happyReview = [];
    if (!okCode) happyReview.push('no 2xx response is documented — expect.status 200 is a guess; set the real success status');
    if (okSchema && okSchema.type !== 'array' && okSchema.properties && Array.isArray(okSchema.required)) {
      const fields = okSchema.required.filter(k => k in okSchema.properties);
      if (fields.length) happyExpect.fields = fields;
    }
    add({ name: `${o.request}-happy`, entry, kind: 'happy', ...publicAuth, ...skip, params: { ...baseParams }, sources: { ...baseSources }, expect: happyExpect, ...(happyReview.length ? { review: happyReview } : {}) });

    // not-found: an ID in the path (the last path param)
    const pathNeeds = o.needs.filter(n => n.in === 'path');
    if (pathNeeds.length) {
      const idNeed = pathNeeds[pathNeeds.length - 1];
      const msg = messageOf(exampleBody(model, h, responses['404']));
      const expect = { status: 404, ...(msg ? { equals: { [msg.path]: msg.text } } : {}) };
      add({ name: `${o.request}-not-found`, entry, kind: 'not-found', ...publicAuth, ...skip,
        params: { ...baseParams, [idNeed.param]: autoIdFor(idNeed) }, sources: { ...baseSources, [idNeed.param]: 'auto' }, expect,
        ...(msg ? {} : { review: ['no documented 404 message — the case checks the status only; add the expected message if the service documents one'] }) });
    }
    // no-token
    if (o.auth === 'token') {
      add({ name: `${o.request}-no-token`, entry, kind: 'no-token', auth: 'none', ...skip, params: { ...baseParams }, sources: { ...baseSources }, expect: { status: 401 } });
    }
    // missing-field: first required query param, else first required body field
    const missing = o.needs.find(n => n.in === 'query') || o.needs.find(n => n.in === 'body');
    if (missing) {
      const msg = messageOf(exampleBody(model, h, responses['400']));
      const expect = { status: 400, ...(msg ? { contains: { [msg.path]: msg.text } } : {}) };
      add({ name: `${o.request}-missing-${slug(missing.field || missing.param)}`, entry, kind: 'missing-field', ...publicAuth, ...skip,
        params: { ...baseParams }, sources: { ...baseSources }, omit: [missing.param], expect,
        ...(msg ? {} : { review: ['no documented 400 message — the case checks the status only; add the expected message if the service documents one'] }) });
    }
    endpoints.push({ id: o.id, method: o.method, path: o.path, request: o.request, write: o.write, destructive: o.destructive, auth: o.auth,
      cases: opCases.map(c => ({ name: c.name, kind: c.kind, status: c.expect.status, skipped: !!c.skip, needsReview: needsReview(c) })) });
  }

  const catalog = { name, description: (model.doc.info && model.doc.info.description) || `Imported from ${model.source}`, target: 'catalog', baseUrl: `\${${baseUrlVar}}`, auth, requests };
  const suite = { name: `${name}-suite`, cases };
  const byKind = { happy: 0, 'not-found': 0, 'no-token': 0, 'missing-field': 0 };
  let ready = 0, review = 0, skipped = 0;
  for (const c of cases) {
    byKind[c.kind]++;
    if (c.skip) skipped++; else if (needsReview(c)) review++; else ready++;
  }
  // Values per source: each distinct (param, value) a case sends, counted once.
  const bySource = { ui: 0, project: 0, auto: 0, placeholder: 0, manual: 0 };
  const seen = new Set();
  for (const c of cases) {
    for (const [p, src] of Object.entries(c.sources || {})) {
      if ((c.omit || []).includes(p)) continue;
      const key = `${p}\u0000${JSON.stringify(c.params[p])}\u0000${src}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (src in bySource) bySource[src]++;
    }
  }
  return {
    catalog, suite,
    summary: { total: cases.length, ready, review, skipped, byKind, bySource, endpoints, baseUrlVar, baseUrlLiteral,
      tokenVar: auth.tokenEnv || `${envPrefix}_TOKEN`, specReview },
  };
}
function needsReview(c) {
  return Object.entries(c.sources || {}).some(([p, s]) => s === 'placeholder' && !(c.omit || []).includes(p));
}

module.exports = {
  SpecError, slug, envPrefixFor, WRITE_SKIP, AUTO_IDS, MESSAGE_PATHS, DESTRUCTIVE_VERBS,
  loadSpec, parseSpec, listOperations, generate, generateLegacy, messageOf, needsReview,
  baseUrlOf: model => baseUrlFor(model, []),
};
