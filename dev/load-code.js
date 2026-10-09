// Loads Code.gs into a fresh Node VM context backed by the in-memory mocks.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createGasMocks } = require('./gas-mocks.js');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function loadCode(options) {
  const mocks = createGasMocks(options);
  const context = vm.createContext(Object.assign({ console }, mocks.globals));
  vm.runInContext(CODE, context, { filename: 'Code.gs' });
  // Top-level consts and functions live in the context's global scope.
  const gas = new Proxy({}, {
    get: (_, name) => vm.runInContext(String(name), context),
  });
  // Plain JSON copies, like google.script.run's serialization.
  const json = (value) => JSON.parse(JSON.stringify(value));
  return Object.assign(mocks, { context, gas, json });
}

module.exports = { loadCode };
