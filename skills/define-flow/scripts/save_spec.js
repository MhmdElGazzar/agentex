#!/usr/bin/env node
'use strict';

// Shared final-save guard for a define-flow draft. The interactive skill owns
// the browser session and the user's confirmation; this script only validates
// and creates one new AgenTeX spec without replacing an existing file.
const fs = require('node:fs');
const path = require('node:path');
const { resolveSpecs } = require('../../agentex-test/scripts/parallel.js');

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function validateBody(body) {
  const errors = [];
  if (!/^#\s*Spec:\s*\S.*$/m.test(body)) errors.push('non-empty # Spec: title required');
  if (!/^Target:\s*\S+/im.test(body)) errors.push('Target required');
  if (!/^##\s*Acceptance criteria\b/im.test(body)) errors.push('Acceptance criteria required');
  if (!/^##\s*Scenarios?\b/im.test(body)) errors.push('Scenarios required');
  const section = body.match(/^##\s*Scenarios?\b[^\r\n]*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im);
  const steps = section ? section[1].split(/\r?\n/).filter(line => /^\s*\d+\.\s+\S/.test(line)) : [];
  if (!steps.length) errors.push('at least one numbered actionable scenario step required');
  if (steps.some(line => !/\b(?:expect|expected|should|verify|assert)\b|(?:المتوقع|نتوقع|تأكد)/i.test(line))) {
    errors.push('each numbered step needs an expected result');
  }
  if (/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/i.test(body) ||
      /\b(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[^\s{}<>]{4,}/i.test(body)) {
    errors.push('possible embedded credential');
  }
  if (/[A-Za-z]:\\Users\\[^\\\s]+\\|\/home\/[^/\s]+\/|\/Users\/[^/\s]+\//i.test(body)) {
    errors.push('developer-local absolute path');
  }
  return errors;
}

function saveSpec({ cwd, draft, output }) {
  const root = fs.realpathSync(cwd);
  const testRoot = path.join(root, 'test');
  const destination = path.resolve(root, output);
  if (path.isAbsolute(output) || path.extname(destination).toLowerCase() !== '.md' ||
      !inside(testRoot, destination) || destination === testRoot) {
    throw new Error('output must be a new Markdown spec under test/');
  }
  if (!fs.existsSync(testRoot) || !fs.statSync(testRoot).isDirectory() ||
      fs.realpathSync(testRoot) !== testRoot) throw new Error('test/ must be a real directory');
  const parent = path.dirname(destination);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory() ||
      !inside(testRoot, fs.realpathSync(parent))) throw new Error('spec parent must exist inside test/');
  const draftPath = path.resolve(root, draft);
  if (!inside(root, draftPath) || !fs.statSync(draftPath).isFile() ||
      !inside(root, fs.realpathSync(draftPath))) throw new Error('draft must be a file inside consumer project');
  const body = fs.readFileSync(draftPath, 'utf8');
  const errors = validateBody(body);
  if (errors.length) throw new Error(errors.join('; '));
  const fd = fs.openSync(destination, 'wx');
  try { fs.writeFileSync(fd, body, 'utf8'); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(destination); throw error; }
  fs.closeSync(fd);
  try { resolveSpecs(root, { specs: [output] }); }
  catch (error) { fs.unlinkSync(destination); throw error; }
  return path.relative(root, destination).replace(/\\/g, '/');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--draft', '--output'].includes(args[i]) || !args[i + 1] || values[args[i]]) {
      console.error('usage: save_spec.js --draft <relative-file> --output <test/path.md>');
      process.exit(2);
    }
    values[args[i]] = args[i + 1];
  }
  if (!values['--draft'] || !values['--output']) {
    console.error('usage: save_spec.js --draft <relative-file> --output <test/path.md>');
    process.exit(2);
  }
  try { console.log(JSON.stringify({ ok: true, spec: saveSpec({ cwd: process.cwd(), draft: values['--draft'], output: values['--output'] }) })); }
  catch (error) { console.error(JSON.stringify({ ok: false, reason: error.code === 'EEXIST' ? 'spec already exists; choose a new name' : error.message })); process.exitCode = 2; }
}

module.exports = { validateBody, saveSpec };
