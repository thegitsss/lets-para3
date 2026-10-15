"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const acquire = require("./financialLifecycleModuleLease");
const emailId = require.resolve("../../utils/email");
const serviceId = require.resolve("../../services/support/adminInboxService");
const modelId = require.resolve("../../models/User");
const put = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports, children: [] }; };

test("sequential actual-service imports use the current synthetic mail sink and preserve model identity", async () => {
  const model = require(modelId), previousEmail = require.cache[emailId], previousService = require.cache[serviceId];
  const first = [], second = [];
  const dependency = () => require.cache[serviceId].children.find(entry => entry.id === emailId).exports;
  let release;
  try {
    release = acquire(); put(emailId, async message => first.push(message)); require(serviceId);
    await dependency()("first owned server"); assert.equal(require(modelId), model); release();
    release = acquire(); put(emailId, async message => second.push(message)); require(serviceId);
    await dependency()("second owned server"); assert.equal(require(modelId), model); release();
    assert.deepEqual(first, ["first owned server"]); assert.deepEqual(second, ["second owned server"]);
    assert.equal(require.cache[emailId], previousEmail); assert.equal(require.cache[serviceId], previousService);
  } finally { release?.(); }
});

test("overlapping browser server imports cannot replace an active server's transports", () => {
  const release = acquire();
  try { assert.throws(() => acquire(), /module lease is already active/); } finally { release(); }
  const next = acquire(); next();
});

test("release is idempotent and restores existing modules after a failed registration", () => {
  const previous = require.cache[emailId], release = acquire();
  put(emailId, async () => { throw Error("synthetic registration premise"); });
  release(); release(); assert.equal(require.cache[emailId], previous);
  const next = acquire(); next();
});
