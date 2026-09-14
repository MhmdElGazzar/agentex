#!/usr/bin/env node
// bug-report.js — the agent-facing boundary for one Azure bug filing.
//
// The caller supplies semantic intent. This script resolves configuration and
// runtime metadata, normalizes the configured template, delegates all bug
// mechanics to create-bug.js, delegates test-case mechanics to testplan.js,
// and returns only decision data / semantic effects. REST routes, JSON Patch,
// field references, auth, and test-run plumbing stay behind their owners.
//
// Commands:
//   context [--parent <story-id>] [--emit-intent] [--intent <intent.json>] [--duplicate-view all] [--refresh-fields]
//   prepare --intent <intent.json> --duplicate-review <review-id> --plan <plan.json> [--refresh-fields]
//   execute --plan <plan.json>
//
// `prepare` performs reads and validation only, then writes a local integrity-
// checked plan artifact. `execute` accepts only that artifact. User approval is
// still a conversation policy, but the artifact makes the approved plan and
// executed inputs the same data instead of relying on the model to reconstruct
// flags, fields, routes, or a new bug id.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TRACKER_LIB = path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'tracker');
const { resolveTracker, TrackerError } = require(path.join(TRACKER_LIB, 'index.js'));
const fieldCache = require(path.join(TRACKER_LIB, 'cache.js'));
const createBug = require('./create-bug.js');
const { checkFiles } = require('./check-image.js');
const {
  rankDuplicateCandidates,
  projectShortlist,
  rankingIntentSnapshot,
  RANKING_FIELDS,
  RANKING_STRATEGY,
  DEFAULT_SHORTLIST_SIZE,
} = require('./duplicate-ranking.js');
const testplan = require(path.join(__dirname, '..', '..', 'test-design', 'scripts', 'testplan.js'));

const ARTIFACT_KIND = 'agentex.azure-bug-plan';
const ARTIFACT_VERSION = 1;
const DUPLICATE_REVIEW_KIND = 'agentex.azure-bug-duplicate-review';
const DUPLICATE_REVIEW_VERSION = 1;
const CHILD_LINK = 'System.LinkTypes.Hierarchy-Forward';
const FIELD_REFS = createBug.FIELD_REFS;
const DUPLICATE_CANDIDATE_FIELDS = Object.freeze([
  'System.Id',
  FIELD_REFS.workItemType,
  FIELD_REFS.title,
  FIELD_REFS.state,
  FIELD_REFS.reproSteps,
]);
const DUPLICATE_FALLBACK_CONCURRENCY = 8;

const FIELD_NAMES = Object.freeze({
  [FIELD_REFS.workItemType]: 'work item type',
  [FIELD_REFS.title]: 'title',
  [FIELD_REFS.state]: 'state',
  [FIELD_REFS.areaPath]: 'area',
  [FIELD_REFS.iterationPath]: 'iteration',
  [FIELD_REFS.assignedTo]: 'assignee',
  [FIELD_REFS.priority]: 'priority',
  [FIELD_REFS.severity]: 'severity',
  [FIELD_REFS.valueArea]: 'value area',
  [FIELD_REFS.environment]: 'environment',
  [FIELD_REFS.bugCategory]: 'bug category',
  [FIELD_REFS.reproSteps]: 'reproduction details',
});

const OPERATION_NAMES = Object.freeze({
  getWorkItem: 'work-item lookup',
  getWorkItemsBatch: 'batch work-item lookup',
  listFields: 'field metadata lookup',
  findByTitle: 'duplicate check',
  query: 'duplicate search',
  createWorkItem: 'work-item creation',
  updateWorkItem: 'work-item update',
  uploadAttachment: 'evidence upload',
  listSuites: 'test-suite lookup',
  listSuiteCases: 'test-case lookup',
  getPoint: 'test-point lookup',
  createRun: 'test-run creation',
  listRunResults: 'test-result lookup',
  updateRunResults: 'test-result update',
  updateRun: 'test-run update',
  addCaseToSuite: 'test-suite update',
});

const AGENT_REQUIRED = new Set([
  FIELD_REFS.title,
  FIELD_REFS.assignedTo,
  FIELD_REFS.priority,
  FIELD_REFS.severity,
  FIELD_REFS.environment,
  FIELD_REFS.bugCategory,
  FIELD_REFS.reproSteps,
]);

const AUTOMATIC_FIELDS = new Set([
  FIELD_REFS.workItemType,
  FIELD_REFS.areaPath,
  FIELD_REFS.iterationPath,
  FIELD_REFS.valueArea,
]);

const RAW_INTENT_CONTRACT = (() => {
  const requiredScalars = Object.freeze({
    title: 'title',
    summary: 'summary',
    expected: 'expected',
    actual: 'actual',
    severity: 'severity',
    priority: 'priority',
    classificationReason: 'classificationReason',
  });
  const structural = Object.freeze({
    steps: 'steps',
    parentStoryId: 'parentStoryId',
  });
  const runtimeDefaultable = Object.freeze({
    assignedTo: 'assignedTo',
    environment: 'environment',
    bugCategory: 'bugCategory',
    valueArea: 'valueArea',
  });
  const optionalScalars = Object.freeze({
    testConfiguration: 'testConfiguration',
    observedAt: 'observedAt',
  });
  const fields = Object.freeze({
    ...requiredScalars,
    ...structural,
    ...runtimeDefaultable,
    ...optionalScalars,
  });
  const evidenceFields = Object.freeze({
    attach: 'attach',
    reject: 'reject',
    waiveScreenshots: 'waiveScreenshots',
    allowInvalid: 'allowInvalid',
  });
  const rejectEntryFields = Object.freeze({ file: 'file', reason: 'reason' });
  const duplicateFields = Object.freeze({ allow: 'allow' });
  const testCaseFields = Object.freeze({
    action: 'action',
    planId: 'planId',
    testCaseId: 'testCaseId',
    comment: 'comment',
    runName: 'runName',
    suiteId: 'suiteId',
    title: fields.title,
    allowDuplicate: 'allowDuplicate',
  });
  const testCaseActions = Object.freeze({
    skip: 'skip',
    failExisting: 'fail-existing',
    createNew: 'create-new',
  });
  const scaffold = Object.freeze({
    nulls: Object.freeze([
      ...Object.values(requiredScalars),
      structural.parentStoryId,
      ...Object.values(runtimeDefaultable),
      ...Object.values(optionalScalars),
    ]),
    arrays: Object.freeze([structural.steps]),
    falseFlags: Object.freeze([]),
  });
  const evidenceScaffold = Object.freeze({
    nulls: Object.freeze([]),
    arrays: Object.freeze([evidenceFields.attach, evidenceFields.reject]),
    falseFlags: Object.freeze([evidenceFields.waiveScreenshots, evidenceFields.allowInvalid]),
  });
  const duplicateScaffold = Object.freeze({
    nulls: Object.freeze([]),
    arrays: Object.freeze([]),
    falseFlags: Object.freeze([duplicateFields.allow]),
  });
  const testCaseScaffold = Object.freeze({
    nulls: Object.freeze([
      testCaseFields.action,
      testCaseFields.planId,
      testCaseFields.testCaseId,
      testCaseFields.comment,
      testCaseFields.runName,
      testCaseFields.suiteId,
      testCaseFields.title,
    ]),
    arrays: Object.freeze([]),
    falseFlags: Object.freeze([testCaseFields.allowDuplicate]),
  });
  const testCaseBranches = Object.freeze({
    [testCaseActions.failExisting]: Object.freeze({
      requiredIds: Object.freeze([testCaseFields.testCaseId]),
      optionalText: Object.freeze([testCaseFields.comment, testCaseFields.runName]),
    }),
    [testCaseActions.createNew]: Object.freeze({
      requiredIds: Object.freeze([testCaseFields.suiteId]),
      requiredText: Object.freeze([testCaseFields.title]),
      falseFlags: Object.freeze([testCaseFields.allowDuplicate]),
    }),
  });
  return Object.freeze({
    fields,
    requiredScalars: Object.freeze(Object.values(requiredScalars)),
    scaffold,
    evidence: Object.freeze({
      field: 'evidence', fields: evidenceFields, rejectEntryFields, scaffold: evidenceScaffold,
    }),
    duplicate: Object.freeze({ field: 'duplicate', fields: duplicateFields, scaffold: duplicateScaffold }),
    testCase: Object.freeze({
      field: 'testCase',
      fields: testCaseFields,
      actions: testCaseActions,
      scaffold: testCaseScaffold,
      common: Object.freeze({ requiredIds: Object.freeze([testCaseFields.planId]) }),
      branches: testCaseBranches,
      aliases: Object.freeze({
        none: testCaseActions.skip,
        [testCaseActions.skip]: testCaseActions.skip,
        [testCaseActions.failExisting]: testCaseActions.failExisting,
        [testCaseActions.createNew]: testCaseActions.createNew,
      }),
    }),
  });
})();

