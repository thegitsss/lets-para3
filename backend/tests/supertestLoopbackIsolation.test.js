const http = require("node:http");
const request = require("supertest");
const dns = require("node:dns");

const close = server => new Promise(resolve => server.listening ? server.close(resolve) : resolve());
const listen = (server, port, host) => new Promise(resolve => {
  const onError = error => resolve({ error: error.code });
  server.once("error", onError);
  server.listen(port, host, () => {
    server.off("error", onError);
    resolve({ address: server.address() });
  });
});

test("a listener setup failure immediately restores the DNS resolver", () => {
  const originalLookup = dns.lookup;
  const server = http.createServer();
  const spy = jest.spyOn(server, "listen").mockImplementation(() => { throw new Error("Synthetic listen failure"); });
  try {
    expect(() => request(server).get("/synthetic-listen-failure")).toThrow("Synthetic listen failure");
    expect(dns.lookup).toBe(originalLookup);
    expect(server.listening).toBe(false);
  } finally { spy.mockRestore(); }
});

test.each([
  ["127.0.0.1", 401], ["127.0.0.1", 400], ["::1", 401], ["::1", 400],
])("an unrelated %s listener cannot supply a synthetic %i response to the test", async (host, status) => {
  let intendedRequests = 0, competingRequests = 0;
  const intended = http.createServer((_req, res) => {
    intendedRequests += 1;
    res.setHeader("x-synthetic-listener", "intended");
    res.end("Synthetic intended response");
  });
  const competing = http.createServer((_req, res) => {
    competingRequests += 1;
    res.statusCode = status;
    res.setHeader("x-synthetic-listener", "competing");
    res.end("Synthetic competing response");
  });
  try {
    const originalLookup = dns.lookup;
    const pending = request(intended).get("/synthetic-listener-check");
    expect(dns.lookup).toBe(originalLookup);
    const port = intended.address().port;
    const binding = await listen(competing, port, host);
    const response = await pending;
    expect({ status: response.status, listener: response.headers["x-synthetic-listener"], intendedRequests, competingRequests })
      .toEqual({ status: 200, listener: "intended", intendedRequests: 1, competingRequests: 0 });
    if (binding.error) expect(binding.error).toBe("EADDRINUSE");
    else expect(binding.address).toMatchObject({ address: host, family: host.includes(":") ? "IPv6" : "IPv4", port });
  } finally {
    await close(intended);
    await close(competing);
  }
});

test("an explicitly started IPv6 loopback server receives its own request", async () => {
  const server = http.createServer((_req, res) => res.end("Synthetic IPv6 response"));
  const competing = http.createServer((_req, res) => res.end("Competing IPv6 response"));
  try {
    const { address } = await listen(server, 0, "::1");
    expect(address.family).toBe("IPv6");
    expect(await listen(competing, address.port, "::1")).toEqual({ error: "EADDRINUSE" });
    const response = await request(server).get("/synthetic-ipv6-check");
    expect(response.status).toBe(200);
    expect(response.text).toBe("Synthetic IPv6 response");
    expect(server.listening).toBe(true);
    expect(server.address()).toEqual(address);
  } finally { await close(server); await close(competing); }
});

test("an explicitly started loopback server remains owned by its caller", async () => {
  const server = http.createServer((_req, res) => res.end("Synthetic explicit server"));
  try {
    const { address } = await listen(server, 0, "127.0.0.1");
    const response = await request(server).get("/synthetic-explicit-check");
    expect(response.status).toBe(200);
    expect(response.text).toBe("Synthetic explicit server");
    expect(server.listening).toBe(true);
    expect(server.address()).toEqual(address);
    expect((await request(`http://127.0.0.1:${address.port}`).get("/synthetic-url-check")).text).toBe("Synthetic explicit server");
  } finally { await close(server); }
});
