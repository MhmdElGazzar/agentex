'use strict';
// ADF composition (O2 of the Jira design) — Atlassian Document Format, the
// rich-text dialect of Jira Cloud REST v3 bodies (description, environment,
// comments).
//
// Two deterministic surfaces, no markdown/HTML parsing anywhere:
//   - toAdf(text): the documented PLAIN-TEXT mapping the adapter's dialect
//     layer applies to plain strings handed to known rich-text fields —
//     paragraphs split on blank lines, single newlines become hardBreak,
//     everything else stays literal text (the exact analog of ADO's json-patch
//     conversion: the dialect seam doing its job, not a silent transformation).
//   - builders (doc/paragraph/heading/orderedList/bulletList/codeBlock/strong):
//     what consumer scripts compose STRUCTURED bodies from — bug repro
//     sections, test-artifact step lists — from the structured spec data they
//     already hold. Nothing in the flows starts from HTML, so no converter
//     exists or is needed.
//
// Read path note: consumers never parse ADF back — every getWorkItem requests
// expand=renderedFields and reads Jira's own HTML rendering instead.

const text = (t) => ({ type: 'text', text: String(t) });
const inline = (v) => (typeof v === 'object' && v !== null ? v : text(v));

/** Plain text -> a full ADF doc. Blank lines split paragraphs; single newlines
 *  become hardBreak nodes. Empty input is one empty paragraph (valid minimal doc). */
function toAdf(input) {
  const s = input === null || input === undefined ? '' : String(input);
  const paras = s.split(/\r?\n\s*\r?\n/);
  const content = paras.map((p) => {
    const lines = p.split(/\r?\n/);
    const nodes = [];
    lines.forEach((line, i) => {
      if (i > 0) nodes.push({ type: 'hardBreak' });
      if (line !== '') nodes.push(text(line));
    });
    return { type: 'paragraph', content: nodes };
  });
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}

/** Wrap block nodes in the document envelope. */
function doc(...nodes) {
  return { type: 'doc', version: 1, content: nodes };
}

/** A paragraph of inline content — strings become text nodes, prebuilt inline
 *  nodes (e.g. strong()) pass through. */
function paragraph(...parts) {
  return { type: 'paragraph', content: parts.map(inline) };
}

function heading(level, t) {
  return { type: 'heading', attrs: { level }, content: [text(t)] };
}

// items: strings (each becomes listItem > paragraph) or prebuilt block nodes
// (each becomes the listItem body as-is).
const listItem = (item) =>
  ({ type: 'listItem', content: [typeof item === 'object' && item !== null ? item : paragraph(item)] });

function orderedList(items) {
  return { type: 'orderedList', content: items.map(listItem) };
}

function bulletList(items) {
  return { type: 'bulletList', content: items.map(listItem) };
}

function codeBlock(t) {
  return { type: 'codeBlock', content: [text(t)] };
}

/** Inline bold text node. */
function strong(t) {
  return { type: 'text', text: String(t), marks: [{ type: 'strong' }] };
}

module.exports = { toAdf, doc, paragraph, heading, orderedList, bulletList, codeBlock, strong };
