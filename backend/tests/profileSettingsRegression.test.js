const fs = require("fs");
const path = require("path");

describe("profile settings preferences save regression", () => {
  test("preferences save handler posts to the account preferences endpoint", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/profile-settings.js"),
      "utf8"
    );

    expect(source).toContain('fetch("/api/account/preferences", {');
    expect(source).not.toContain("LPC-INCIDENT-TEST: intentional preferences save regression marker.");
    expect(source).toContain("showToast(\"Preferences saved\", \"ok\")");
  });

  test("attorney save normalizes URL fields and preserves API errors", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/profile-settings.js"),
      "utf8"
    );

    expect(source).toContain("function normalizeHttpUrlInput");
    expect(source).toContain('requiredHost: "linkedin.com"');
    expect(source).toContain('showToast(err?.message || "Unable to save profile right now.", "err")');
  });

  test("attorney onboarding payment copy points to billing instead of Stripe setup jargon", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/profile-settings.js"),
      "utf8"
    );

    expect(source).toContain('billingBtn.textContent = "Open Billing"');
    expect(source).toContain("Add a payment method so you can fund matters when you're ready.");
    expect(source).toContain('"Add Payment Method"');
    expect(source).not.toContain("Go to Billing & Add Card");
    expect(source).not.toContain("Set up payments for Stripe.");
    expect(source).not.toContain('"Set Up Payments"');
  });

  test("attorney onboarding step one treats saved professional profile details as complete", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../frontend/assets/scripts/attorney-tabs.js"),
      "utf8"
    );
    const match = source.match(/function isAttorneyProfileComplete\(user = \{\}\) \{[\s\S]*?\n\}/);

    expect(match).toBeTruthy();

    const isAttorneyProfileComplete = new Function(`${match[0]}; return isAttorneyProfileComplete;`)();

    expect(isAttorneyProfileComplete({ lawFirm: "Sider Legal" })).toBe(true);
    expect(isAttorneyProfileComplete({ firmWebsite: "https://example.com" })).toBe(true);
    expect(isAttorneyProfileComplete({ linkedInURL: "https://linkedin.com/in/example" })).toBe(true);
    expect(isAttorneyProfileComplete({ practiceDescription: "Civil litigation support." })).toBe(true);
    expect(isAttorneyProfileComplete({ practiceAreas: ["Litigation"] })).toBe(true);
    expect(isAttorneyProfileComplete({ publications: ["Panel on discovery practice"] })).toBe(true);
    expect(isAttorneyProfileComplete({})).toBe(false);
    expect(isAttorneyProfileComplete({ practiceAreas: ["   "], publications: [""] })).toBe(false);
  });
});
