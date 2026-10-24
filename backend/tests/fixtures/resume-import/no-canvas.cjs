// Exercise text extraction exactly as on a clean install with canvas's native
// build/download script denied. No native graphics implementation is available.
const Module = require('node:module');
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === 'canvas') {
    const error = new Error('Native graphics intentionally unavailable');
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return load.call(this, name, ...args);
};
