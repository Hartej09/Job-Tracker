// Loads the .gs files into a fresh Node VM context backed by the in-memory mocks.
// Like Apps Script, all files share one global scope.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createGasMocks } = require('./gas-mocks.js');

const FILES = ['Code.gs', 'Sync.gs'];
const SOURCES = FILES.map((f) => [f, fs.readFileSync(path.join(__dirname, '..', f), 'utf8')]);

/** options.gmail === false loads without the Gmail service (as if it isn't enabled). */
function loadCode(options) {
  const mocks = createGasMocks(options);
  const context = vm.createContext(Object.assign({ console }, mocks.globals));
  for (const [filename, source] of SOURCES) vm.runInContext(source, context, { filename });
  // Top-level consts and functions live in the context's global scope.
  const gas = new Proxy({}, {
    get: (_, name) => vm.runInContext(String(name), context),
  });
  // Plain JSON copies, like google.script.run's serialization.
  const json = (value) => JSON.parse(JSON.stringify(value));
  return Object.assign(mocks, { context, gas, json });
}

module.exports = { loadCode };
