'use strict';

// Deterministic presentation ordering only. Duplicate judgment and blocking
// policy stay with the agent and the bug-report workflow.

const RANKING_STRATEGY = 'lexical-idf-recall-v0';
const DEFAULT_SHORTLIST_SIZE = 25;
const FIELD_WEIGHTS = Object.freeze({
  title: 8,
  actual: 6,
  summary: 4,
  steps: 2,
  expected: 1,
});
const RANKING_FIELDS = Object.freeze(Object.keys(FIELD_WEIGHTS));

const NAMED_ENTITIES = Object.freeze({
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
});

function decodeHtmlEntities(value) {
  return value.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|quot|apos|lt|gt|nbsp));/giu,
    (match, decimal, hex, named) => {
      if (named) return NAMED_ENTITIES[named.toLowerCase()];
      const codePoint = Number.parseInt(decimal || hex, decimal ? 10 : 16);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try { return String.fromCodePoint(codePoint); } catch { return match; }
    });
}

function normalizeText(value) {
  return decodeHtmlEntities(String(value == null ? '' : value))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/([\p{L}\p{N}])['\u2019]s\b/giu, '$1')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function addToken(tokens, token) {
  const clean = token.replace(/^[._:/-]+|[._:/-]+$/gu, '');
  if (clean) tokens.add(clean);
}

function tokensFor(value) {
  const tokens = new Set();
  const compounds = normalizeText(value).match(/[\p{L}\p{N}]+(?:[._:/-]+[\p{L}\p{N}]+)*/gu) || [];
  for (const compound of compounds) {
    addToken(tokens, compound);
    for (const part of compound.split(/[._:/-]+/u)) {
      addToken(tokens, part);
      const components = part
        .replace(/([\p{L}])(\p{N})/gu, '$1 $2')
        .replace(/(\p{N})([\p{L}])/gu, '$1 $2')
        .split(' ');
      for (const component of components) addToken(tokens, component);
    }
  }
  return tokens;
}

function phraseFor(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function fieldText(value) {
  if (Array.isArray(value)) return value.join(' ');
  return value == null ? '' : String(value);
}

function rankingIntentSnapshot(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new TypeError('intent must be an object');
  }
  const snapshot = {};
  for (const field of RANKING_FIELDS) {
    const value = intent[field];
    snapshot[field] = Array.isArray(value)
      ? value.map((item) => normalizeText(item))
      : normalizeText(value);
  }
  return snapshot;
}

function queryTokenWeights(intent) {
  const weights = new Map();
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    for (const token of tokensFor(fieldText(intent && intent[field]))) {
      weights.set(token, Math.max(weights.get(token) || 0, weight));
    }
  }
  return weights;
}

function candidateTokens(candidate) {
  const title = tokensFor(candidate && candidate.title);
  const reproduction = tokensFor(candidate && candidate.reproductionSummary);
  return { title, all: new Set([...title, ...reproduction]) };
}

function idfWeights(documents) {
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const token of document.all) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const count = documents.length;
  const weights = new Map();
  for (const [token, frequency] of documentFrequency) {
    weights.set(token, Math.max(1, Math.round(1000 * Math.log((count + 1) / (frequency + 1)))));
  }
  return { documentFrequency, weights };
}

function idfFor(token, idf) {
  if (idf.weights.has(token)) return idf.weights.get(token);
  return Math.max(1, Math.round(1000 * Math.log(idf.documentCount + 1)));
}

function coveragePpm(queryWeights, candidateSet, idf) {
  let total = 0;
  let matched = 0;
  for (const [token, fieldWeight] of queryWeights) {
    const weight = fieldWeight * idfFor(token, idf);
    total += weight;
    if (candidateSet.has(token)) matched += weight;
  }
  return total ? Math.round((matched * 1_000_000) / total) : 0;
}

function matchedTerms(queryWeights, candidateSet) {
  return [...queryWeights.keys()].filter((token) => candidateSet.has(token)).sort(codePointOrder);
}

function codePointOrder(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return codePointOrder(String(left == null ? '' : left), String(right == null ? '' : right));
}

