"use strict";
const path = require("node:path");
let createConnectedApi;
const OWNER = "0123456789abcdef01234567", OTHER = "1123456789abcdef01234567";
const endpoint = "/api/matter-preparation/matters/2123456789abcdef01234567/jobs";
const currentUser = { id: OWNER, role: "attorney", status: "approved" };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let previousLocation;
beforeAll(async () => {
  previousLocation = global.location;
  global.location = { origin: "https://lpc.test" };
  ({ createConnectedApi } = await import(path.resolve(__dirname, "../../frontend/assets/scripts/connected-workspace/native-api.mjs")));
});
afterAll(() => { if (previousLocation === undefined) delete global.location; else global.location = previousLocation; });
function fixture(handler = () => ({ job: { id: "synthetic-job", status: "queued" } })) {
  const calls = [], lost = jest.fn(), controller = new AbortController();
  const state = { user: { ...currentUser }, csrf: "synthetic-first-csrf", calls, lost, controller };
  state.api = createConnectedApi({ ownerId: OWNER, role: "attorney", signal: controller.signal, onAccessLost: lost, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/auth/me") return Response.json({ user: state.user });
    if (url === "/api/csrf") return Response.json({ csrfToken: state.csrf });
    const result = await handler(url, options, state);
    return result instanceof Response ? result : Response.json(result);
  } });
  return state;
}
test("reads remain in the portal's owner and route scope with preflight and postflight verification", async () => {
  const state = fixture(() => ({ caseId: "synthetic-matter" }));
  expect(await state.api.read(endpoint)).toEqual({ caseId: "synthetic-matter" });
  expect(state.calls.map(row => row.url)).toEqual(["/api/auth/me", endpoint, "/api/auth/me"]);
  for (const { options } of state.calls) expect(options).toMatchObject({ credentials: "include", cache: "no-store", redirect: "error", headers: { "X-LPC-Owner-Id": OWNER } });
  expect(state.lost).not.toHaveBeenCalled();
});
test("writes use a fresh CSRF token and retain the caller's idempotent request payload", async () => {
  const state = fixture(), input = { requestId: "synthetic-request", fileIds: ["synthetic-source"] };
  await state.api.write(endpoint, input);
  expect(state.calls.map(row => row.url)).toEqual(["/api/auth/me", "/api/csrf", endpoint, "/api/auth/me"]);
  const sent = state.calls.find(row => row.url === endpoint);
  expect(JSON.parse(sent.options.body)).toEqual(input);
  expect(sent.options.headers).toMatchObject({ "X-CSRF-Token": state.csrf, "X-LPC-Owner-Id": OWNER, "Content-Type": "application/json" });
});
test.each([
  "https://evil.test/api/matter-preparation/jobs",
  "//evil.test/api/matter-preparation/jobs",
  "/api/payments/release",
  "/api/matter-preparation/../../payments/release",
  "/api/matter-preparation/%2e%2e/%2e%2e/payments/release",
  "/api/matter-preparation/../paralegal-matching/search",
  "/api/matter-preparation/\\payments",
])("a connected feature cannot escape its four API route families: %s", async value => {
  const state = fixture();
  await expect(state.api.write(value, {})).rejects.toThrow(/Invalid workspace request/);
  expect(state.calls).toEqual([]);
});
test.each([
  { id: OTHER }, { role: "paralegal" }, { status: "pending" }, { disabled: true }, { deleted: true },
])("an invalid preflight account stops every feature request: %j", async patch => {
  const state = fixture(); state.user = { ...currentUser, ...patch };
  await expect(state.api.read(endpoint)).rejects.toMatchObject({ code: "CONNECTED_ACCOUNT_CHANGED" });
  expect(state.calls.map(row => row.url)).toEqual(["/api/auth/me"]);
  expect(state.lost).toHaveBeenCalledTimes(1);
});
test("an already-disposed route performs no network request and does not sign out a replacement route", async () => {
  const state = fixture(); state.controller.abort();
  await expect(state.api.read(endpoint)).rejects.toMatchObject({ name: "AbortError" });
  expect(state.calls).toEqual([]); expect(state.lost).not.toHaveBeenCalled();
});
test("a provider ignoring cancellation cannot deliver its late payload after route disposal", async () => {
  const gate = deferred(), entered = deferred();
  const state = fixture(async () => { entered.resolve(); await gate.promise; return { privateText: "SYNTHETIC-LATE-TEXT" }; });
  const result = state.api.read(endpoint); await entered.promise; state.controller.abort(); gate.resolve();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(state.calls).toHaveLength(2); expect(state.lost).not.toHaveBeenCalled();
});
test("a changed account after a successful feature response cannot receive that result", async () => {
  const state = fixture((_url, _options, current) => { current.user = { ...currentUser, id: OTHER }; return { privateText: "SYNTHETIC-EARLIER-OWNER" }; });
  await expect(state.api.read(endpoint)).rejects.toMatchObject({ code: "CONNECTED_ACCOUNT_CHANGED" });
  expect(state.lost).toHaveBeenCalledTimes(1);
});
test("an unknown write acknowledgement is never retried automatically", async () => {
  const state = fixture(() => { throw new Error("Synthetic response was lost"); });
  await expect(state.api.write(endpoint, { requestId: "keep-this-identity" })).rejects.toThrow("response was lost");
  expect(state.calls.filter(row => row.url === endpoint)).toHaveLength(1);
  expect(state.lost).not.toHaveBeenCalled();
});
test("a missing CSRF token prevents mutation and a deliberate retry obtains a current token", async () => {
  const state = fixture(); state.csrf = "";
  await expect(state.api.write(endpoint, {})).rejects.toThrow(/Refresh your session/);
  expect(state.calls.filter(row => row.url === endpoint)).toHaveLength(0);
  state.csrf = "synthetic-current-csrf";
  await state.api.write(endpoint, {});
  expect(state.calls.filter(row => row.url === "/api/csrf")).toHaveLength(2);
  expect(state.calls.find(row => row.url === endpoint).options.headers["X-CSRF-Token"]).toBe("synthetic-current-csrf");
});
test("server account-change errors invalidate this route once and prohibit later requests", async () => {
  const state = fixture(() => Response.json({ code: "PREPARATION_ACCOUNT_CHANGED", error: "Account changed" }, { status: 403 }));
  await expect(state.api.read(endpoint)).rejects.toMatchObject({ status: 403, code: "PREPARATION_ACCOUNT_CHANGED" });
  await expect(state.api.read(endpoint)).rejects.toMatchObject({ name: "AbortError" });
  expect(state.lost).toHaveBeenCalledTimes(1);
  expect(state.calls.filter(row => row.url === endpoint)).toHaveLength(1);
});
test("a provider permission failure stays a recoverable section error rather than clearing the portal identity", async () => {
  const state = fixture(() => Response.json({ code: "PREPARATION_SOURCE_SECURITY", error: "Selected source unavailable" }, { status: 423 }));
  await expect(state.api.read(endpoint)).rejects.toMatchObject({ status: 423, code: "PREPARATION_SOURCE_SECURITY" });
  expect(state.lost).not.toHaveBeenCalled();
});
test.each([null, "not a job", []])("malformed successful responses are not accepted as working feature results: %j", async body => {
  const state = fixture(() => Response.json(body));
  await expect(state.api.read(endpoint)).rejects.toThrow(/could not be read/);
});
