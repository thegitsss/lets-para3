"use strict";
// Old bookmark/provider callback pages now enter the existing native portals.
// Functional journeys live in native-*.spec.js.
const { test, expect } = require("playwright/test");
const { installNativeFixture, MATTER, FILE } = require("./native-fixture.cjs");
const origin = "http://127.0.0.1:19076";
for (const [entry, expected, role] of [
  ["/matter-tools.html?caseId=" + MATTER, "/attorney-v2.html#/matters/" + MATTER + "/work", "attorney"],
  ["/matter-tools.html?caseId=" + MATTER, "/paralegal-v2.html#/matter/" + MATTER + "?tab=work", "paralegal"],
  ["/document-editor.html?caseId=" + MATTER + "&fileId=" + FILE, "/attorney-v2.html#/matters/" + MATTER + "/files?fileId=" + FILE + "&editFile=" + FILE, "attorney"],
  ["/document-editor.html?caseId=" + MATTER + "&fileId=" + FILE, "/paralegal-v2.html#/matter/" + MATTER + "?fileId=" + FILE + "&editFile=" + FILE + "&tab=files", "paralegal"],
  ["/paralegal-match.html?caseId=" + MATTER, "/attorney-v2.html#/paralegals?match=work&caseId=" + MATTER, "attorney"],
  ["/clio-connect.html?connected=1", "/attorney-v2.html#/settings?tab=connections&clio=connected", "attorney"],
]) {
  test("compatibility bookmark opens the native " + role + " portal: " + entry, async ({ page }) => {
    const state = await installNativeFixture(page, { role, origin });
    await page.goto(entry);
    await expect.poll(() => page.url()).toContain(origin + expected);
    await page.locator("[data-lpc-boot-screen][open]").waitFor({ state: "detached", timeout: 15000 });
    expect(new URL(page.url()).pathname).toBe(role === "attorney" ? "/attorney-v2.html" : "/paralegal-v2.html");
    expect(state.pageErrors).toEqual([]);
  });
}
test("a signed-out compatibility bookmark retains its exact local destination through sign-in", async ({ page }) => {
  await installNativeFixture(page, { origin, resolve(call) { if (call.path === "/api/auth/me") return { statusCode: 401, body: { error: "Synthetic signed-out session" } }; } });
  const entry = "/document-editor.html?caseId=" + MATTER + "&fileId=" + FILE;
  await page.goto(entry);
  await expect(page).toHaveURL(origin + "/login.html?next=" + encodeURIComponent(entry));
});
test("a paralegal cannot enter the attorney matching workflow through an old link", async ({ page }) => {
  await installNativeFixture(page, { role: "paralegal", origin });
  await page.goto("/paralegal-match.html?caseId=" + MATTER);
  await expect(page).toHaveURL(origin + "/paralegal-v2.html#/home");
  await expect(page.locator("[data-native-matching]")).toHaveCount(0);
});
