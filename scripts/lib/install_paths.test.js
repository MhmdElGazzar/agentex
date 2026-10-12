'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncSkills, run } = require('../codex/install');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentex-install-paths-'));
function linkDir(target, alias) {
  try { fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return false;
    throw error;
  }
  return true;
}

test('linked skills ancestor cannot redirect installation outside consumer', (t) => {
  const project = temp(), outside = temp();
  fs.mkdirSync(path.join(project, '.agents'));
  if (!linkDir(outside, path.join(project, '.agents', 'skills'))) return t.skip('links unavailable');
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'untouched');
  assert.throws(() => syncSkills(project), /link|junction|contain|unsafe/i);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
  assert.equal(fs.readdirSync(outside).length, 1);
});

test('linked metadata directory is rejected before reads or writes', (t) => {
  const project = temp(), outside = temp();
  if (!linkDir(outside, path.join(project, '.agentex'))) return t.skip('links unavailable');
  assert.throws(() => syncSkills(project), /link|junction|contain|unsafe/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('init refuses linked metadata parent before base scaffold changes', (t) => {
  const project = temp(), outside = temp();
  if (!linkDir(outside, path.join(project, '.agentex'))) return t.skip('links unavailable');
  assert.throws(() => run('init', project), /link|junction|contain|unsafe/i);
  assert.equal(fs.existsSync(path.join(project, 'config', 'project.json')), false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('dangling linked skills parent is rejected', (t) => {
  const project = temp(), outside = temp();
  fs.mkdirSync(path.join(project, '.agents'));
  const absent = path.join(outside, 'absent');
  if (!linkDir(absent, path.join(project, '.agents', 'skills'))) return t.skip('links unavailable');
  assert.throws(() => syncSkills(project), /link|junction|contain|unsafe/i);
  assert.equal(fs.existsSync(absent), false);
});

test('linked metadata file is rejected', (t) => {
  const project = temp(), outside = temp();
  fs.mkdirSync(path.join(project, '.agentex'));
  const foreign = path.join(outside, 'codex.json');
  fs.writeFileSync(foreign, JSON.stringify({ skills: {} }));
  try { fs.symlinkSync(foreign, path.join(project, '.agentex', 'codex.json'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('links unavailable');
    throw error;
  }
  assert.throws(() => syncSkills(project), /link|junction|contain|unsafe/i);
  assert.equal(fs.readFileSync(foreign, 'utf8'), JSON.stringify({ skills: {} }));
});
