const patched = Symbol.for("lpc.tests.supertest.loopback");
const dns = require("node:dns");

function listenOnLoopback(app) {
  const originalLookup = dns.lookup;
  try {
    // Node resolves even numeric listen hosts asynchronously. Supertest needs
    // its port synchronously. Resolve only this literal address during listen,
    // and restore DNS before any event-loop callback or test request can run.
    dns.lookup = function lookup(host, options, callback) {
      if (host !== "127.0.0.1") return Reflect.apply(originalLookup, this, arguments);
      if (typeof options === "function") { callback = options; options = {}; }
      if (options?.all) callback(null, [{ address: host, family: 4 }]);
      else callback(null, host, 4);
    };
    return app.listen({ port: 0, host: "127.0.0.1", exclusive: true });
  } finally { dns.lookup = originalLookup; }
}

function isolateSupertestLoopback() {
  const { Test } = require("supertest");
  if (Test.prototype[patched]) return;
  const original = Test.prototype.serverAddress;
  if (typeof original !== "function") throw new Error("Supertest listener setup is unavailable.");

  // A wildcard listener can share its port with a specific-address listener
  // on macOS. Reserve the exact loopback endpoint that the client will use.
  // Existing caller-owned servers and explicit URLs retain their ownership.
  Test.prototype.serverAddress = function serverAddress(app, pathname) {
    if (!app.address()) this._server = listenOnLoopback(app);
    const bound = app.address();
    if (!bound || !["127.0.0.1", "::1"].includes(bound.address)) {
      throw new Error("Bind caller-owned test servers to an explicit loopback address.");
    }
    const address = new URL(original.call(this, app, pathname));
    if (bound.family === "IPv6") address.hostname = "[::1]";
    return address.href;
  };
  Object.defineProperty(Test.prototype, patched, { value: true });
}

module.exports = { isolateSupertestLoopback };
