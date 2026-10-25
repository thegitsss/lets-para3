"use strict";
const path = require("node:path");
let active;
// A single actual server owns its application imports and synthetic transports.
// Models deliberately retain identity across sequential servers on one replica.
module.exports = function acquire() {
  if (active) throw Error("An actual browser server module lease is already active");
  const backend = path.resolve(__dirname, "../..");
  const roots = ["routes", "services", "utils", "middleware", "jobs"].map(part => path.join(backend, part) + path.sep);
  const synthetic = new Set(["@aws-sdk/s3-request-presigner", "@aws-sdk/lib-storage"].map(name => require.resolve(name)));
  const owned = id => roots.some(root => id.startsWith(root)) || synthetic.has(id);
  const previous = new Map(Object.entries(require.cache).filter(([id]) => owned(id)));
  for (const id of previous.keys()) delete require.cache[id];
  const token = {}; active = token;
  let released = false;
  return function release() {
    if (released) return;
    if (active !== token) throw Error("The actual browser server lost its module lease");
    for (const id of Object.keys(require.cache)) if (owned(id)) delete require.cache[id];
    for (const [id, value] of previous) require.cache[id] = value;
    released = true; active = undefined;
  };
};
