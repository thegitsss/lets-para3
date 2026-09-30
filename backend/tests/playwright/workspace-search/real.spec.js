const { test: base, expect } = require("playwright/test");
const fs = require("node:fs/promises");
const startServer = require("./real-server");
const test = base.extend({ real: [async ({}, use) => { const server = await startServer(); try { await use(server); } finally { await server.close(); } }, { scope: "worker", timeout: 150000 }] });
test.beforeEach(async ({ context, real }) => {
  await context.route("**/*", route => new URL(route.request().url()).origin === real.origin ? route.continue() : route.abort("blockedbyclient"));
});
async function enter(page, context, real, account, role) {
  await context.addCookies([account.cookie]); await page.goto(`${real.origin}/${role}-v2.html#/help`);
  await expect(page.locator(role === "attorney" ? "html" : "body")).toHaveAttribute(role === "attorney" ? "data-attorney-state" : "data-v2-session", "ready");
  if (role === "attorney") await page.getByRole("button", { name: "Search your workspace", exact: true }).click();
  else await page.keyboard.press("ControlOrMeta+KeyK");
  const input = page.locator(role === "attorney" ? "#av2-query" : "[data-v2-search-input]");
  const panel = page.locator(role === "attorney" ? '[data-av2-panel="search"]' : "[data-v2-search-panel]");
  await expect(input).toBeFocused(); return { input, panel };
}
async function search(input, panel) {
  await input.fill("Evergreen Research"); await input.press("Enter");
  await expect(panel.locator('[data-v2-search-kind="matter"]')).toHaveCount(6);
}
async function focusGeometry(input, info, role, step) {
  const geometry = await input.evaluate(element => {
    const measure = target => {
      const rect = target.getBoundingClientRect(); let top = 0, bottom = innerHeight;
      for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) {
          const clip = parent.getBoundingClientRect(); top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
        }
      }
      return { top: rect.top, bottom: rect.bottom, clipTop: top, clipBottom: bottom, visible: rect.top >= top - 1 && rect.bottom <= bottom + 1 };
    };
    const option = document.getElementById(element.getAttribute("aria-activedescendant"));
    return { input: measure(element), option: option ? measure(option) : null, inputOwnsFocus: document.activeElement === element };
  });
  await fs.writeFile(info.outputPath(`${role}-${step}-focus-geometry.json`), JSON.stringify(geometry, null, 2));
  expect(geometry.inputOwnsFocus).toBe(true); expect(geometry.input.visible).toBe(true); expect(geometry.option?.visible).toBe(true);
}
for (const role of ["attorney", "paralegal"]) {
  test(`${role}: actual old exact result, permitted groups, exact V2 links and persistent keyboard choices`, async ({ page, context, real }, info) => {
    const seed = await real.reset(role); const { input, panel } = await enter(page, context, real, seed.owner, role); await search(input, panel);
    const first = panel.locator('[data-v2-search-kind="matter"]').first(); await expect(first.locator("strong")).toHaveText("Evergreen Research");
    await expect(first).toHaveAttribute("href", role === "attorney" ? `/attorney-v2.html#/matters/${seed.exactId}/overview` : `/paralegal-v2.html#/matter/${seed.exactId}?tab=overview`);
    if (role === "attorney") {
      await expect(panel.locator('[data-v2-search-kind="profile"]')).toHaveCount(6);
      await expect(panel.locator('[data-v2-search-kind="profile"]').first()).toHaveAttribute("href", `/attorney-v2.html#/paralegals/${seed.profileId}`);
    } else {
      await expect(panel.locator('[data-v2-search-kind="profile"]')).toHaveCount(0);
      await expect(panel.getByRole("option", { name: /Evergreen Research opportunity/ })).toHaveAttribute("href", `/paralegal-v2.html#/browse?matterId=${seed.discoveryId}`);
    }
    await expect(panel).not.toContainText(/PRIVATE_|pi_|storage-key/);
    await input.press("ArrowDown"); await expect(first).toHaveAttribute("aria-selected", "true");
    const active = await input.getAttribute("aria-activedescendant"); await expect(first).toHaveAttribute("id", active);
    await input.press("End"); await expect(panel.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
    await focusGeometry(input, info, role, "end");
    await input.press("Home"); await expect(first).toHaveAttribute("aria-selected", "true"); await expect(input).toBeFocused();
    await focusGeometry(input, info, role, "home");
    const evidence = await real.evidence(); expect(evidence.unknownAncillaryApi).toEqual([]);
    expect(evidence.requests.filter(row => row.path === "/api/cases/search").every(row => row.query.expectedOwnerId === seed.owner.id)).toBe(true);
    await fs.writeFile(info.outputPath(`${role}-real-search.json`), JSON.stringify({ exactId: seed.exactId, discoveryId: seed.discoveryId, profileId: seed.profileId, matchedMatterCount: 6, permittedProfileCount: role === "attorney" ? 6 : 0, keyboardActive: active, ...evidence }, null, 2));
    await page.screenshot({ path: info.outputPath(`${role}-real-search.png`), fullPage: true });
  });

  test(`${role}: actual source failure clears old results and deliberate retry restores authorized suggestions`, async ({ page, context, real }, info) => {
    const seed = await real.reset(role); const { input, panel } = await enter(page, context, real, seed.owner, role); await search(input, panel);
    real.state.failSource = true; await input.press("Enter");
    await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(panel.locator('[data-v2-search-kind="matter"]')).toHaveCount(0); await expect(panel).not.toContainText("No results.");
    await panel.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(panel.locator('[data-v2-search-kind="matter"]')).toHaveCount(6); await expect(input).toBeFocused();
    await fs.writeFile(info.outputPath(`${role}-real-failure-retry.json`), JSON.stringify({ sourceFailureInjectedAtModel: true, oldRecordsCleared: true, explicitRetrySucceeded: true, ...await real.evidence() }, null, 2));
  });

  test(`${role}: account replacement during an actual search discards its response and protects the new request`, async ({ page, context, real }, info) => {
    const seed = await real.reset(role); const { input, panel } = await enter(page, context, real, seed.owner, role); const gate = real.holdNext("/api/cases/search");
    try { await input.fill("Evergreen Research"); await input.press("Enter"); await expect.poll(() => gate.arrived).toBe(true); await context.addCookies([seed.other.cookie]); }
    finally { gate.release(); }
    await expect(page).toHaveURL(/\/login\.html/); await expect(panel).toHaveCount(0); await expect(page.getByText("Evergreen Research", { exact: true })).toHaveCount(0);
    const guarded = await context.request.get(`${real.origin}/api/cases/search?q=Evergreen&expectedOwnerId=${seed.owner.id}`);
    expect(guarded.status()).toBe(403); expect((await guarded.json()).code).toBe("ACCOUNT_CHANGED");
    await fs.writeFile(info.outputPath(`${role}-real-owner-change.json`), JSON.stringify({ oldResponseDiscarded: true, guardedStatus: guarded.status(), protectedDomCleared: true }, null, 2));
  });

  test(`${role}: revoked managed session clears existing search content on the next read`, async ({ page, context, real }, info) => {
    const seed = await real.reset(role); const { input, panel } = await enter(page, context, real, seed.owner, role); await search(input, panel);
    await real.revoke(seed.owner); await input.press("Enter");
    await expect(page).toHaveURL(/\/login\.html/); await expect(panel).toHaveCount(0);
    await expect(page.getByText("Evergreen Research", { exact: true })).toHaveCount(0);
    await fs.writeFile(info.outputPath(`${role}-real-revocation.json`), JSON.stringify({ actualAuthSessionRevoked: true, protectedDomCleared: true }, null, 2));
  });
}
