import test from "node:test";
import assert from "node:assert/strict";
import { createHelpApi } from "../../frontend/assets/scripts/utils/help-api.mjs";

const OWNER = "111111111111111111111111", OTHER = "222222222222222222222222";
const payload = { reporterId: OWNER, requestId: "c4e3d7bd-5c08-4afd-9dc3-1e4c1647db49", summary: "A page did not update", description: "The saved change was not visible." };
const receipt = { ok: true, incident: { publicId: "INC-20260909-000204" }, reporterAccessToken: "synthetic-access" };
function fixture() {
  const state = { owner: OWNER, reads: [], writes: [], verified: 0, lost: 0, verify: null, response: null, csrf: { csrfToken: "synthetic-csrf" }, context: 0 };
  const api = createHelpApi({
    api: { async get(path) { state.reads.push(path); if (state.csrf instanceof Error) throw state.csrf; return state.csrf; } },
    getIdentity: () => ({ id: state.owner }), onSessionLost: () => { state.lost++; },
    verifySession: async () => { state.verified++; return state.verify ? state.verify(state.verified) : { state: "ready", identity: { id: state.owner } }; },
    readMatterContext: async () => { state.context++; },
    fetchImpl: async (path, options) => { state.writes.push({ path, ...options }); return state.response ? state.response() : { ok: true, status: 201, json: async () => receipt }; },
  });
  return { api, state };
}
test("Help verifies the owner around one CSRF-bound write and preserves the request key", async () => {
  const { api, state } = fixture();
  assert.deepEqual(await api.post("/api/incidents", payload), receipt);
  assert.equal(state.verified, 2); assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].headers["X-CSRF-Token"], "synthetic-csrf");
  assert.deepEqual(JSON.parse(state.writes[0].body), payload);
});
test("Help rejects replacement ownership before any write", async () => {
  const { api, state } = fixture(); state.verify = () => ({ state: "ready", identity: { id: OTHER } });
  await assert.rejects(api.post("/api/incidents", payload), error => error.authentication && !error.dispatched);
  assert.equal(state.writes.length, 0); assert.equal(state.lost, 1);
});
test("Help does not release a receipt after account replacement", async () => {
  const { api, state } = fixture(); state.verify = count => ({ state: "ready", identity: { id: count === 1 ? OWNER : OTHER } });
  await assert.rejects(api.post("/api/incidents", payload), error => error.authentication && error.dispatched);
  assert.equal(state.writes.length, 1); assert.equal(state.lost, 1);
});
test("Help distinguishes an unavailable CSRF read from an uncertain dispatched request", async () => {
  const { api, state } = fixture(); state.csrf = new Error("private transport details");
  await assert.rejects(api.post("/api/incidents", payload), error => error.dispatched === false && !error.message.includes("private"));
  assert.equal(state.writes.length, 0);
});
test("Help retains uncertainty when the post-ack owner check is unavailable", async () => {
  const { api, state } = fixture(); state.verify = count => { if (count === 2) throw new Error("read failed"); return { state: "ready", identity: { id: OWNER } }; };
  await assert.rejects(api.post("/api/incidents", payload), error => error.dispatched === true && !error.authentication);
  assert.equal(state.writes.length, 1); assert.equal(state.lost, 0);
});
test("Help rejects incomplete receipts and does not retry a lost response automatically", async () => {
  for (const response of [() => ({ ok: true, status: 200, json: async () => ({ ok: true, incident: { publicId: "wrong" } }) }), () => { throw new Error("connection lost"); }]) {
    const { api, state } = fixture(); state.response = response;
    await assert.rejects(api.post("/api/incidents", payload), error => error.dispatched === true);
    assert.equal(state.writes.length, 1);
  }
});
test("Help checks a new Matter reference but preserves the original reference during keyed recovery", async () => {
  const { api, state } = fixture(); const report = { ...payload, caseId: OTHER };
  await api.post("/api/incidents", report); await api.post("/api/incidents", report, { recovery: true });
  assert.equal(state.context, 1); assert.equal(state.writes.length, 2);
  assert.deepEqual(JSON.parse(state.writes[1].body), report);
});
test("Help accepts only bounded field validation and never exposes arbitrary server diagnostics", async () => {
  const { api, state } = fixture();
  state.response = () => ({ ok: false, status: 422, json: async () => ({ error: "private diagnostics", fields: { summary: "Add the affected section.", diagnostic: "secret", description: 123 } }) });
  await assert.rejects(api.post("/api/incidents", payload), error => {
    assert.deepEqual(error.payload.fields, { summary: "Add the affected section." });
    return error.status === 422 && !error.message.includes("private");
  });
});

const failedSubmissions = [
  ["generic CSRF refusal", () => ({ ok: false, status: 403, json: async () => ({ code: "CSRF_INVALID" }) })],
  ["malformed receipt", () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })],
  ["lost transport", () => { throw new Error("Connection lost"); }],
];
for (const [kind, response] of failedSubmissions) {
  test(`Help detects post-dispatch account replacement after ${kind}`, async () => {
    const { api, state } = fixture(); state.response = response;
    state.verify = count => ({ state: "ready", identity: { id: count === 1 ? OWNER : OTHER } });
    await assert.rejects(api.post("/api/incidents", payload), error => error.authentication === true && error.dispatched === true);
    assert.equal(state.lost, 1); assert.equal(state.writes.length, 1);
  });
}
test("a failed submission from the same owner retains uncertainty without another write or logout", async () => {
  for (const [, response] of failedSubmissions) {
    const { api, state } = fixture(); state.response = response;
    await assert.rejects(api.post("/api/incidents", payload), error => error.dispatched === true && !error.authentication);
    assert.equal(state.lost, 0); assert.equal(state.writes.length, 1);
  }
});
test("unavailable ownership verification after a failed submission cannot erase the original report", async () => {
  for (const [, response] of failedSubmissions) {
    const { api, state } = fixture(); state.response = response;
    state.verify = count => { if (count > 1) throw new Error("Verification unavailable"); return { state: "ready", identity: { id: OWNER } }; };
    await assert.rejects(api.post("/api/incidents", payload), error => error.dispatched === true && !error.authentication);
    assert.equal(state.lost, 0); assert.equal(state.writes.length, 1);
  }
});
