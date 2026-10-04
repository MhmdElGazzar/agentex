'use strict';

const { resolvePluginRoot } = require('./lib/plugin_root.js');

try {
  console.log(JSON.stringify({ root: resolvePluginRoot() }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 2;
}
