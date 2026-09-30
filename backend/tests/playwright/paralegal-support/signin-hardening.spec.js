const { test, expect } = require("../support-session-fixture");
test.use({ storageState: { cookies: [], origins: [] } });
const MATTER = "64b000000000000000000991";

test("expired legacy Matter link survives password sign-in and is carried into Google sign-in", async ({ page }) => {
  let signedIn = false;
  const user = { id: "64b000000000000000000001", role: "paralegal", status: "approved", firstName: "Return", lastName: "User", emailVerified: true };
  await page.route("**/api/auth/me", route => route.fulfill({ status: signedIn ? 200 : 401, contentType: "application/json", body: JSON.stringify(signedIn ? { user } : { error: "Unauthorized" }) }));
  await page.route("**/api/csrf", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ csrfToken: "synthetic-csrf" }) }));
  await page.route("**/api/auth/login", route => { signedIn = true; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ user }) }); });
  const target = `/case-detail.html?caseId=${MATTER}&tab=messages`;
  await page.goto(target);
  await expect(page).toHaveURL(/login\.html\?next=/);
  expect(new URL(page.url()).searchParams.get("next")).toBe(target);
  await expect(page.locator('a[href^="/api/auth/google"]')).toHaveAttribute("href", `/api/auth/google?intent=login&next=${encodeURIComponent(target)}`);
  await page.locator("#email").fill("return@example.com");
  await page.locator("#password").fill("A unique account passphrase");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`case-detail\\.html\\?caseId=${MATTER}&tab=messages$`));
});