function buildScaffoldSection(scaffold) {
  const section = {};
  for (const field of scaffold.nulls) section[field] = null;
  for (const field of scaffold.arrays) section[field] = [];
  for (const field of scaffold.falseFlags) section[field] = false;
  return section;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[arg.slice(2)] = true;
      else { out[arg.slice(2)] = next; i++; }
    }
  }
  return out;
}

function nonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function positiveId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function scalar(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') {
    return value.uniqueName || value.mailAddress || value.displayName || value.name || null;
  }
  return value;
}

function fieldName(ref) {
  if (FIELD_NAMES[ref]) return FIELD_NAMES[ref];
  const tail = String(ref).split('.').pop();
  return tail.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function safeAgentText(value, fallback = 'operation failed') {
  let message = nonEmpty(value) ? String(value) : fallback;
  for (const [ref, name] of Object.entries(FIELD_NAMES)) message = message.split(ref).join(name);
  for (const [operation, name] of Object.entries(OPERATION_NAMES)) message = message.split(operation).join(name);
  return message
    .replace(/https?:\/\/[^\s)'"<>]+/gi, '[Azure request]')
    .replace(/\b_apis\/[^\s)'"<>]+/gi, 'Azure request')
    .replace(/\s*\(\[Azure request\]\)/g, '')
    .replace(/\b(?:System|Custom|Microsoft\.VSTS)(?:\.[A-Za-z0-9_-]+)+\b/g, 'project field')
    .replace(/\bjson[- ]?patch\b/gi, 'field update');
}

function operationName(value) {
  return OPERATION_NAMES[value] || safeAgentText(value || 'Azure operation');
}

function safeFailureMessage(error) {
  if (!error) return 'operation failed without a result';
  if (nonEmpty(error.serverMessage)) return safeAgentText(error.serverMessage);
  const operation = error.op || error.operation;
  if (operation) return `${operationName(operation)} failed${error.status ? ` (HTTP ${error.status})` : ''}`;
  return safeAgentText(error.message);
}

function agentUrl(value) {
  if (!nonEmpty(value) || /\/_apis(?:\/|\?|$)/i.test(String(value))) return null;
  return String(value);
}

function semanticCreated(value) {
  if (Array.isArray(value)) return value.map(semanticCreated);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'url' && !agentUrl(item)) continue;
    result[key] = semanticCreated(item);
  }
  return result;
}

function workItemUrl(wi) {
  return wi && wi._links && wi._links.html && wi._links.html.href
    ? wi._links.html.href
    : null;
}

function workItemSummary(wi, fallbackId) {
  const fields = (wi && wi.fields) || {};
  return {
    id: (wi && wi.id) || positiveId(fallbackId) || fallbackId,
    type: fields[FIELD_REFS.workItemType] || null,
    title: fields[FIELD_REFS.title] || null,
    state: fields[FIELD_REFS.state] || null,
    ...(workItemUrl(wi) ? { url: workItemUrl(wi) } : {}),
  };
}

function templateDefaults(fields) {
  const pick = (name) => scalar(fields && fields[FIELD_REFS[name]]);
  return {
    ...(nonEmpty(pick('environment')) ? { environment: pick('environment') } : {}),
    ...(nonEmpty(pick('bugCategory')) ? { bugCategory: pick('bugCategory') } : {}),
    ...(nonEmpty(pick('valueArea')) ? { valueArea: pick('valueArea') } : {}),
  };
}

function allowed(fieldMap, ref) {
  const meta = fieldMap[ref];
  return meta && Array.isArray(meta.allowedValues) ? [...meta.allowedValues] : [];
}

function publicContext(runtime) {
  const cfg = runtime.adapter.config;
  const assignedToChoices = [...cfg.assignees];
  const mergedDefaults = {
    ...(cfg.assignees.length === 1 ? { assignedTo: cfg.assignees[0] } : {}),
    ...(cfg.environment || runtime.templateDefaults.environment
      ? { environment: cfg.environment || runtime.templateDefaults.environment }
      : {}),
    ...(cfg.bugCategory || runtime.templateDefaults.bugCategory
      ? { bugCategory: cfg.bugCategory || runtime.templateDefaults.bugCategory }
      : {}),
    ...(cfg.valueArea || runtime.templateDefaults.valueArea
      ? { valueArea: cfg.valueArea || runtime.templateDefaults.valueArea }
      : {}),
  };

  const requiredRefs = Object.entries(runtime.fieldMap)
    .filter(([, meta]) => meta && meta.required)
    .map(([ref]) => ref);
  const agentRequired = requiredRefs.filter((ref) => AGENT_REQUIRED.has(ref)).map(fieldName);
  const automatic = requiredRefs.filter((ref) => AUTOMATIC_FIELDS.has(ref)).map(fieldName);
  const unsupported = requiredRefs
    .filter((ref) => !AGENT_REQUIRED.has(ref) && !AUTOMATIC_FIELDS.has(ref))
    .map(fieldName);

  return {
    template: runtime.template,
    ...(runtime.parent ? { parent: runtime.parent } : {}),
    defaults: mergedDefaults,
    choices: {
      assignedTo: assignedToChoices,
      severity: allowed(runtime.fieldMap, FIELD_REFS.severity),
      priority: allowed(runtime.fieldMap, FIELD_REFS.priority),
      environment: allowed(runtime.fieldMap, FIELD_REFS.environment),
      bugCategory: allowed(runtime.fieldMap, FIELD_REFS.bugCategory),
    },
    requiredInputs: {
      assignedTo: {
        required: true,
        resolved: nonEmpty(mergedDefaults.assignedTo),
        needsUserInput: !nonEmpty(mergedDefaults.assignedTo),
        choices: [...assignedToChoices],
      },
    },
    supported: {
      environment: Boolean(runtime.fieldMap[FIELD_REFS.environment]),
      bugCategory: Boolean(runtime.fieldMap[FIELD_REFS.bugCategory]),
      valueArea: Boolean(runtime.fieldMap[FIELD_REFS.valueArea]),
    },
    processRequirements: {
      agentSupplied: agentRequired,
      automatic,
      unsupported,
    },
    testPlan: cfg.testPlanId ? { configured: true, id: cfg.testPlanId } : { configured: false },
    metadata: { refreshed: runtime.cacheInfo.rebuilt, builtAt: runtime.cacheInfo.cache.builtAt },
  };
}

function buildIntentTemplate(runtime) {
  const contract = RAW_INTENT_CONTRACT;
  const fields = contract.fields;
  const parentStoryId = runtime && runtime.parent && runtime.parent.type === 'User Story'
    ? positiveId(runtime.parent.id)
    : null;
  const template = buildScaffoldSection(contract.scaffold);
  template[fields.parentStoryId] = parentStoryId;
  template[contract.evidence.field] = buildScaffoldSection(contract.evidence.scaffold);
  template[contract.duplicate.field] = buildScaffoldSection(contract.duplicate.scaffold);
  template[contract.testCase.field] = buildScaffoldSection(contract.testCase.scaffold);
  return template;
}

function duplicateReviewInputBlocks(intent) {
  const blocked = [];
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    return [{ reason: 'invalid-input', message: 'intent must be a JSON object' }];
  }
  for (const field of RANKING_FIELDS) {
    if (field === RAW_INTENT_CONTRACT.fields.steps) {
      if (!Array.isArray(intent[field]) || intent[field].length === 0 || intent[field].some((step) => !nonEmpty(step))) {
        missing(blocked, field, `${field} must be a non-empty array of meaningful reproduction steps`);
      }
    } else if (!nonEmpty(intent[field])) {
      missing(blocked, field, `${field} is required before duplicate review`);
    }
  }
  if (!positiveId(intent[RAW_INTENT_CONTRACT.fields.parentStoryId])) {
    missing(blocked, RAW_INTENT_CONTRACT.fields.parentStoryId, 'a valid parent User Story id is required before duplicate review');
  }
  return blocked;
}

