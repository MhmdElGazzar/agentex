'use strict';
const fs = require('node:fs');
const path = require('node:path');

function validateProjectRoot(input, pluginRoot) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw Error('absolute consumer project root required');
  const root = fs.realpathSync(input);
  const plugin = fs.realpathSync(pluginRoot);
  const relativeToPlugin = path.relative(plugin, root);
  if (!fs.statSync(root).isDirectory() || !relativeToPlugin ||
      (relativeToPlugin !== '..' && !relativeToPlugin.startsWith('..' + path.sep) && !path.isAbsolute(relativeToPlugin)))
    throw Error('distinct consumer project directory required');
  return root;
}

// Existing ancestors must be ordinary directories. A final skill file may be a
// link because it is preserved, never opened or replaced by the installer.
function assertManagedPath(root, parts, { preserveLeafLink = false } = {}) {
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (typeof part !== 'string' || !part || part === '.' || part === '..' ||
        part.includes('/') || part.includes('\\')) throw Error('unsafe managed path');
    current = path.join(current, part);
    let info;
    try { info = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') return current;
      throw error;
    }
    const leaf = i === parts.length - 1;
    if (info.isSymbolicLink()) {
      if (leaf && preserveLeafLink) return current;
      throw Error('linked managed path is unsafe');
    }
    if (leaf ? !info.isFile() : !info.isDirectory()) throw Error('unsafe managed path type');
  }
  return current;
}

module.exports = { validateProjectRoot, assertManagedPath };
