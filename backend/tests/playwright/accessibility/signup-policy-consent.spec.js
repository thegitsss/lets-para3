const { test, expect } = require("playwright/test");
test("signup uses the bottom Terms and Privacy notice and requires current policy hashes", async ({ page }) => {
  const documents = {
    terms: { hash: "a".repeat(64), version: "2026-10-01", url: "/api/auth/legal/documents/terms/" + "a".repeat(64) },
    privacy: { hash: "b".repeat(64), version: "2026-10-01", url: "/api/auth/legal/documents/privacy/" + "b".repeat(64) },
  };
  await page.route("https://challenges.cloudflare.com/**", route => route.abort());
  let attempts = 0;
  await page.route("**/api/auth/legal/current", route => ++attempts === 1 ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { documents } }));
  await page.goto("/signup.html");
  await page.locator("#fullName").fill("Synthetic Applicant");
  await page.locator("#email").fill("synthetic@example.test");
  await page.locator("#password").fill("Synthetic signup passphrase");
  await page.locator("#nextStepBtn").click();
  await expect(page.locator("#signupTerms, #signupPrivacy")).toHaveCount(0);
  await expect(page.locator("#signupPolicyReview")).toContainText("By selecting Submit registration");
  await expect(page.locator("#signupPolicyStatus")).toContainText("could not be loaded");
  expect(await page.evaluate(() => window.LPCSignupPolicy.read())).toBe(null);
  await page.locator("#signupPolicyReload").click();
  await expect.poll(() => page.evaluate(() => window.LPCSignupPolicy.read())).toEqual({ termsHash: documents.terms.hash, privacyHash: documents.privacy.hash });
  await expect(page.locator("#signupTermsLink")).toHaveAttribute("href", documents.terms.url);
  await expect(page.locator("#signupPrivacyLink")).toHaveAttribute("href", documents.privacy.url);
});
