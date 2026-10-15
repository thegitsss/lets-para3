const { test, expect } = require("playwright/test");

test("signup still requires distinct Terms and Privacy choices", async ({ page }) => {
  const documents = {
    terms: { hash: "a".repeat(64), version: "2026-10-01", url: "/api/auth/legal/documents/terms/" + "a".repeat(64) },
    privacy: { hash: "b".repeat(64), version: "2026-10-01", url: "/api/auth/legal/documents/privacy/" + "b".repeat(64) },
  };
  await page.route("https://challenges.cloudflare.com/**", route => route.abort());
  await page.route("**/api/auth/legal/current", route => route.fulfill({ json: { documents } }));
  await page.goto("/signup.html");
  await page.locator("#fullName").fill("Synthetic Applicant");
  await page.locator("#email").fill("synthetic@example.test");
  await page.locator("#password").fill("Synthetic signup passphrase");
  await page.locator("#nextStepBtn").click();
  await expect(page.locator("#signupTerms")).toBeEnabled();
  expect(await page.evaluate(() => window.LPCSignupPolicy.read())).toBe(null);
  await page.locator("#signupTerms").check();
  expect(await page.evaluate(() => window.LPCSignupPolicy.read())).toBe(null);
  await page.locator("#signupPrivacy").check();
  expect(await page.evaluate(() => window.LPCSignupPolicy.read())).toEqual({ termsHash: documents.terms.hash, privacyHash: documents.privacy.hash });
});
