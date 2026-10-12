'use strict';
const { isDeepStrictEqual } = require('node:util');

const pending = step => step?.uiCheck?.status === 'NEEDS-USER';
const mismatch = step => step?.uiCheck?.status === 'VIEW MISMATCH ERROR';
const text = value => typeof value === 'string' && value.trim().length > 0;

function validateUiDetails(result) {
  const problems = [];
  for (const step of Array.isArray(result?.steps) ? result.steps : []) {
    const ui = step?.uiCheck;
    if (ui === undefined) continue;
    if (!ui || typeof ui !== 'object' || Array.isArray(ui) ||
        !['NEEDS-USER', 'VIEW MISMATCH ERROR', 'PASS', 'FAIL', 'WARNING', 'BLOCKED'].includes(ui.status)) {
      problems.push('ui-outcome-shape'); continue;
    }
    if ((pending(step) || mismatch(step)) && step.outcome !== 'BLOCKED') problems.push('ui-outcome-contradiction');
    if (pending(step) && !text(ui.question)) problems.push('ui-question-required');
    if (mismatch(step) && !text(ui.reason)) problems.push('ui-mismatch-reason-required');
    if (!pending(step) && !mismatch(step) && ui.status !== step.outcome) problems.push('ui-outcome-contradiction');
    const refs = new Set(Array.isArray(step.evidence) ? step.evidence.map(x => x?.path) : []);
    if (pending(step) && (!text(ui.baselineImage) || !text(ui.actualImage))) problems.push('ui-images-required');
    for (const key of ['baselineImage', 'actualImage']) {
      if (ui[key] !== undefined && !refs.has(ui[key])) problems.push('ui-image-evidence');
    }
  }
  return problems;
}

function validateResolution(raw, record) {
  if (!record || !Array.isArray(record.answers) || !record.finalResult) throw Error('invalid UI resolution');
  const before = raw.steps.filter(pending);
  if (!before.length || record.answers.length !== before.length) throw Error('invalid UI resolution coverage');
  const answers = new Map();
  for (const answer of record.answers) {
    if (!answer || !text(answer.stepId) || answers.has(answer.stepId) || !text(answer.resolution) ||
        !['PASS', 'FAIL', 'WARNING', 'BLOCKED'].includes(answer.finalStatus)) throw Error('invalid UI answer');
    answers.set(answer.stepId, answer);
  }
  const final = record.finalResult;
  if (!Array.isArray(final.steps) || final.steps.length !== raw.steps.length) throw Error('invalid UI final steps');
  const mutableRoot = new Set(['steps', 'scenarioOutcome', 'summary', 'verdict', 'exitCode']);
  for (const key of new Set([...Object.keys(raw), ...Object.keys(final)])) {
    if (!mutableRoot.has(key) && !isDeepStrictEqual(raw[key], final[key])) throw Error('UI resolution changed retained result');
  }
  for (let i = 0; i < raw.steps.length; i++) {
    const old = raw.steps[i], next = final.steps[i];
    if (!pending(old)) {
      if (!isDeepStrictEqual(old, next)) throw Error('UI resolution changed other step');
      continue;
    }
    const answer = answers.get(old.stepId);
    if (!answer || answer.question !== old.uiCheck.question || next?.stepId !== old.stepId ||
        next.outcome !== answer.finalStatus || next.uiCheck?.status !== answer.finalStatus)
      throw Error('UI resolution answer mismatch');
    const mutableStep = new Set(['outcome', 'assertions', 'note', 'uiCheck']);
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (!mutableStep.has(key) && !isDeepStrictEqual(old[key], next[key])) throw Error('UI resolution changed retained step');
    }
    const oldUi = { ...old.uiCheck }, nextUi = { ...next.uiCheck };
    delete oldUi.status; delete nextUi.status;
    if (!isDeepStrictEqual(oldUi, nextUi)) throw Error('UI resolution changed retained UI evidence');
  }
  if (validateUiDetails(final).length) throw Error('invalid resolved UI details');
  return record.answers.map(answer => {
    const old = before.find(x => x.stepId === answer.stepId);
    return { question: answer.question, resolution: answer.resolution,
      finalStatus: answer.finalStatus, baselineImage: old.uiCheck.baselineImage,
      actualImage: old.uiCheck.actualImage };
  });
}

function projectUiReport(step) {
  const ui = step.uiCheck;
  if (!ui) return null;
  return { mode: ui.mode, baseline: ui.baseline, verdict: ui.status,
    baselineImage: ui.baselineImage, actualImage: ui.actualImage };
}

module.exports = { pending, mismatch, validateUiDetails, validateResolution, projectUiReport };