function canonicalDuplicateCandidate(candidate) {
  return {
    id: positiveId(candidate && candidate.id) || (candidate && candidate.id) || null,
    type: candidate && candidate.type || null,
    title: candidate && candidate.title || null,
    state: candidate && candidate.state || null,
    url: candidate && candidate.url || null,
    reproductionSummary: candidate && candidate.reproductionSummary || null,
    detailsUnavailable: candidate && candidate.detailsUnavailable || null,
  };
}

function compareCandidateIds(left, right) {
  const leftId = positiveId(left && left.id);
  const rightId = positiveId(right && right.id);
  if (leftId && rightId && leftId !== rightId) return leftId - rightId;
  const leftText = String(left && left.id || '');
  const rightText = String(right && right.id || '');
  return leftText === rightText ? 0 : (leftText < rightText ? -1 : 1);
}

function duplicateReviewDigest(runtime, intent, shortlistCandidateIds) {
  const candidates = (runtime.duplicateCandidates || [])
    .map(canonicalDuplicateCandidate)
    .sort(compareCandidateIds);
  return artifactDigest({
    kind: DUPLICATE_REVIEW_KIND,
    schemaVersion: DUPLICATE_REVIEW_VERSION,
    trackerKey: trackerKey(runtime.adapter),
    parent: runtime.parent ? {
      id: runtime.parent.id,
      type: runtime.parent.type,
      title: runtime.parent.title,
      state: runtime.parent.state,
    } : null,
    rankingVersion: RANKING_STRATEGY,
    rankingIntent: rankingIntentSnapshot(intent),
    candidates,
    shortlistCandidateIds,
  });
}

function buildDuplicateReview(runtime, intent, { view = 'shortlist' } = {}) {
  const ranking = rankDuplicateCandidates(intent, runtime.duplicateCandidates || []);
  const shortlist = projectShortlist(ranking, DEFAULT_SHORTLIST_SIZE);
  const shortlistCandidateIds = shortlist.candidates.map((candidate) => candidate.id);
  const allCandidates = ranking.ranked.map((entry) => ({ ...entry.candidate }));
  const selected = view === 'all' ? allCandidates : shortlist.candidates;
  const reviewId = duplicateReviewDigest(runtime, intent, shortlistCandidateIds);
  return {
    duplicateCandidates: selected,
    duplicateReview: {
      reviewId,
      strategy: RANKING_STRATEGY,
      view,
      defaultShortlistSize: DEFAULT_SHORTLIST_SIZE,
      totalCandidates: allCandidates.length,
      shownCandidates: selected.length,
      omittedCandidateCount: Math.max(0, allCandidates.length - selected.length),
      truncated: selected.length < allCandidates.length,
      pinnedExactTitleCount: shortlist.pinnedExactTitleCount,
      shortlistCandidateIds,
      lowSignal: Boolean(ranking.diagnostics && ranking.diagnostics.lowSignal),
    },
  };
}

function pendingDuplicateReview(runtime) {
  const totalCandidates = (runtime.duplicateCandidates || []).length;
  return {
    status: 'intent-required',
    strategy: RANKING_STRATEGY,
    view: 'shortlist',
    defaultShortlistSize: DEFAULT_SHORTLIST_SIZE,
    totalCandidates,
    shownCandidates: 0,
    omittedCandidateCount: totalCandidates,
    truncated: totalCandidates > 0,
    pinnedExactTitleCount: 0,
    shortlistCandidateIds: [],
  };
}

function compactDuplicateReview(review) {
  return {
    reviewId: review.reviewId,
    strategy: review.strategy,
    defaultShortlistSize: review.defaultShortlistSize,
    totalCandidates: review.totalCandidates,
    pinnedExactTitleCount: review.pinnedExactTitleCount,
    shortlistCandidateIds: [...review.shortlistCandidateIds],
  };
}

async function loadRuntime(cwd, fetch, { parentStoryId, refreshFields = false } = {}) {
  const adapter = resolveTracker(cwd, { fetch });
  const cacheInfo = await fieldCache.ensure(cwd, adapter, { types: ['Bug'], refresh: refreshFields });
  const fieldMap = (cacheInfo.cache.types.Bug && cacheInfo.cache.types.Bug.fields) || {};
  const blocked = [];

  let template = { configured: false };
  let templateFields = {};
  if (adapter.config.templateBugId) {
    const id = positiveId(adapter.config.templateBugId);
    if (!id) {
      blocked.push({
        reason: 'invalid-template',
        message: 'the configured bug template id is not a positive integer',
      });
    } else {
      try {
        const wi = await adapter.getWorkItem(id, { expand: 'all' });
        templateFields = (wi && wi.fields) || {};
        template = { configured: true, ...workItemSummary(wi, id) };
        if (template.type !== 'Bug') {
          blocked.push({
            reason: 'template-not-a-bug',
            message: `configured template #${id} is a ${JSON.stringify(template.type || 'unknown type')}, not a Bug`,
          });
        }
      } catch (e) {
        blocked.push({
          reason: 'template-unavailable',
          message: `configured bug template #${id} could not be read: ${safeFailureMessage(e)}`,
        });
        template = { configured: true, id, unavailable: true };
      }
    }
  }

  let parent = null;
  let parentFields = {};
  let parentWorkItem = null;
  let parentCandidates = [];
  if (parentStoryId !== undefined && parentStoryId !== null && parentStoryId !== '') {
    const id = positiveId(parentStoryId);
    if (!id) {
      blocked.push({ reason: 'invalid-parent', message: 'parent story id must be a positive integer' });
    } else {
      try {
        const wi = await adapter.getWorkItem(id, { expand: 'all' });
        parentWorkItem = wi;
        parentFields = (wi && wi.fields) || {};
        parent = workItemSummary(wi, id);
        if (parent.type !== 'User Story') {
          blocked.push({
            reason: 'parent-not-a-user-story',
            message: `parent #${id} is a ${JSON.stringify(parent.type || 'unknown type')}, not a User Story`,
          });
        }
      } catch (e) {
        blocked.push({
          reason: 'parent-unavailable',
          message: `parent story #${id} could not be read: ${safeFailureMessage(e)}`,
        });
      }
      if (parent && parent.type === 'User Story') {
        try {
          parentCandidates = await parentBugCandidates(adapter, parentWorkItem);
        } catch (e) {
          blocked.push({
            reason: 'dup-check-failed',
            message: `parent-scoped duplicate check failed — refusing to file blind (fails closed): ${safeFailureMessage(e)}`,
          });
        }
      }
    }
  }

  return {
    adapter, cacheInfo, fieldMap, blocked, template, templateFields,
    templateDefaults: templateDefaults(templateFields), parent, parentFields,
    duplicateCandidates: parentCandidates,
  };
}

function missing(blocked, field, message, extra = {}) {
  blocked.push({ reason: 'missing-input', field, message, ...extra });
}

function normalizeEvidence(intent, blocked, cwd) {
  const contract = RAW_INTENT_CONTRACT.evidence;
  const entryFields = contract.rejectEntryFields;
  const [attachField, rejectField] = contract.scaffold.arrays;
  const [waiveScreenshotsField, allowInvalidField] = contract.scaffold.falseFlags;
  const evidence = intent[contract.field] || {};
  const attach = evidence[attachField] === undefined ? [] : evidence[attachField];
  const reject = evidence[rejectField] === undefined ? [] : evidence[rejectField];
  const attachPath = `${contract.field}.${attachField}`;
  const rejectPath = `${contract.field}.${rejectField}`;
  if (!Array.isArray(attach)) {
    blocked.push({ reason: 'invalid-input', field: attachPath, message: `${attachPath} must be an array of image paths` });
  } else {
    attach.forEach((file, index) => {
      if (!nonEmpty(file)) {
        blocked.push({ reason: 'invalid-input', field: `${attachPath}[${index}]`, message: 'each attached image needs a path' });
      }
    });
  }
  if (!Array.isArray(reject)) {
    blocked.push({ reason: 'invalid-input', field: rejectPath, message: `${rejectPath} must be an array` });
  }
  const normalizedReject = Array.isArray(reject) ? reject.map((entry) => {
    if (typeof entry === 'string') {
      return { [entryFields.file]: entry, [entryFields.reason]: 'not relevant to this defect' };
    }
    return {
      [entryFields.file]: entry && entry[entryFields.file],
      [entryFields.reason]: entry && entry[entryFields.reason],
    };
  }) : [];
  normalizedReject.forEach((entry, index) => {
    if (!nonEmpty(entry[entryFields.file]) || !nonEmpty(entry[entryFields.reason])) {
      blocked.push({
        reason: 'invalid-input', field: `${rejectPath}[${index}]`,
        message: 'each rejected image needs a file and a relevance reason',
      });
    }
  });
  const normalizedAttach = Array.isArray(attach)
    ? attach.map((file) => path.resolve(cwd, String(file)))
    : [];
  const comparable = (file) => process.platform === 'win32' ? file.toLowerCase() : file;
  const attached = new Set(normalizedAttach.map(comparable));
  normalizedReject.forEach((entry, index) => {
    if (!nonEmpty(entry[entryFields.file])) return;
    const rejected = comparable(path.resolve(cwd, String(entry[entryFields.file])));
    if (attached.has(rejected)) {
      blocked.push({
        reason: 'evidence-conflict', field: `${rejectPath}[${index}].${entryFields.file}`,
        message: `${entry[entryFields.file]} cannot be both attached and rejected; choose one evidence decision`,
      });
    }
  });
  return {
    attach: normalizedAttach,
    reject: normalizedReject,
    waiveScreenshots: evidence[waiveScreenshotsField] === true,
    allowInvalid: evidence[allowInvalidField] === true,
  };
}

