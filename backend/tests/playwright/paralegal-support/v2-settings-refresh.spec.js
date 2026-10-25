const { test, expect } = require("../support-session-fixture");
const { json, installSettingsProjection } = require("./settings-fixtures");

for (const focusTiming of ["before", "during", "none"]) {
  test(`profile refresh preserves editing focus: ${focusTiming}`, async ({ page }) => {
    const state = await installSettingsProjection(page);
    await page.goto("/paralegal-v2.html#/settings?tab=profile");
    const outlet = page.locator("[data-v2-route-outlet]");
    const bio = page.getByLabel("Bio", { exact: true });
    await expect(page.getByRole('button', { name: 'Edit about', exact: true })).toBeVisible();
    await expect(outlet).not.toHaveAttribute("aria-busy", "true");
    if (focusTiming !== 'none') {
      await page.getByRole('button', { name: 'Edit about', exact: true }).click();
      await expect(bio).toBeFocused();
      if (focusTiming === 'during') await page.getByRole('heading', { name: 'Profile Settings', exact: true }).evaluate(node => { node.tabIndex = -1; node.focus(); });
    }
    const originalBio = focusTiming !== 'none' ? await bio.elementHandle() : null;
    const originalText = state.user.bio;

    let releaseRead;
    let readStarted = false;
    const pendingRead = new Promise(resolve => { releaseRead = resolve; });
    await page.route(/\/api\/users\/me(?:\?.*)?$/, async route => {
      if (route.request().method() !== "GET") return route.fallback();
      readStarted = true;
      await pendingRead;
      return json(route, state.user);
    });
    if (focusTiming === "before") await bio.focus();
    if (focusTiming === 'none') state.user.bio = "Profile updated in another session.";
    else state.user.practiceAreas = ['Litigation', 'Family Law'];
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:lifecycle-refresh", {
      detail: { sourceId: "settings-focus-regression" },
    })));
    await expect.poll(() => readStarted).toBe(true);
    await expect(outlet).toHaveAttribute("aria-busy", "true");
    if (focusTiming === "during") await bio.focus();
    releaseRead();
    await expect(outlet).not.toHaveAttribute("aria-busy", "true");

    if (focusTiming === "none") {
      await expect(page.getByRole('button', { name: 'Edit about', exact: true })).toContainText(state.user.bio);
      expect(state.profilePatches).toEqual([]);
      return;
    }

    // Replacing a focused control between focus and the first keystroke loses
    // the edit even though there is not yet a dirty field to protect.
    expect(await originalBio.evaluate(control => control.isConnected && document.activeElement === control)).toBe(true);
    await bio.press("ControlOrMeta+End");
    await page.keyboard.type(" Continued.");
    await expect(bio).toHaveValue(originalText + " Continued.");
    await bio.blur();
    expect(state.profilePatches).toEqual([]);
    // Saving this field must preserve the unrelated background update.
    await page.locator('.is-row-editing').getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => state.profilePatches.length).toBe(1);
    await expect(page.locator('[data-settings-feedback="profile"] .v2-settings-save-status').filter({ hasText: /^Changes saved$/ })).toBeVisible();
    expect(state.profilePatches).toEqual([{ bio: originalText + " Continued." }]);
    expect(state.user.bio).toBe(originalText + " Continued.");
    expect(state.user.practiceAreas).toEqual(['Litigation', 'Family Law']);

    // After editing, an ordinary authoritative refresh must still be applied.
    state.user.bio = "A later saved profile update.";
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:lifecycle-refresh", {
      detail: { sourceId: "settings-focus-regression-complete" },
    })));
    await expect(page.getByRole('button', { name: 'Edit about', exact: true })).toContainText(state.user.bio);
    expect(state.profilePatches).toHaveLength(1);
  });
}
