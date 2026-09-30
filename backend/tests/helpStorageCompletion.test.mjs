import test from "node:test";
import assert from "node:assert/strict";
import { scopeHelpStorageToOwner, clearHelpStorage } from "../../frontend/assets/scripts/utils/help-storage.mjs";
const A = "111111111111111111111111", B = "222222222222222222222222";
class Storage {
  getItem(key) { return this[key] ?? null; }
  setItem(key, value) { this[key] = String(value); }
  removeItem(key) { delete this[key]; }
}
function fixture(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"), storage = new Storage();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "sessionStorage", previous); else delete globalThis.sessionStorage; });
  storage.setItem(`lpc:v2:help-draft:${A}`, JSON.stringify({ reporterId: A, summary: "Private draft", retryPayload: { requestId: "original-key" } }));
  storage.setItem(`incident-access:INC-20260909-000001`, JSON.stringify({ reporterId: A, reporterAccessToken: "private-a" }));
  storage.setItem("lpc_account_closure_result", "closure-proof"); storage.setItem("document-draft", "unsaved-pdf");
  return storage;
}
test("a verified replacement removes old Help data while preserving the new owner and unrelated drafts", t => {
  const storage = fixture(t); storage.setItem(`lpc:v2:help-draft:${B}`, JSON.stringify({ reporterId: B, summary: "New owner's draft" }));
  scopeHelpStorageToOwner(B);
  assert.equal(storage.getItem(`lpc:v2:help-draft:${A}`), null); assert.equal(storage.getItem("incident-access:INC-20260909-000001"), null);
  assert.equal(JSON.parse(storage.getItem(`lpc:v2:help-draft:${B}`)).summary, "New owner's draft");
  assert.equal(storage.getItem("lpc_account_closure_result"), "closure-proof"); assert.equal(storage.getItem("document-draft"), "unsaved-pdf");
});
test("same-owner session persistence retains an exact uncertain report and reporter access", t => {
  const storage = fixture(t), before = JSON.stringify(storage); scopeHelpStorageToOwner(A); assert.equal(JSON.stringify(storage), before);
});
test("partial or invalid identity snapshots do not erase recoverable Help data", t => {
  const storage = fixture(t), before = JSON.stringify(storage);
  for (const owner of [null, undefined, "", "not-an-owner", {}]) scopeHelpStorageToOwner(owner);
  assert.equal(JSON.stringify(storage), before);
});
test("unattributed legacy tokens and mismatched draft envelopes are removed without inventing ownership", t => {
  const storage = fixture(t); storage.setItem("incident-access:INC-20260909-000002", JSON.stringify({ reporterAccessToken: "unstamped" }));
  storage.setItem(`lpc:v2:help-draft:${B}`, JSON.stringify({ reporterId: A })); storage.setItem("incident-access:broken", "{");
  scopeHelpStorageToOwner(A);
  assert.equal(storage.getItem("incident-access:INC-20260909-000002"), null); assert.equal(storage.getItem(`lpc:v2:help-draft:${B}`), null); assert.equal(storage.getItem("incident-access:broken"), null);
  assert.notEqual(storage.getItem(`lpc:v2:help-draft:${A}`), null);
});
test("definite session loss clears only Help drafts and access entries", t => {
  const storage = fixture(t); clearHelpStorage();
  assert.deepEqual(Object.keys(storage).sort(), ["document-draft", "lpc_account_closure_result"]);
});
test("storage failures do not throw or prevent independent Help entry cleanup", t => {
  const storage = fixture(t), remove = storage.removeItem.bind(storage);
  storage.removeItem = key => { if (key.startsWith("lpc:v2:help-draft:")) throw new Error("Unavailable"); remove(key); };
  assert.doesNotThrow(() => clearHelpStorage()); assert.equal(storage.getItem("incident-access:INC-20260909-000001"), null);
});