function normalizeTestAction(intent, cfg, blocked) {
  const contract = RAW_INTENT_CONTRACT.testCase;
  const fields = contract.fields;
  const actions = contract.actions;
  const [planIdField] = contract.common.requiredIds;
  const raw = intent[contract.field] || {};
  const action = contract.aliases[raw[fields.action]];
  if (!action) {
    missing(blocked, `${contract.field}.${fields.action}`, 'choose skip, fail-existing, or create-new; this action is never inferred');
    return { action: null };
  }
  if (action === actions.skip) return { action };

  const planId = positiveId(raw[planIdField] || cfg.testPlanId);
  if (!planId) missing(blocked, `${contract.field}.${planIdField}`, 'the chosen test-case action needs a configured or explicit test plan id');
  if (action === actions.failExisting) {
    const branch = contract.branches[actions.failExisting];
    const [testCaseIdField] = branch.requiredIds;
    const [commentField, runNameField] = branch.optionalText;
    const testCaseId = positiveId(raw[testCaseIdField]);
    if (!testCaseId) missing(blocked, `${contract.field}.${testCaseIdField}`, 'fail-existing needs the existing Test Case id');
    return {
      action, planId, testCaseId,
      ...(nonEmpty(raw[commentField]) ? { comment: String(raw[commentField]) } : {}),
      ...(nonEmpty(raw[runNameField]) ? { runName: String(raw[runNameField]) } : {}),
    };
  }

  const branch = contract.branches[actions.createNew];
  const [suiteIdField] = branch.requiredIds;
  const [titleField] = branch.requiredText;
  const [allowDuplicateField] = branch.falseFlags;
  const suiteId = positiveId(raw[suiteIdField]);
  if (!suiteId) missing(blocked, `${contract.field}.${suiteIdField}`, 'create-new needs the destination suite id');
  if (!nonEmpty(raw[titleField])) missing(blocked, `${contract.field}.${titleField}`, 'create-new needs a Test Case title');
  return {
    action, planId, suiteId,
    title: nonEmpty(raw[titleField]) ? String(raw[titleField]).trim() : null,
    allowDuplicate: raw[allowDuplicateField] === true,
  };
}

function normalizeIntent(intent, runtime) {
  const blocked = [];
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    return { blocked: [{ reason: 'invalid-input', message: 'intent must be a JSON object' }] };
  }

  const fields = RAW_INTENT_CONTRACT.fields;
  for (const key of RAW_INTENT_CONTRACT.requiredScalars) {
    if (!nonEmpty(intent[key])) missing(blocked, key, `${key} is required`);
  }
  if (!Array.isArray(intent[fields.steps]) || intent[fields.steps].length === 0 || intent[fields.steps].some((s) => !nonEmpty(s))) {
    missing(blocked, fields.steps, `${fields.steps} must be a non-empty array of meaningful reproduction steps`);
  }
  const parentStoryId = positiveId(intent[fields.parentStoryId]);
  if (!parentStoryId) missing(blocked, fields.parentStoryId, 'a valid parent User Story id is required and is never inferred');

  const cfg = runtime.adapter.config;
  const assignedTo = nonEmpty(intent[fields.assignedTo])
    ? String(intent[fields.assignedTo]).trim()
    : (cfg.assignees.length === 1 ? cfg.assignees[0] : null);
  if (!assignedTo) {
    missing(blocked, fields.assignedTo, 'choose an assignee; no assignee is inferred',
      cfg.assignees.length ? { options: [...cfg.assignees] } : {});
  }

  const evidence = normalizeEvidence(intent, blocked, runtime.adapter.cwd);
  const testCase = normalizeTestAction(intent, cfg, blocked);
  const defaults = runtime.templateDefaults;
  const environment = nonEmpty(intent[fields.environment]) ? intent[fields.environment] : (cfg.environment || defaults.environment || null);
  const bugCategory = nonEmpty(intent[fields.bugCategory]) ? intent[fields.bugCategory] : (cfg.bugCategory || defaults.bugCategory || null);
  const valueArea = nonEmpty(intent[fields.valueArea]) ? intent[fields.valueArea] : (cfg.valueArea || defaults.valueArea || null);
  const areaPath = cfg.areaPath || runtime.parentFields[FIELD_REFS.areaPath] || null;
  const iterationPath = cfg.iterationPath || runtime.parentFields[FIELD_REFS.iterationPath] || null;
  const duplicateContract = RAW_INTENT_CONTRACT.duplicate;
  const [allowDuplicateField] = duplicateContract.scaffold.falseFlags;
  const duplicate = intent[duplicateContract.field];

  const bugSpec = {
    title: nonEmpty(intent[fields.title]) ? String(intent[fields.title]).trim() : null,
    severity: intent[fields.severity],
    priority: intent[fields.priority],
    parentStoryId,
    assignedTo,
    summary: intent[fields.summary],
    steps: Array.isArray(intent[fields.steps]) ? intent[fields.steps] : [],
    expected: intent[fields.expected],
    actual: intent[fields.actual],
    ...(environment ? { environment } : {}),
    ...(bugCategory ? { bugCategory } : {}),
    ...(valueArea ? { valueArea } : {}),
    ...(areaPath ? { areaPath } : {}),
    ...(iterationPath ? { iterationPath } : {}),
    ...(nonEmpty(intent[fields.testConfiguration]) ? { testConfig: intent[fields.testConfiguration] } : {}),
    ...(nonEmpty(intent[fields.observedAt]) ? { timestamp: intent[fields.observedAt] } : {}),
    attachments: evidence.attach,
  };
  return {
    blocked,
    bugSpec,
    evidence,
    testCase,
    classificationReason: intent[fields.classificationReason],
    flags: {
      allowDuplicate: Boolean(duplicate && duplicate[allowDuplicateField] === true),
      noScreenshots: evidence.waiveScreenshots,
      force: evidence.allowInvalid,
    },
  };
}

function bugArgs(flags, { execute = false, refreshFields = false } = {}) {
  return [
    ...(execute ? ['--execute'] : []),
    ...(flags.allowDuplicate ? ['--allow-duplicate'] : []),
    ...(flags.noScreenshots ? ['--no-screenshots'] : []),
    ...(flags.force ? ['--force'] : []),
    ...(refreshFields ? ['--refresh-fields'] : []),
  ];
}

function testArgs(action, { execute = false, bugId = '{new-bug-id}', refreshFields = false } = {}) {
  if (!action || action.action === 'skip') return null;
  if (action.action === 'fail-existing') {
    return [
      'fail', '--plan', String(action.planId), '--testcase', String(action.testCaseId), '--bug', String(bugId),
      ...(action.comment ? ['--comment', action.comment] : []),
      ...(action.runName ? ['--run-name', action.runName] : []),
      ...(execute ? ['--execute'] : []),
    ];
  }
  return [
    'create-case', '--plan', String(action.planId), '--suite', String(action.suiteId), '--title', action.title,
    ...(action.allowDuplicate ? ['--allow-duplicate'] : []),
    ...(refreshFields ? ['--refresh-fields'] : []),
    ...(execute ? ['--execute'] : []),
  ];
}

