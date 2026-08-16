const { test, expect } = require("playwright/test");
const {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
} = require("../../../utils/legalDocuments");

test("legal re-acceptance requires both choices and submits the exact contract", async ({ page }) => {
  const user = {
    id: "64b000000000000000000001",
    email: "legal.acceptance@example.com",
    firstName: "Legal",
    lastName: "Acceptance",
    role: "attorney",
    status: "approved",
    legalAcceptanceRequired: true,
    legalAcceptance: {
      required: true,
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
    },
  };
  let submittedBody = null;

  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user }),
  }));
  await page.route("**/api/csrf", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ csrfToken: "legal-test-csrf" }),
  }));
  await page.route("**/api/account/legal-acceptance", async (route) => {
    submittedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        legalAcceptanceRequired: false,
        legalAcceptance: {
          required: false,
          termsVersion: CURRENT_TERMS_VERSION,
          privacyVersion: CURRENT_PRIVACY_VERSION,
        },
      }),
    });
  });

  await page.goto("/legal-acceptance.html", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("legal.acceptance@example.com")).toBeVisible();

  const continueButton = page.getByRole("button", { name: "Accept and continue" });
  await expect(continueButton).toBeDisabled();
  await page.getByLabel(/agree to the Terms of Service/i).check();
  await expect(continueButton).toBeDisabled();
  await page.getByLabel(/acknowledge that I have read the Privacy Policy/i).check();
  await expect(continueButton).toBeEnabled();

  await continueButton.click();
  await expect.poll(() => submittedBody).toEqual({
    termsAccepted: true,
    privacyAcknowledged: true,
  });
  await expect(page).toHaveURL(/dashboard-attorney\.html$/);
});
