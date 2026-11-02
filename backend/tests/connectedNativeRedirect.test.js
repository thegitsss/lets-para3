"use strict";
const path = require("node:path");
const loginReturn = require("../../frontend/assets/scripts/utils/login-return-target");
let nativeDestination;
const matter = "0123456789abcdef01234567", file = "1123456789abcdef01234567";
beforeAll(async () => { ({ nativeDestination } = await import(path.resolve(__dirname, "../../frontend/assets/scripts/connected-workspace/native-redirect.mjs"))); });
test.each(["attorney", "paralegal"])("preparation bookmarks preserve a valid Matter inside the current %s shell", role => {
  expect(nativeDestination("preparation", role, "?caseId=" + matter)).toBe(role === "attorney" ? "/attorney-v2.html#/matters/" + matter + "/work" : "/paralegal-v2.html#/matter/" + matter + "?tab=work");
});
test.each(["attorney", "paralegal"])("editor bookmarks preserve source selection and deliberate opening in the current %s shell", role => {
  const target = nativeDestination("editor", role, "?caseId=" + matter + "&fileId=" + file), query = new URLSearchParams(target.split("?")[1]);
  expect(query.get("fileId")).toBe(file); expect(query.get("editFile")).toBe(file);
  expect(target).toContain(role === "attorney" ? "/files?" : "&tab=files");
});
test("Clio callback state reaches Connections without allowing an arbitrary return destination", () => {
  const target = nativeDestination("clio", "attorney", "?connected=1&user_id=42&subject_url=" + encodeURIComponent("https://app.clio.com/nc/#/matters/123") + "&custom_action_nonce=synthetic-nonce&next=https://evil.test");
  const query = new URLSearchParams(target.split("?")[1]);
  expect(target).toMatch(/^\/attorney-v2\.html#\/settings\?/); expect(query.get("tab")).toBe("connections"); expect(query.get("custom_action_nonce")).toBe("synthetic-nonce"); expect(query.get("clio")).toBe("connected"); expect(query.has("next")).toBe(false);
});
test.each(["matching", "clio"])("an attorney-only %s bookmark cannot open a paralegal transfer or hiring workflow", kind => {
  expect(nativeDestination(kind, "paralegal", "?user_id=42&subject_url=synthetic&custom_action_nonce=synthetic")).toBe("/paralegal-v2.html#/home");
});
test("invalid Matter or file identifiers never enter a source route", () => {
  expect(nativeDestination("editor", "attorney", "?caseId=../../admin&fileId=" + file)).toBe("/attorney-v2.html#/matters");
  expect(nativeDestination("editor", "attorney", "?caseId=" + matter + "&fileId=https://evil.test")).toBe("/attorney-v2.html#/matters/" + matter + "/files");
});
test.each(["/matter-tools.html?caseId=" + matter, "/document-editor.html?caseId=" + matter + "&fileId=" + file])("sign-in retains authorized role-neutral compatibility destinations: %s", target => {
  expect(loginReturn.resolve(target, "attorney")).toBe(target); expect(loginReturn.resolve(target, "paralegal")).toBe(target);
});
test.each(["/clio-connect.html?connected=1", "/paralegal-match.html?caseId=" + matter])("sign-in preserves attorney-only compatibility links for attorneys: %s", target => {
  expect(loginReturn.resolve(target, "attorney")).toBe(target); expect(loginReturn.resolve(target, "paralegal")).toBe("");
});
test.each(["https://evil.test/matter-tools.html", "//evil.test/document-editor.html", "/\\evil.test/clio-connect.html", "/matter-tools.html\u0000", "/admin-dashboard.html"])("compatibility sign-in still rejects external and unauthorized targets: %s", target => {
  expect(loginReturn.resolve(target, "attorney")).toBe(""); expect(loginReturn.resolve(target, "paralegal")).toBe("");
});