function stripHtml(value) {
  if (!nonEmpty(value)) return null;
  const text = String(value)
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function compactCandidate(wi, fallbackId) {
  const summary = workItemSummary(wi, fallbackId);
  const repro = stripHtml(wi && wi.fields && wi.fields[FIELD_REFS.reproSteps]);
  return { ...summary, ...(repro ? { reproductionSummary: repro } : {}) };
}

function directChildIds(parentWorkItem) {
  const relations = parentWorkItem && parentWorkItem.relations;
  if (relations === undefined || relations === null) return [];
  if (!Array.isArray(relations)) throw new Error('expanded parent returned invalid relations');

  const ids = [];
  const seen = new Set();
  for (const relation of relations) {
    if (!relation || relation.rel !== CHILD_LINK) continue;
    const match = String(relation.url || '').match(/\/(\d+)\/?(?:[?#].*)?$/);
    const id = match && positiveId(match[1]);
    if (!id) throw new Error('parent has a direct child relation without a valid work-item id');
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

async function parentBugCandidates(adapter, parentWorkItem) {
  const ids = directChildIds(parentWorkItem);
  if (!ids.length) return [];

  let workItems;
  if (typeof adapter.getWorkItemsBatch !== 'function') {
    workItems = await getWorkItemsBounded(adapter, ids);
  } else {
    try {
      workItems = await adapter.getWorkItemsBatch(ids, {
        fields: DUPLICATE_CANDIDATE_FIELDS,
        expand: 'links',
      });
      assertBatchCandidateProjection(ids, workItems);
    } catch (error) {
      if (!batchFallbackAllowed(error)) throw error;
      workItems = await getWorkItemsBounded(adapter, ids);
    }
  }

  const results = [];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    const wi = workItems[index];
    const returnedId = positiveId(wi && wi.id);
    const fields = wi && wi.fields;
    const type = fields && fields[FIELD_REFS.workItemType];
    if (!returnedId || returnedId !== id || !nonEmpty(type)) {
      throw new Error(`direct child #${id} returned an invalid work-item response`);
    }
    if (type === 'Bug') results.push(compactCandidate(wi, id));
  }
  return results;
}

function batchFallbackAllowed(error) {
  if (error && error.batchProjectionUnavailable === true) return true;
  if (!(error instanceof TrackerError) || error.op !== 'getWorkItemsBatch') return false;
  if (error.status === 404 || error.status === 405 || error.status === 501) return true;

  const detail = `${error.serverMessage || ''} ${error.body || ''}`;
  if (error.status !== 400) return false;
  const foldedDetail = detail.toLowerCase();
  return DUPLICATE_CANDIDATE_FIELDS.some((field) => foldedDetail.includes(field.toLowerCase())) &&
    /(?:invalid|not found|unavailable|unsupported|not supported|does not exist)/i.test(detail);
}

function assertBatchCandidateProjection(ids, workItems) {
  if (!Array.isArray(workItems) || workItems.length !== ids.length) {
    throw new Error('batch work-item lookup returned an invalid candidate set');
  }
  // ReproSteps may be absent when unset; Azure's batch contract omits such
  // projected values. The other projected system fields exist on every item.
  const requiredFields = DUPLICATE_CANDIDATE_FIELDS
    .filter((field) => field !== FIELD_REFS.reproSteps);
  for (let index = 0; index < ids.length; index++) {
    const item = workItems[index];
    const fields = item && item.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error(`direct child #${ids[index]} returned an invalid batch field projection`);
    }
    const missing = requiredFields.filter((field) =>
      !Object.prototype.hasOwnProperty.call(fields, field));
    if (missing.length) {
      const error = new Error(
        `batch work-item lookup could not return required candidate fields for child #${ids[index]}`,
      );
      error.batchProjectionUnavailable = true;
      throw error;
    }
    if (positiveId(fields['System.Id']) !== ids[index]) {
      throw new Error(`direct child #${ids[index]} returned a mismatched projected work-item id`);
    }
  }
}

async function getWorkItemsBounded(adapter, ids) {
  const results = new Array(ids.length);
  let nextIndex = 0;
  let stopped = false;
  let firstError = null;

  async function worker() {
    while (!stopped) {
      const index = nextIndex++;
      if (index >= ids.length) return;
      try {
        results[index] = await adapter.getWorkItem(ids[index]);
      } catch (error) {
        if (!firstError) firstError = error;
        stopped = true;
      }
    }
  }

  const workerCount = Math.min(DUPLICATE_FALLBACK_CONCURRENCY, ids.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

async function duplicateCandidates(adapter, ids) {
  const results = [];
  for (const id of ids || []) {
    try {
      const wi = await adapter.getWorkItem(id);
      results.push(compactCandidate(wi, id));
    } catch (e) {
      results.push({ id, detailsUnavailable: safeFailureMessage(e) });
    }
  }
  return results;
}

function duplicateIds(out) {
  const ids = out && out.validation && out.validation.duplicates;
  return Array.isArray(ids) ? ids : [];
}

function sanitizeBlock(block) {
  let message = safeAgentText(block.message || block.serverMessage || 'validation blocked the filing');
  if (block.field && block.reason === 'invalid-value') {
    message = `${fieldName(block.field)} value ${JSON.stringify(block.value)} is not allowed; choose one of the returned options`;
  } else if (block.field && block.reason === 'field-not-on-type') {
    message = `this project's Bug type does not support ${fieldName(block.field)}; omit it for this filing`;
  } else if (block.reason === 'server-rejected-create') {
    message = block.serverMessage
      ? `Azure rejected the validated Bug fields: ${safeAgentText(block.serverMessage)}`
      : 'Azure rejected the validated Bug fields; nothing was written';
  }
  const out = {
    reason: block.reason || 'blocked',
    ...(block.field ? { field: fieldName(block.field) } : {}),
    ...(block.value !== undefined ? { value: block.value } : {}),
    ...(Array.isArray(block.allowedValues) ? { options: block.allowedValues } : {}),
    ...(Array.isArray(block.ids) ? { candidateIds: block.ids } : {}),
    ...(block.serverMessage ? { serverMessage: safeAgentText(block.serverMessage) } : {}),
    message,
  };
  if (Array.isArray(block.fields)) {
    out.fields = block.fields.map((f) => ({
      name: fieldName(f.field),
      ...(Array.isArray(f.allowedValues) ? { options: f.allowedValues } : {}),
    }));
  }
  if (Array.isArray(block.files)) out.files = block.files;
  return out;
}

function resultMessage(out) {
  if (!out) return 'operation failed without a result';
  if (Array.isArray(out.blocked) && out.blocked.length) {
    return out.blocked.map((b) => safeAgentText(b.serverMessage || b.message || b.reason)).join('; ');
  }
  return out.error && (out.error.serverMessage || out.error.message)
    ? safeFailureMessage(out.error)
    : 'operation failed';
}

async function publicBlocked(out, adapter, context, evidence, review) {
  const ids = duplicateIds(out);
  const exactTitleCandidates = ids.length ? await duplicateCandidates(adapter, ids) : [];
  return {
    ok: false,
    mode: 'blocked',
    blocked: (out.blocked || [{ reason: 'operation-failed', message: resultMessage(out) }]).map(sanitizeBlock),
    ...(out.cacheStale ? { cacheStale: true } : {}),
    ...(out.validation && out.validation.parent ? { parent: out.validation.parent } : {}),
    ...(exactTitleCandidates.length ? { duplicateCandidates: exactTitleCandidates } : {}),
    ...(review ? { duplicateReview: compactDuplicateReview(review) } : {}),
    ...(evidence ? { evidence } : {}),
    ...(context ? { context } : {}),
    nothingWritten: true,
  };
}

function semanticBugPlan(plan, bugSpec) {
  let upload = 0;
  return (plan || []).map((entry) => {
    if (entry.step === 'upload-attachment') {
      const file = bugSpec.attachments[upload++] || entry.file;
      return { scope: 'bug', step: 'upload-evidence', effect: `Upload evidence ${path.basename(file)}`, file };
    }
    if (entry.step === 'create-bug') return { scope: 'bug', step: 'create-bug', effect: `Create Bug “${bugSpec.title}”` };
    if (entry.step === 'link-parent') return { scope: 'bug', step: 'link-parent', effect: `Make User Story #${bugSpec.parentStoryId} the Bug's parent` };
    return { scope: 'bug', step: 'set-reproduction-and-evidence', effect: 'Set reproduction details and attach the uploaded evidence' };
  });
}

function semanticTestPlan(plan, action) {
  if (!action || action.action === 'skip') return [];
  return (plan || []).map((entry) => {
    const effects = {
      'create-test-case': `Create Test Case “${action.title}”`,
      'add-to-suite': `Add the new Test Case to suite #${action.suiteId}`,
      'create-run': `Create a test run for Test Case #${action.testCaseId}`,
      'record-failed-result': `Record Test Case #${action.testCaseId} as Failed and associate the new Bug`,
      'complete-run': 'Complete the test run',
      'link-tested-by': `Link Test Case #${action.testCaseId} to the new Bug`,
    };
    return { scope: 'test-case', step: entry.step, effect: effects[entry.step] || entry.step };
  });
}

function semanticBugLedger(ledger, bugSpec) {
  const planned = semanticBugPlan((ledger || []).map((entry) => ({ step: entry.step })), bugSpec);
  return (ledger || []).map((entry, index) => ({
    ...(planned[index] || { scope: 'bug', step: entry.step, effect: entry.step }),
    status: entry.status,
    ...(entry.id !== undefined ? { id: entry.id } : {}),
    ...(agentUrl(entry.url) ? { url: agentUrl(entry.url) } : {}),
    ...(entry.reason ? { reason: safeAgentText(entry.reason) } : {}),
  }));
}

function semanticTestLedger(ledger, action) {
  const planned = semanticTestPlan((ledger || []).map((entry) => ({ step: entry.step })), action);
  return (ledger || []).map((entry, index) => ({
    ...(planned[index] || { scope: 'test-case', step: entry.step, effect: entry.step }),
    status: entry.status,
    ...(entry.id !== undefined ? { id: entry.id } : {}),
    ...(agentUrl(entry.url) ? { url: agentUrl(entry.url) } : {}),
    ...(entry.reason ? { reason: safeAgentText(entry.reason) } : {}),
  }));
}

function notAttempted(plan, reason) {
  return (plan || []).map((entry) => ({ ...entry, status: 'not-attempted', reason }));
}

function trackerKey(adapter) {
  return crypto.createHash('sha256')
    .update(`${adapter.name}\0${adapter.config.base}\0${adapter.config.project}`)
    .digest('hex');
}

function artifactDigest(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function attachmentProofs(files) {
  return (files || []).map((file) => {
    try {
      const bytes = fs.readFileSync(file);
      return {
        file,
        exists: true,
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    } catch {
      return { file, exists: false };
    }
  });
}

function verifyAttachmentProofs(proofs) {
  const current = attachmentProofs((proofs || []).map((proof) => proof.file));
  const changed = [];
  for (let i = 0; i < current.length; i++) {
    const expected = proofs[i];
    const actual = current[i];
    if (
      expected.exists !== actual.exists ||
      expected.bytes !== actual.bytes ||
      expected.sha256 !== actual.sha256
    ) changed.push(expected.file);
  }
  return changed;
}

function markPlanUsed(cwd, approvalId, now) {
  const file = path.join(cwd, '.agentex', 'cache', 'bug-plan-used', approvalId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ approvalId, startedAt: now() }) + '\n', { encoding: 'utf8', flag: 'wx' });
    return null;
  } catch (e) {
    if (e.code === 'EEXIST') return 'this approved plan has already been executed or attempted; prepare and approve a new plan before another write';
    throw e;
  }
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const err = new Error(`could not read ${label} ${file}: ${e.message}`);
    err.exitCode = 2;
    throw err;
  }
}

function writePlanArtifact(file, artifact) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); }
  catch (e) {
    const err = new Error(e.code === 'EEXIST'
      ? `plan file already exists: ${file}; use a new path so an approved plan is never overwritten`
      : `could not write plan file ${file}: ${e.message}`);
    err.exitCode = 2;
    throw err;
  }
}

function approvalBug(normalized, runtime) {
  const spec = normalized.bugSpec;
  return {
    title: spec.title,
    parent: runtime.parent,
    severity: spec.severity,
    priority: spec.priority,
    classificationReason: normalized.classificationReason,
    assignedTo: spec.assignedTo,
    summary: spec.summary,
    steps: spec.steps,
    expected: spec.expected,
    actual: spec.actual,
    ...(spec.environment ? { environment: spec.environment } : {}),
    ...(spec.bugCategory ? { bugCategory: spec.bugCategory } : {}),
    ...(spec.valueArea ? { valueArea: spec.valueArea } : {}),
    placement: { area: spec.areaPath || null, iteration: spec.iterationPath || null },
    testConfiguration: spec.testConfig || 'Windows 11 / Chrome',
    ...(spec.timestamp ? { observedAt: spec.timestamp } : {}),
    template: runtime.template,
  };
}

async function prepare(argv, opts) {
  const args = parseArgs(argv);
  if (!args.intent || !args.plan) {
    return { code: 2, out: { ok: false, mode: 'blocked', error: { message: 'prepare requires --intent <intent.json> and --plan <plan.json>' }, nothingWritten: true } };
  }
  const intentFile = path.resolve(opts.cwd, args.intent);
  const planFile = path.resolve(opts.cwd, args.plan);
  const intent = readJson(intentFile, 'intent');
  const parentStoryId = intent && intent[RAW_INTENT_CONTRACT.fields.parentStoryId];
  const runtime = await loadRuntime(opts.cwd, opts.fetch, {
    parentStoryId,
    refreshFields: Boolean(args['refresh-fields']),
  });
  const context = publicContext(runtime);
  if (runtime.blocked.length) {
    return { code: 2, out: { ok: false, mode: 'blocked', blocked: runtime.blocked, context, nothingWritten: true } };
  }

  const normalized = normalizeIntent(intent, runtime);
  if (normalized.blocked.length) {
    // A missing suite is answered with real runtime choices, not a config/API lesson.
    const suiteBlock = normalized.blocked.find((b) => b.field === 'testCase.suiteId');
    if (suiteBlock && normalized.testCase && normalized.testCase.planId) {
      const suites = await testplan.run(['list-suites', '--plan', String(normalized.testCase.planId)], opts);
      if (suites.code === 0) suiteBlock.options = suites.out.suites;
    }
    return { code: 2, out: { ok: false, mode: 'blocked', blocked: normalized.blocked, context, nothingWritten: true } };
  }

  const currentReview = buildDuplicateReview(runtime, intent);
  const suppliedReviewId = args['duplicate-review'];
  if (!nonEmpty(suppliedReviewId) || String(suppliedReviewId) !== currentReview.duplicateReview.reviewId) {
    const missingReview = !nonEmpty(suppliedReviewId);
    return {
      code: 2,
      out: {
        ok: false,
        mode: 'blocked',
        blocked: [{
          reason: missingReview ? 'duplicate-review-required' : 'duplicate-review-stale',
          message: missingReview
            ? 'review the returned duplicate shortlist, then rerun prepare with its review id'
            : 'the duplicate review is stale because its parent, project, ranking input, or candidate snapshot changed; review the refreshed shortlist and rerun prepare with the new review id',
        }],
        context,
        ...currentReview,
        nothingWritten: true,
      },
    };
  }
  const reviewReceipt = compactDuplicateReview(currentReview.duplicateReview);

  const evidenceChecks = checkFiles(normalized.evidence.attach);
  const invalidEvidence = evidenceChecks.filter((check) => !check.ok);
  const unavailableEvidence = evidenceChecks.filter((check) =>
    !check.ok && check.issues.some((issue) => issue === 'not-found' || issue === 'unreadable'));
  if (unavailableEvidence.length) {
    return {
      code: 2,
      out: {
        ok: false, mode: 'blocked',
        blocked: [{
          reason: 'evidence-unavailable',
          files: unavailableEvidence.map((check) => ({ file: check.file, issues: check.issues })),
          message: 'evidence selected for upload is missing or unreadable; it cannot be waived as structurally invalid',
        }],
        context,
        duplicateReview: reviewReceipt,
        evidence: { attach: evidenceChecks, reject: normalized.evidence.reject },
        nothingWritten: true,
      },
    };
  }
  if (invalidEvidence.length && !normalized.evidence.allowInvalid) {
    return {
      code: 2,
      out: {
        ok: false, mode: 'blocked',
        blocked: [{
          reason: 'attachment-invalid',
          files: invalidEvidence.map((check) => ({ file: check.file, issues: check.issues })),
          message: 'evidence selected for upload failed structural validation; fix or reject it, or obtain an explicit invalid-evidence override',
        }],
        context,
        duplicateReview: reviewReceipt,
        evidence: { attach: evidenceChecks, reject: normalized.evidence.reject },
        nothingWritten: true,
      },
    };
  }
  const proofs = attachmentProofs(normalized.evidence.attach);
  const bugResult = await createBug.run(
    // loadRuntime already rebuilt Bug metadata when refresh was requested.
    bugArgs(normalized.flags),
    { cwd: opts.cwd, fetch: opts.fetch, spec: normalized.bugSpec },
  );
  if (bugResult.code !== 0) {
    return {
      code: bugResult.code,
      out: await publicBlocked(bugResult.out, runtime.adapter, context, {
        attach: evidenceChecks,
        reject: normalized.evidence.reject,
      }, currentReview.duplicateReview),
    };
  }

  const exactTitleCandidates = await duplicateCandidates(runtime.adapter, duplicateIds(bugResult.out));
  let testResult = null;
  let testCaseSummary = normalized.testCase;
  if (normalized.testCase.action === 'fail-existing') {
    const found = await testplan.run([
      'find-case', '--plan', String(normalized.testCase.planId), '--testcase', String(normalized.testCase.testCaseId),
    ], opts);
    if (found.code !== 0 || !found.out.point) {
      return {
        code: 2,
        out: {
          ok: false, mode: 'blocked',
          blocked: [{ reason: 'test-case-invalid', message: found.out.note || resultMessage(found.out) }],
          context, duplicateReview: reviewReceipt, nothingWritten: true,
        },
      };
    }
    testCaseSummary = {
      ...normalized.testCase,
      testCase: found.out.testCase,
      suite: { id: found.out.point.suiteId, name: found.out.point.suiteName },
    };
  }
  if (normalized.testCase.action !== 'skip') {
    if (normalized.testCase.action === 'create-new') {
      const suites = await testplan.run(['list-suites', '--plan', String(normalized.testCase.planId)], opts);
      if (suites.code !== 0) {
        return {
          code: suites.code,
          out: {
            ok: false, mode: 'blocked',
            blocked: [{ reason: 'test-suite-validation', message: resultMessage(suites.out) }],
            context, duplicateReview: reviewReceipt, testCase: testCaseSummary, nothingWritten: true,
          },
        };
      }
      const suite = suites.out.suites.find((item) => Number(item.id) === normalized.testCase.suiteId);
      if (!suite) {
        return {
          code: 2,
          out: {
            ok: false, mode: 'blocked',
            blocked: [{ reason: 'test-suite-not-found', message: `suite #${normalized.testCase.suiteId} is not in test plan #${normalized.testCase.planId}`, options: suites.out.suites }],
            context, duplicateReview: reviewReceipt, testCase: testCaseSummary, nothingWritten: true,
          },
        };
      }
      testCaseSummary = { ...testCaseSummary, suite: { id: suite.id, name: suite.name } };
    }
    testResult = await testplan.run(
      testArgs(normalized.testCase, { refreshFields: Boolean(args['refresh-fields']) }), opts,
    );
    if (testResult.code !== 0) {
      const candidateIds = duplicateIds(testResult.out);
      const candidates = candidateIds.length
        ? await duplicateCandidates(runtime.adapter, candidateIds)
        : [];
      return {
        code: testResult.code,
        out: {
          ok: false, mode: 'blocked',
          blocked: (testResult.out.blocked || [{ reason: 'test-case-validation', message: resultMessage(testResult.out) }]).map(sanitizeBlock),
          ...(candidates.length ? { duplicateCandidates: candidates } : {}),
          context, duplicateReview: reviewReceipt, testCase: testCaseSummary, nothingWritten: true,
        },
      };
    }
  }

  const writePlan = [
    ...semanticBugPlan(bugResult.out.plan, normalized.bugSpec),
    ...semanticTestPlan(testResult && testResult.out.plan, normalized.testCase),
  ];
  const approval = {
    bug: approvalBug(normalized, runtime),
    evidence: {
      attach: evidenceChecks,
      reject: normalized.evidence.reject,
      screenshotWaiver: normalized.evidence.waiveScreenshots,
      invalidEvidenceOverride: normalized.evidence.allowInvalid,
    },
    duplicateReview: reviewReceipt,
    ...(exactTitleCandidates.length ? { exactTitleCandidates } : {}),
    duplicateDecision: normalized.flags.allowDuplicate ? 'file despite returned candidates' : 'no exception requested',
    testCase: testCaseSummary,
    writePlan,
    nothingWritten: true,
  };
  const payload = {
    kind: ARTIFACT_KIND,
    schemaVersion: ARTIFACT_VERSION,
    preparedAt: opts.now(),
    trackerKey: trackerKey(runtime.adapter),
    attachmentProofs: proofs,
    bugSpec: normalized.bugSpec,
    flags: normalized.flags,
    testCase: normalized.testCase,
    approval,
  };
  const approvalId = artifactDigest(payload);
  const artifact = { ...payload, approvalId };
  writePlanArtifact(planFile, artifact);
  return {
    code: 0,
    out: { ok: true, mode: 'plan', approvalId, planFile, approval },
  };
}

function validateArtifact(artifact) {
  if (!artifact || artifact.kind !== ARTIFACT_KIND || artifact.schemaVersion !== ARTIFACT_VERSION) {
    return 'not a supported AgenTeX Azure bug plan';
  }
  const { approvalId, ...payload } = artifact;
  if (!approvalId || artifactDigest(payload) !== approvalId) return 'plan integrity check failed; prepare a new plan and approve that plan';
  return null;
}

async function execute(argv, opts) {
  const args = parseArgs(argv);
  if (!args.plan) {
    return { code: 2, out: { ok: false, mode: 'blocked', error: { message: 'execute requires --plan <approved-plan.json>' }, nothingWritten: true } };
  }
  const planFile = path.resolve(opts.cwd, args.plan);
  const artifact = readJson(planFile, 'plan');
  const invalid = validateArtifact(artifact);
  if (invalid) return { code: 2, out: { ok: false, mode: 'blocked', blocked: [{ reason: 'invalid-plan', message: invalid }], nothingWritten: true } };

  if (process.env.AGENTEX_CI === '1') {
    return {
      code: 2,
      out: {
        ok: false, mode: 'blocked',
        blocked: [{ reason: 'ci-mode', message: 'tracker writes are disabled in CI; file this Bug from an interactive session' }],
        nothingWritten: true,
      },
    };
  }

  const changedAttachments = verifyAttachmentProofs(artifact.attachmentProofs || []);
  if (changedAttachments.length) {
    return {
      code: 2,
      out: {
        ok: false, mode: 'blocked',
        blocked: [{ reason: 'evidence-changed', files: changedAttachments, message: 'approved evidence changed or disappeared; prepare and approve a new plan' }],
        nothingWritten: true,
      },
    };
  }

  const adapter = resolveTracker(opts.cwd, { fetch: opts.fetch });
  if (trackerKey(adapter) !== artifact.trackerKey) {
    return {
      code: 2,
      out: {
        ok: false, mode: 'blocked',
        blocked: [{ reason: 'different-project', message: 'this approved plan belongs to a different tracker project; prepare and approve a new plan here' }],
        nothingWritten: true,
      },
    };
  }

  // Re-run the selected test action's read-only validation before any Bug write.
  // This preserves the one approved dependency chain if a point/suite/title
  // changed between prepare and execute.
  if (artifact.testCase.action === 'fail-existing') {
    const found = await testplan.run([
      'find-case', '--plan', String(artifact.testCase.planId), '--testcase', String(artifact.testCase.testCaseId),
    ], opts);
    if (found.code !== 0 || !found.out.point) {
      return {
        code: 2,
        out: {
          ok: false, mode: 'blocked',
          blocked: [{ reason: 'test-case-invalid', message: found.out.note || resultMessage(found.out) }],
          nothingWritten: true,
        },
      };
    }
  } else if (artifact.testCase.action === 'create-new') {
    const suites = await testplan.run(['list-suites', '--plan', String(artifact.testCase.planId)], opts);
    const suite = suites.code === 0 && suites.out.suites.find((item) => Number(item.id) === artifact.testCase.suiteId);
    if (!suite) {
      return {
        code: 2,
        out: {
          ok: false, mode: 'blocked',
          blocked: [{ reason: 'test-suite-not-found', message: suites.code === 0
            ? `suite #${artifact.testCase.suiteId} is no longer in test plan #${artifact.testCase.planId}`
            : resultMessage(suites.out) }],
          nothingWritten: true,
        },
      };
    }
  }
  if (artifact.testCase.action !== 'skip') {
    const testPreflight = await testplan.run(testArgs(artifact.testCase), opts);
    if (testPreflight.code !== 0) {
      return {
        code: 2,
        out: {
          ok: false, mode: 'blocked',
          blocked: (testPreflight.out.blocked || [{ reason: 'test-case-validation', message: resultMessage(testPreflight.out) }]).map(sanitizeBlock),
          nothingWritten: true,
        },
      };
    }
  }

  let used;
  try { used = markPlanUsed(opts.cwd, artifact.approvalId, opts.now); }
  catch (e) {
    return {
      code: 2,
      out: {
        ok: false, mode: 'blocked',
        blocked: [{ reason: 'plan-state-unavailable', message: `could not reserve this approved plan for one-time execution: ${e.message}` }],
        nothingWritten: true,
      },
    };
  }
  if (used) {
    return {
      code: 2,
      out: {
        ok: false, mode: 'blocked', approvalId: artifact.approvalId, planConsumed: true,
        blocked: [{ reason: 'plan-already-used', message: used }], nothingWritten: true,
      },
    };
  }

  opts.writePhaseStarted = true;
  const bugResult = await createBug.run(
    bugArgs(artifact.flags, { execute: true }),
    { cwd: opts.cwd, fetch: opts.fetch, spec: artifact.bugSpec },
  );
  const testPlanned = artifact.approval.writePlan.filter((entry) => entry.scope === 'test-case');
  if (bugResult.code !== 0) {
    if (!bugResult.out.ledger) {
      return {
        code: bugResult.code,
        out: {
          ...await publicBlocked(bugResult.out, adapter),
          approvalId: artifact.approvalId,
          planConsumed: true,
        },
      };
    }
    return {
      code: 1,
      out: {
        ok: false, mode: 'executed', approvalId: artifact.approvalId,
        ledger: [
          ...semanticBugLedger(bugResult.out.ledger, artifact.bugSpec),
          ...notAttempted(testPlanned, 'the Bug filing did not complete'),
        ],
        created: { bug: semanticCreated(bugResult.out.created || {}) },
      },
    };
  }

  const bugLedger = semanticBugLedger(bugResult.out.ledger, artifact.bugSpec);
  const bugId = bugResult.out.created && bugResult.out.created.bugId;
  if (artifact.testCase.action === 'skip') {
    return {
      code: 0,
      out: {
        ok: true, mode: 'executed', approvalId: artifact.approvalId,
        ledger: bugLedger, created: { bug: semanticCreated(bugResult.out.created) },
      },
    };
  }

  const testResult = await testplan.run(
    testArgs(artifact.testCase, { execute: true, bugId }), opts,
  );
  if (testResult.code !== 0) {
    const testLedger = testResult.out.ledger
      ? semanticTestLedger(testResult.out.ledger, artifact.testCase)
      : notAttempted(testPlanned, resultMessage(testResult.out));
    return {
      code: 1,
      out: {
        ok: false, mode: 'executed', approvalId: artifact.approvalId,
        ledger: [...bugLedger, ...testLedger],
        created: {
          bug: semanticCreated(bugResult.out.created),
          ...(testResult.out.created ? { testCase: semanticCreated(testResult.out.created) } : {}),
          ...(testResult.out.run ? { run: semanticCreated(testResult.out.run) } : {}),
          ...(testResult.out.resultId ? { resultId: testResult.out.resultId } : {}),
        },
        testCaseError: resultMessage(testResult.out),
      },
    };
  }

  return {
    code: 0,
    out: {
      ok: true, mode: 'executed', approvalId: artifact.approvalId,
      ledger: [...bugLedger, ...semanticTestLedger(testResult.out.ledger, artifact.testCase)],
      created: {
        bug: semanticCreated(bugResult.out.created),
        ...(testResult.out.created ? { testCase: semanticCreated(testResult.out.created) } : {}),
        ...(testResult.out.run ? { run: semanticCreated(testResult.out.run) } : {}),
        ...(testResult.out.resultId ? { resultId: testResult.out.resultId } : {}),
      },
    },
  };
}

function trackerErrorOut(error, mode) {
  return {
    ok: false, mode,
    error: {
      message: safeFailureMessage(error),
      operation: operationName(error.op),
      status: error.status,
      ...(error.credentialHint ? { credentialHint: error.credentialHint } : {}),
    },
    nothingWritten: mode !== 'executed',
  };
}

async function run(argv, {
  cwd = process.cwd(), fetch, now = () => new Date().toISOString(),
} = {}) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const opts = { cwd, fetch, now, writePhaseStarted: false };
  try {
    if (cmd === 'context') {
      const args = parseArgs(rest);
      const duplicateView = args['duplicate-view'] || 'shortlist';
      if (!['shortlist', 'all'].includes(duplicateView)) {
        return {
          code: 2,
          out: {
            ok: false, mode: 'blocked',
            error: { message: '--duplicate-view must be "shortlist" or "all"' },
            nothingWritten: true,
          },
        };
      }
      if (args.intent === true) {
        return {
          code: 2,
          out: { ok: false, mode: 'blocked', error: { message: 'context --intent requires a JSON file path' }, nothingWritten: true },
        };
      }
      const intent = args.intent
        ? readJson(path.resolve(cwd, args.intent), 'intent')
        : null;
      if (!intent && duplicateView === 'all') {
        return {
          code: 2,
          out: { ok: false, mode: 'blocked', error: { message: '--duplicate-view all requires --intent <intent.json>' }, nothingWritten: true },
        };
      }
      const intentParent = intent && intent[RAW_INTENT_CONTRACT.fields.parentStoryId];
      if (intent && nonEmpty(args.parent) && positiveId(args.parent) !== positiveId(intentParent)) {
        return {
          code: 2,
          out: {
            ok: false, mode: 'blocked',
            blocked: [{
              reason: 'parent-mismatch',
              message: `--parent ${JSON.stringify(args.parent)} does not match intent parentStoryId ${JSON.stringify(intentParent)}`,
            }],
            nothingWritten: true,
          },
        };
      }
      const runtime = await loadRuntime(cwd, fetch, {
        parentStoryId: intent ? intentParent : args.parent,
        refreshFields: Boolean(args['refresh-fields']),
      });
      const context = publicContext(runtime);
      if (runtime.blocked.length) {
        return { code: 2, out: { ok: false, mode: 'blocked', blocked: runtime.blocked, context, nothingWritten: true } };
      }
      if (intent) {
        const blocked = duplicateReviewInputBlocks(intent);
        if (blocked.length) {
          return {
            code: 2,
            out: {
              ok: false, mode: 'blocked', blocked, ...context,
              duplicateReview: { ...pendingDuplicateReview(runtime), status: 'intent-invalid' },
              ...(args['emit-intent'] ? { intentTemplate: buildIntentTemplate(runtime) } : {}),
              nothingWritten: true,
            },
          };
        }
      }
      const duplicateOutput = intent
        ? buildDuplicateReview(runtime, intent, { view: duplicateView })
        : { duplicateReview: pendingDuplicateReview(runtime) };
      return {
        code: 0,
        out: {
          ok: true,
          mode: 'context',
          ...context,
          ...duplicateOutput,
          ...(args['emit-intent'] ? { intentTemplate: buildIntentTemplate(runtime) } : {}),
          nothingWritten: true,
        },
      };
    }
    if (cmd === 'prepare') return await prepare(rest, opts);
    if (cmd === 'execute') return await execute(rest, opts);
    return {
      code: 2,
      out: { ok: false, mode: 'blocked', error: { message: 'usage: bug-report.js <context|prepare|execute> [options]' }, nothingWritten: true },
    };
  } catch (e) {
    const writesMayHaveStarted = cmd === 'execute' && opts.writePhaseStarted;
    const mode = writesMayHaveStarted ? 'executed' : 'blocked';
    if (e instanceof TrackerError) return { code: 1, out: trackerErrorOut(e, mode) };
    return {
      code: e.exitCode === 2 ? 2 : 1,
      out: { ok: false, mode, error: { message: e.message }, nothingWritten: !writesMayHaveStarted },
    };
  }
}

module.exports = {
  run, publicContext, normalizeIntent, semanticBugPlan, semanticTestPlan,
  validateArtifact, ARTIFACT_KIND, ARTIFACT_VERSION,
};

if (require.main === module) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    console.log(JSON.stringify(out));
    process.exitCode = code;
  });
}
