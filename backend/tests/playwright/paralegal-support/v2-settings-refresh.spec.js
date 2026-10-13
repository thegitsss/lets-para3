const { test, expect } = require("../support-session-fixture");
const { json, installSettingsProjection } = require("./settings-fixtures");

for (const focusTiming of ["before", "during", "none"]) {
  test(`profile refresh preserves editing focus: ${focusTiming}`, async ({ page }) => {
    const state = await installSettingsProjection(page);
    await page.goto("/paralegal-v2.html#/settings?tab=profile");
    const outlet = page.locator("[data-v2-route-outlet]");
    const phone = page.getByLabel("Phone", { exact: true });
    await expect(phone).toBeVisible();
    await expect(outlet).not.toHaveAttribute("aria-busy", "true");
    const originalPhone = await phone.elementHandle();

    let releaseRead;
    let readStarted = false;
    const pendingRead = new Promise(resolve => { releaseRead = resolve; });
    await page.route(/\/api\/users\/me(?:\?.*)?$/, async route => {
      if (route.request().method() !== "GET") return route.fallback();
      readStarted = true;
      await pendingRead;
      return json(route, state.user);
    });
    if (focusTiming === "before") await phone.focus();
    state.user.bio = "Profile updated in another session.";
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:lifecycle-refresh", {
      detail: { sourceId: "settings-focus-regression" },
    })));
    await expect.poll(() => readStarted).toBe(true);
    await expect(outlet).toHaveAttribute("aria-busy", "true");
    if (focusTiming === "during") await phone.focus();
    releaseRead();
    await expect(outlet).not.toHaveAttribute("aria-busy", "true");

    if (focusTiming === "none") {
      await expect(page.getByLabel("Bio", { exact: true })).toHaveValue(state.user.bio);
      expect(state.profilePatches).toEqual([]);
      return;
    }

    // Replacing a focused control between focus and the first keystroke loses
    // the edit even though there is not yet a dirty field to protect.
    expect(await originalPhone.evaluate(control => control.isConnected && document.activeElement === control)).toBe(true);
    await phone.press("End");
    await page.keyboard.type("9");
    await expect(phone).toHaveValue("212-555-01429");
    await phone.blur();
    await expect.poll(() => state.profilePatches.length).toBe(1);
    await expect(page.locator('[data-settings-feedback="profile"] .v2-settings-save-status').filter({ hasText: /^Changes saved$/ })).toBeVisible();
    expect(state.profilePatches).toEqual([{ phoneNumber: "212-555-01429" }]);
    expect(state.user.bio).toBe("Profile updated in another session.");

    // After editing, an ordinary authoritative refresh must still be applied.
    state.user.bio = "A later saved profile update.";
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:lifecycle-refresh", {
      detail: { sourceId: "settings-focus-regression-complete" },
    })));
    await expect(page.getByLabel("Bio", { exact: true })).toHaveValue(state.user.bio);
    await expect(phone).toHaveValue("212-555-01429");
    expect(state.profilePatches).toHaveLength(1);
  });
}
