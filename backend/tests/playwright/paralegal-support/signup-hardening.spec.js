const { test, expect } = require("../support-session-fixture");
test.use({ storageState: { cookies: [], origins: [] } });

async function json(route, payload) {
  return route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
}

async function basicSignup(page) {
  await page.route("https://challenges.cloudflare.com/**", route => route.abort());
  await page.goto("/signup.html?role=paralegal");
  await page.locator("#fullName").fill("Audit Paralegal");
  await page.locator("#email").fill("audit-signup@example.com");
  await page.locator("#password").fill("A unique professional passphrase");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator("#signupState").selectOption("NY");
  await page.locator("#paralegalQualification").selectOption("law_firm_experience");
  await page.locator("#resumeUpload").setInputFiles({ name: "Resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
}

test("paralegal signup records exact experience and allows editing basics without losing documents", async ({ page }) => {
  await basicSignup(page);
  await expect(page.locator("#paralegalFeeDisclosure")).toBeVisible();
  await expect(page.locator("#paralegalExperience")).toHaveAttribute("type", "number");
  await page.locator("#paralegalExperience").fill("6");
  await page.getByRole("button", { name: "Edit basic information" }).click();
  await page.locator("#email").fill("corrected@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#paralegalExperience")).toHaveValue("6");
  await expect(page.locator("#paralegalQualification")).toHaveValue("law_firm_experience");
  expect(await page.locator("#resumeUpload").evaluate(input => input.files[0]?.name)).toBe("Resume.pdf");
});

for (const verification of [
  { emailVerified: true, verificationEmailStatus: "not_required", copy: "Your email is verified." },
  { emailVerified: false, verificationEmailStatus: "not_sent", copy: "Your application was received, but the verification email could not be sent." },
]) test(`signup confirmation respects verified=${verification.emailVerified} and provides appropriate recovery`, async ({ page }) => {
  let submitted = "";
  let resends = 0;
  await page.route("**/api/csrf", route => json(route, { csrfToken: "synthetic-csrf" }));
  await page.route("**/api/auth/register", route => { submitted = route.request().postData(); return json(route, verification); });
  await page.route("**/api/auth/resend-verification", route => { resends++; return json(route, { ok: true }); });
  await basicSignup(page);
  await expect(page.locator("#paralegalExperience")).toHaveAttribute("type", "number");
  await page.locator("#paralegalExperience").fill("6");
  await page.evaluate(() => {
    const input = document.createElement("input"); input.name = "cf-turnstile-response"; input.type = "hidden"; input.value = "synthetic-test-token"; document.querySelector("#signupForm").append(input);
  });
  await page.getByRole("button", { name: "Submit application", exact: true }).click();
  await expect(page.locator("#signupConfirmation")).toContainText(verification.copy);
  expect(submitted).toMatch(/name="yearsExperience"\r?\n\r?\n6/);
  const resend = page.getByRole("button", { name: "Resend verification email" });
  if (verification.emailVerified) await expect(resend).toBeHidden();
  else {
    await resend.click();
    await expect.poll(() => resends).toBe(1);
    await expect(resend).toBeDisabled();
  }
});