function rankDuplicateCandidates(intent, candidates) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new TypeError('intent must be an object');
  }
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');

  const rankingIntent = rankingIntentSnapshot(intent);
  const documents = candidates.map(candidateTokens);
  const idf = idfWeights(documents);
  idf.documentCount = documents.length;
  const allQueryWeights = queryTokenWeights(rankingIntent);
  const titleQueryWeights = new Map([...tokensFor(rankingIntent.title)].map((token) => [token, FIELD_WEIGHTS.title]));
  const normalizedTitle = phraseFor(rankingIntent.title);

  const ranked = candidates.map((candidate, index) => {
    const document = documents[index];
    const titleCoveragePpm = coveragePpm(titleQueryWeights, document.title, idf);
    const reproductionCoveragePpm = coveragePpm(allQueryWeights, document.all, idf);
    const matchedTitleTerms = matchedTerms(titleQueryWeights, document.title);
    const matchedReproductionTerms = matchedTerms(allQueryWeights, document.all);
    const exactTitle = Boolean(normalizedTitle) && phraseFor(candidate && candidate.title) === normalizedTitle;
    const recallCoveragePpm = Math.max(titleCoveragePpm, reproductionCoveragePpm);
    const blendedCoveragePpm = Math.round((3 * titleCoveragePpm + reproductionCoveragePpm) / 4);
    const uniqueMatchedTermCount = new Set([...matchedTitleTerms, ...matchedReproductionTerms]).size;
    return {
      candidate: { ...(candidate || {}) },
      match: {
        exactTitle,
        titleCoveragePpm,
        reproductionCoveragePpm,
        recallCoveragePpm,
        blendedCoveragePpm,
        uniqueMatchedTermCount,
        matchedTitleTerms,
        matchedReproductionTerms,
      },
    };
  });

  ranked.sort((left, right) => {
    const a = left.match; const b = right.match;
    if (a.exactTitle !== b.exactTitle) return a.exactTitle ? -1 : 1;
    if (a.recallCoveragePpm !== b.recallCoveragePpm) return b.recallCoveragePpm - a.recallCoveragePpm;
    if (a.blendedCoveragePpm !== b.blendedCoveragePpm) return b.blendedCoveragePpm - a.blendedCoveragePpm;
    if (a.uniqueMatchedTermCount !== b.uniqueMatchedTermCount) {
      return b.uniqueMatchedTermCount - a.uniqueMatchedTermCount;
    }
    const idOrder = compareIds(left.candidate.id, right.candidate.id);
    if (idOrder) return idOrder;
    return codePointOrder(String(left.candidate.title || ''), String(right.candidate.title || ''));
  });
  ranked.forEach((entry, index) => { entry.rank = index + 1; });

  let informativeQueryTermCount = 0;
  for (const token of allQueryWeights.keys()) {
    if ((idf.documentFrequency.get(token) || 0) < Math.max(1, documents.length / 2)) {
      informativeQueryTermCount++;
    }
  }

  return {
    ranked,
    diagnostics: {
      strategy: RANKING_STRATEGY,
      candidateCount: candidates.length,
      queryTermCount: allQueryWeights.size,
      informativeQueryTermCount,
      lowSignal: allQueryWeights.size < 3 || informativeQueryTermCount < 2,
    },
  };
}

function projectShortlist(result, limit = DEFAULT_SHORTLIST_SIZE) {
  if (!result || !Array.isArray(result.ranked)) throw new TypeError('ranking result is required');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  const pinnedExactTitleCount = result.ranked.filter((entry) => entry.match && entry.match.exactTitle).length;
  const selected = result.ranked.slice(0, Math.max(limit, pinnedExactTitleCount));
  return {
    strategy: result.diagnostics && result.diagnostics.strategy || RANKING_STRATEGY,
    defaultShortlistSize: limit,
    totalCandidates: result.ranked.length,
    shownCandidates: selected.length,
    omittedCandidateCount: Math.max(0, result.ranked.length - selected.length),
    truncated: selected.length < result.ranked.length,
    pinnedExactTitleCount,
    candidates: selected.map((entry) => ({ ...entry.candidate })),
  };
}

module.exports = {
  rankDuplicateCandidates,
  projectShortlist,
  rankingIntentSnapshot,
  RANKING_FIELDS,
  RANKING_STRATEGY,
  DEFAULT_SHORTLIST_SIZE,
};
