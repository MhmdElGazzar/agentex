#!/usr/bin/env node
'use strict';
// AgenTeX Figma text extractor — pulls the EFFECTIVELY VISIBLE TEXT layers from a
// Figma node, so hidden layers never become fabricated requirements.
// Usage:
//   node extract_visible_text.js --file <FILE_KEY> --node <NODE_ID> [--per-frame]
//   cat nodes.json | node extract_visible_text.js --stdin [--per-frame]
// --per-frame: a SECTION (or any node holding several frames) → one group per child
// frame instead of a single flat dump.
// Auth: reads FIGMA_ACCESS_TOKEN from the environment, sent as the X-Figma-Token
// header. Never printed, never placed in argv.
const fs = require('fs');

// A layer counts as visible only when nothing above it hides it: `visible:false`
// hides the whole subtree, and `opacity` MULTIPLIES down the tree — a node can be
// `visible:true` while inheriting `opacity:0`, so checking `visible` alone silently
// lets hidden text through.
function extractVisibleText(node) {
  const out = [];
  (function walk(n, vis, op) {
    const v = n.visible === false ? false : vis;
    const o = (n.opacity === undefined ? 1 : n.opacity) * op;
    if (v && o > 0 && n.type === 'TEXT' && n.characters) {
      out.push(n.characters.replace(/\s+/g, ' ').trim());
    }
    (n.children || []).forEach(c => walk(c, v, o));
  })(node, true, 1);
  return out;
}

// A SECTION/holder → one group per child frame; a single frame → just itself.
function framesOf(root) {
  const holdsFrames = root.type === 'SECTION' ||
    (root.children || []).some(c => c.type === 'FRAME');
  if (!holdsFrames) return [root];
  return (root.children || [])
    .filter(c => ['FRAME', 'COMPONENT', 'INSTANCE'].includes(c.type));
}

function report(root, perFrame) {
  const groups = perFrame ? framesOf(root) : [root];
  for (const g of groups) {
    const text = extractVisibleText(g);
    console.log(`\n## ${g.name}  (${text.length} visible text layers)`);
    text.forEach(t => t && console.log('  • ' + t));
  }
}

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fromResponse(json) {
  // /nodes?ids= is keyed by the COLON form of the id regardless of what was sent,
  // so index by value rather than by the id string.
  const nodes = json.nodes;
  if (!nodes) throw new Error('response has no "nodes" — check FILE_KEY and NODE_ID');
  const first = Object.values(nodes)[0];
  if (!first || !first.document) throw new Error('node not found or not readable');
  return first.document;
}

async function main() {
  const perFrame = process.argv.includes('--per-frame');

  if (process.argv.includes('--stdin')) {
    const raw = fs.readFileSync(0, 'utf8');
    report(fromResponse(JSON.parse(raw)), perFrame);
    return;
  }

  const fileKey = arg('file');
  const nodeId = arg('node');
  if (!fileKey || !nodeId) {
    console.error('Usage: node extract_visible_text.js --file <FILE_KEY> --node <NODE_ID> [--per-frame]');
    console.error('   or: cat nodes.json | node extract_visible_text.js --stdin [--per-frame]');
    process.exitCode = 2;
    return;
  }
  const token = process.env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    console.error('BLOCKED: FIGMA_ACCESS_TOKEN is not set (put it in .env, gitignored)');
    process.exitCode = 2;
    return;
  }

  const url = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}` +
    `/nodes?ids=${encodeURIComponent(nodeId)}`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) {
    // 404 here is the signature of a token missing the File-content:Read scope.
    console.error(`BLOCKED: Figma API ${res.status} (404 usually = missing File Read scope or no access)`);
    process.exitCode = 2;
    return;
  }
  report(fromResponse(await res.json()), perFrame);
}

if (require.main === module) {
  main().catch(e => {
    console.error('BLOCKED: ' + e.message);
    process.exitCode = 2;
  });
}

module.exports = { extractVisibleText, framesOf };
