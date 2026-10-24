'use strict';
// Evidence only: never changes spawn arguments, Mongo lifecycle, listener binds,
// test assertions, deadlines or exit status. Observe every actual owned child.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), net = require('node:net'), http = require('node:http');
const directory = process.env.LPC_CI_JEST_OBSERVATION;
const allowed = path.resolve(__dirname, '../test-results/jest/shards') + path.sep;
if (process.env.NODE_ENV !== 'test' || !directory || !path.resolve(directory).startsWith(allowed)) throw Error('Owned CI Jest observation directory required.');
const write = (file, value) => fs.appendFileSync(path.join(directory, file + '.jsonl'), JSON.stringify({ at: new Date().toISOString(), observerPid: process.pid, ...value }) + '\n', { mode: 0o600 });
const spawn = cp.spawn;
cp.spawn = function(command, args, ...rest) {
  const child = spawn.call(this, command, args, ...rest);
  if (/(?:^|\/)mongod(?:-[^/]*)?$/.test(String(command))) {
    write('mongo', { phase: 'started', pid: child.pid, command, args });
    child.once('error', error => write('mongo', { phase: 'spawn-error', pid: child.pid, message: error.message, code: error.code }));
    child.once('exit', (code, signal) => write('mongo', { phase: 'exit', pid: child.pid, code, signal }));
    child.once('close', (code, signal) => write('mongo', { phase: 'closed', pid: child.pid, code, signal }));
  }
  return child;
};
let id = 0;
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  if (this instanceof http.Server) {
    const listenerId = ++id;
    this.once('listening', () => write('http', { phase: 'listening', pid: process.pid, id: listenerId, address: this.address() }));
    this.once('close', () => write('http', { phase: 'closed', pid: process.pid, id: listenerId }));
  }
  return listen.apply(this, args);
};
