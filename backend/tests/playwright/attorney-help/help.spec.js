const { expect } = require("playwright/test");
const { test } = require("./shell-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const OWNER = "111111111111111111111111", OTHER = "222222222222222222222222", MATTER = "333333333333333333333333", PROFILE = "444444444444444444444444";
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const matter = (title = "Litigation review") => ({ type: "matter", id: MATTER, title, practiceArea: "Litigation", status: { code: "open", label: "Posted" }, relationship: { code: "owner", label: "Your matter" }, attention: null, nextAction: { label: "Open Matter", href: `/case-detail.html?caseId=${MATTER}` } });
const profile = () => ({ type: "profile", id: PROFILE, title: "Amélie Rivera", headline: "Litigation", location: "New York", practiceAreas: ["Litigation"], nextAction: { label: "View profile", href: `/profile-paralegal.html?paralegalId=${PROFILE}` } });
const workspaceMatter = () => ({ _id: MATTER, title: "Litigation review", status: "open", tasks: [], matterExperience: { version: 1, header: { relationship: "Matter owner", status: "Posted" }, sections: ["overview", "applications", "work", "files", "messages", "deadlines", "activity", "financials"].map(id => ({ id })), overview: {}, work: {}, activity: [] } });
const report = { summary: "Matter page did not update", description: "After saving a date the page still showed the earlier date." };
const success = { ok: true, incident: { publicId: "INC-20260909-000204", userVisibleStatus: "received" }, reporterAccessToken: "synthetic-help-token" };
const fields = page => ({ summary: page.getByLabel("Short summary", { exact: true }), description: page.getByLabel("What happened?", { exact: true }), submit: page.locator(".v2-help-submit"), status: page.locator(".v2-help-report-status") });
async function fill(page, values = report) { const f = fields(page); await f.summary.fill(values.summary); await f.description.fill(values.description); return f; }
async function routeTo(page, hash) { await page.evaluate(value => { location.hash = value; }, hash); await expect(page).toHaveURL(new RegExp(`${hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)); }

async function fixture(page, role = "attorney", { hash = "/help", setup } = {}) {
  const state = {
    user: { id: OWNER, _id: OWNER, role, status: "approved", firstName: "Dana", lastName: "Young", preferences: { theme: "light", fontSize: "md" }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } },
    calls: [], searchCalls: [], respond: null,
  };
  await page.addInitScript(() => { window.EventSource = class extends EventTarget { close() {} }; });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    state.calls.push({ path: pathname, query: Object.fromEntries(url.searchParams), method: request.method() });
    if (pathname === "/api/auth/me") {
      if (state.authRespond) return state.authRespond(route);
      return json(route, { user: state.user });
    }
    if (pathname === "/api/users/me") return json(route, state.user);
    if (pathname === "/api/csrf") return state.csrfRespond ? state.csrfRespond(route) : json(route, { csrfToken: "help-csrf" });
    if (pathname === `/api/cases/${MATTER}`) return state.matterRespond ? state.matterRespond(route) : json(route, workspaceMatter());
    if (pathname === "/api/account/preferences") return json(route, state.user.preferences);
    if (pathname === "/api/users/me/onboarding") return json(route, { onboarding: state.user.onboarding });
    if (pathname === "/api/cases/search") {
      const query = url.searchParams.get("q"), types = (url.searchParams.get("types") || "matter,profile").split(",");
      state.searchCalls.push({ query, types, expectedOwnerId: url.searchParams.get("expectedOwnerId") });
      if (state.respond) return state.respond(route, { query, types, url });
      return json(route, { ownerId: state.user.id, query, types, results: { matters: [matter()], profiles: role === "attorney" ? [profile()] : [] } });
    }
    if (pathname.startsWith("/api/notifications")) {
      if (pathname.endsWith("/unread-count")) return json(route, { count: 0 });
      if (pathname.endsWith("/page")) return json(route, { items: [], hasMore: false, nextCursor: null });
      return json(route, []);
    }
    const empty = { "/api/paralegal/dashboard": { activeCases: [], completedCases: [] }, "/api/payments/connect/status": { readiness: { ready: true, accountPresent: true, evidenceState: "verified" } }, "/api/messages/unread-count": { count: 0 }, "/api/support/conversation": { conversation: { id: "workspace-search-support", status: "open" }, messages: [] } };
    return json(route, empty[pathname] || { items: [], total: 0, page: 1, pages: 0 });
  });
  if (setup) await setup(state);
  await page.goto(`/${role}-v2.html#${hash}`);
  await expect(page.locator(role === "attorney" ? "html" : "body")).toHaveAttribute(role === "attorney" ? "data-attorney-state" : "data-v2-session", "ready");
  const input = page.locator(role === "attorney" ? "#av2-query" : "[data-v2-search-input]");
  const panel = page.locator(role === "attorney" ? '[data-av2-panel="search"]' : "[data-v2-search-panel]");
  const open = async () => {
    if (role === "attorney") await page.getByRole("button", { name: "Search your workspace", exact: true }).click();
    else await page.keyboard.press("ControlOrMeta+KeyK");
    await expect(input).toBeFocused();
  };
  return { state, input, panel, open };
}

test("attorney Help contains its role guide and real issue form inside the current workspace", async ({ page }) => {
  await fixture(page, "attorney");
  await expect(page.getByRole("heading", { name: "Help for Attorneys", exact: true })).toBeVisible();
  await expect(page.getByLabel("Short summary", { exact: true })).toBeVisible();
  await expect(page.getByLabel("What happened?", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit issue", exact: true })).toBeVisible();
  await expect(page.getByText("Navigation preview.", { exact: false })).toHaveCount(0);
});

test("attorney Help can send an account-bound report and open its in-workspace receipt", async ({ page }) => {
  await fixture(page, "attorney");
  const requests = [];
  await page.route("**/api/incidents", async route => {
    requests.push(route.request().postDataJSON());
    return json(route, {ok:true,incident:{publicId:"INC-20260909-000204",userVisibleStatus:"received"},reporterAccessToken:"synthetic-help-token"},201);
  });
  await page.getByLabel("Short summary", { exact: true }).fill("Matter page did not update");
  await page.getByLabel("What happened?", { exact: true }).fill("After saving a date the page still showed the earlier date.");
  await page.getByRole("button", { name: "Submit issue", exact: true }).click();
  await expect(page.getByText("Report received", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);expect(requests[0].reporterId).toBe(OWNER);expect(requests[0].featureKey).toBe("attorney-v2-help");
  await expect(page.getByRole("link", { name: "View report", exact: true })).toHaveAttribute("href", "#/help?incident=INC-20260909-000204");
});

test("validation focuses the missing field and pending submission has one status and one write", async ({ page }) => {
  await fixture(page); const f = fields(page); let release; const gate = new Promise(resolve => release = resolve), writes = [];
  await page.route("**/api/incidents", async route => { writes.push(route.request().postDataJSON()); await gate; return json(route, success, 201); });
  await f.submit.focus(); await f.submit.press("Enter"); await expect(f.summary).toBeFocused();
  await f.summary.fill(report.summary); await f.summary.press("Enter"); await expect(f.description).toBeFocused(); expect(writes).toHaveLength(0);
  await f.description.fill(report.description); await f.submit.click(); await expect.poll(() => writes.length).toBe(1);
  await expect(f.submit).toBeDisabled(); await expect(f.submit).toHaveText("Submit issue"); await expect(f.status).toHaveText("Sending your report to LPC.");
  await f.summary.press("Enter"); expect(writes).toHaveLength(1); await f.description.fill("Additional details written after sending.");
  release(); await expect(f.status).toContainText("Report received"); await expect(f.description).toHaveValue("Additional details written after sending.");
  await expect(f.status).not.toContainText(/null|undefined|Status: received/);
});

test("lost receipt survives reload and a failed recovery preflight preserves its original key", async ({ page }) => {
  const { state } = await fixture(page); const writes = [];
  await page.route("**/api/incidents", route => { writes.push(route.request().postDataJSON()); return writes.length === 1 ? route.abort("failed") : json(route, success, 200); });
  const f = await fill(page); await f.submit.click(); await expect(f.status).toContainText("Receipt unconfirmed");
  await f.description.fill("Newer details stay separate from the previous submission."); await page.reload();
  await expect(f.submit).toHaveText("Check report"); expect(writes).toHaveLength(1);
  state.csrfRespond = route => json(route, { error: "unavailable" }, 503);
  await f.submit.click(); await expect(f.submit).toBeEnabled(); await expect(f.status).toContainText("Receipt unconfirmed"); expect(writes).toHaveLength(1);
  const saved = await page.evaluate(owner => JSON.parse(sessionStorage.getItem(`lpc:v2:help-draft:${owner}`)), OWNER); expect(saved.retryPayload).toEqual(writes[0]);
  state.csrfRespond = null; await f.submit.click(); await expect(f.status).toContainText("Report received"); expect(writes[1]).toEqual(writes[0]);
  await expect(f.description).toHaveValue("Newer details stay separate from the previous submission.");
  await f.submit.click(); await expect(f.description).toHaveValue(""); expect(writes[2].requestId).not.toBe(writes[0].requestId);
});

test("a new report failing before dispatch retains editable input without an uncertain receipt", async ({ page }) => {
  const { state } = await fixture(page); let writes = 0; await page.route("**/api/incidents", route => { writes++; return json(route, success, 201); });
  state.csrfRespond = route => json(route, {}, 503); const f = await fill(page); await f.submit.click();
  await expect(f.status).toContainText("Unable to submit"); await expect(f.status).not.toContainText("Receipt unconfirmed");
  await expect(f.submit).toHaveText("Submit issue"); expect(writes).toBe(0);
  await f.description.fill("Corrected input after the preflight failed."); state.csrfRespond = null;
  await f.submit.click(); await expect(f.status).toContainText("Report received"); expect(writes).toBe(1);
});

test("owner replacement before or after dispatch clears private Help state", async ({ page }) => {
  const { state } = await fixture(page); const writes = []; let replaceAfter = false;
  await page.route("**/api/incidents", route => { writes.push(route.request().postDataJSON()); if (replaceAfter) state.user = { ...state.user, id: OTHER, _id: OTHER }; return json(route, success, 201); });
  await page.evaluate(() => sessionStorage.setItem("incident-access:EARLIER", "private-access"));
  await fill(page); state.user = { ...state.user, id: OTHER, _id: OTHER }; await fields(page).submit.click();
  await expect(page).toHaveURL(/\/login.html/); expect(writes).toHaveLength(0);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("incident-access:") || key.startsWith("lpc:v2:help-draft:")))).toEqual([]);
  state.user = { ...state.user, id: OWNER, _id: OWNER }; await page.goto("/attorney-v2.html#/help"); await fill(page); replaceAfter = true;
  await fields(page).submit.click(); await expect(page).toHaveURL(/\/login.html/); expect(writes).toHaveLength(1);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("incident-access:") || key.startsWith("lpc:v2:help-draft:")))).toEqual([]);
});

test("failed receipt ownership check stays recoverable until the same owner is verified", async ({ page }) => {
  const { state } = await fixture(page); const writes = [];
  await page.route("**/api/incidents", route => { writes.push(route.request().postDataJSON()); if (writes.length === 1) state.authRespond = r => json(r, {}, 503); return json(route, success, 201); });
  const f = await fill(page); await f.submit.click(); await expect(f.status).toContainText("Receipt unconfirmed");
  await expect(f.status).not.toContainText("Report received"); expect(await page.evaluate(() => sessionStorage.getItem("incident-access:INC-20260909-000204"))).toBeNull();
  state.authRespond = null; await f.submit.click(); await expect(f.status).toContainText("Report received"); expect(writes[1]).toEqual(writes[0]);
});

test("route changes retain pending work and a temporary session outage quarantines then restores drafts", async ({ page }) => {
  const { state } = await fixture(page); const f = await fill(page); let writes = 0, release;
  const gate = new Promise(resolve => release = resolve);
  await page.route("**/api/incidents", async route => { writes++; await gate; return json(route, success, 201); });
  await f.submit.click(); await expect.poll(() => writes).toBe(1); await routeTo(page, "/home"); await routeTo(page, "/help");
  await expect(f.submit).toBeDisabled(); release(); await expect(f.status).toContainText("Report received"); expect(writes).toBe(1);
  await fill(page, { summary: "Retained private draft", description: "These details must survive a temporary session check failure." });
  state.authRespond = route => json(route, {}, 503); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("[data-av2-gate]")).toContainText("We couldn’t verify your session"); await expect(f.summary).toHaveCount(0);
  state.authRespond = null; await page.locator("[data-av2-gate]").getByRole("button", { name: "Try again" }).click();
  await expect(f.summary).toHaveValue("Retained private draft"); expect(writes).toBe(1);
});

test("malformed receipts remain recoverable and bounded field validation permits correction", async ({ page }) => {
  await fixture(page); const writes = [];
  await page.route("**/api/incidents", route => { writes.push(route.request().postDataJSON()); return writes.length === 1 ? json(route, { ok: true }) : writes.length === 2 ? json(route, { fields: { summary: "Add the affected section." }, error: "Internal database secrets" }, 422) : json(route, success, 201); });
  const f = await fill(page); await f.submit.click(); await expect(f.status).toContainText("Receipt unconfirmed");
  await f.submit.click(); await expect(f.status).toContainText("Add the affected section."); await expect(f.status).not.toContainText("Internal database secrets");
  expect(writes[1]).toEqual(writes[0]); await f.summary.fill("Updated summary with the affected section"); await f.submit.click();
  await expect(f.status).toContainText("Report received"); expect(writes[2].requestId).not.toBe(writes[0].requestId);
});

test("verified Matter reference is optional and rechecked before a new report", async ({ page }) => {
  const { state } = await fixture(page, "attorney", { hash: `/help?caseId=${MATTER}` }); const writes = [];
  await page.route("**/api/incidents", route => { writes.push(route.request().postDataJSON()); return json(route, success, 201); });
  await expect(page.locator(".av2-help-context").getByRole("link", { name: "Litigation review" })).toBeVisible();
  await expect(page.getByLabel("Include this Matter reference")).toBeChecked(); const f = await fill(page);
  state.matterRespond = route => json(route, { error: "unavailable" }, 404); await f.submit.click();
  await expect(f.status).toContainText("The related Matter could not be verified"); expect(writes).toHaveLength(0);
  await page.getByLabel("Include this Matter reference").uncheck(); await f.submit.click(); await expect(f.status).toContainText("Report received"); expect(writes[0]).not.toHaveProperty("caseId");
  state.matterRespond = null; await page.getByLabel("Include this Matter reference").check(); await fill(page); await f.submit.click();
  await expect(f.description).toHaveValue(""); expect(writes[1].caseId).toBe(MATTER); expect(writes[1]).not.toHaveProperty("matterTitle");
});

test("an invalid or obsolete Matter context cannot leak a title or block a general report", async ({ page }) => {
  const { state } = await fixture(page, "attorney", { hash: "/help?caseId=not-a-matter" }); let writes = 0;
  await page.route("**/api/incidents", route => { writes++; return json(route, success, 201); });
  const f = await fill(page); await f.submit.click(); await expect(f.status).toContainText("Related Matter unavailable"); expect(writes).toBe(0);
  expect(state.calls.filter(call => call.path.includes("not-a-matter"))).toHaveLength(0);
  await page.getByLabel("Include this Matter reference").uncheck(); await f.submit.click(); await expect(f.status).toContainText("Report received"); expect(writes).toBe(1);
});

test("an unconfirmed Matter report recovers the same payload even if the Matter becomes unavailable", async ({ page }) => {
  const { state } = await fixture(page, "attorney", { hash: `/help?caseId=${MATTER}` }); const writes = [];
  await page.route("**/api/incidents", route => { writes.push(route.request().postDataJSON()); return writes.length === 1 ? route.abort("failed") : json(route, success, 200); });
  await expect(page.locator(".av2-help-context a")).toBeVisible(); const f = await fill(page); await f.submit.click(); await expect(f.status).toContainText("Receipt unconfirmed");
  state.matterRespond = route => json(route, {}, 404); await page.reload(); await expect(f.submit).toHaveText("Check report");
  await expect(page.locator(".av2-help-context")).toContainText("could not be verified"); await f.submit.click();
  await expect(f.status).toContainText("Report received"); expect(writes[1]).toEqual(writes[0]); expect(writes[1].caseId).toBe(MATTER);
});

test("receipt reader and history preserve a newer Help draft on return", async ({ page }) => {
  await fixture(page); let writes = 0;
  const receipt = { ok: true, incident: { ...success.incident, summary: report.summary, userVisibleStatus: "investigating", createdAt: "2026-09-09T12:00:00.000Z", updatedAt: "2026-09-09T12:00:00.000Z" } };
  await page.route("**/api/incidents", route => { writes++; return json(route, success, 201); });
  await page.route("**/api/incidents/INC-20260909-000204?*", route => json(route, receipt));
  await page.route("**/api/incidents/INC-20260909-000204/timeline?*", route => json(route, { ...receipt, events: [{ seq: 1, summary: "Your report was received.", createdAt: receipt.incident.createdAt }], hasMore: false, nextCursor: null }));
  const f = await fill(page); await f.submit.click(); await expect(f.status).toContainText("Report received"); await fill(page, { summary: "New draft", description: "Separate information still being written." });
  await f.status.getByRole("link", { name: "View report" }).click(); await expect(page.locator(".lpc-report-status")).toContainText("Under review");
  await page.locator(".lpc-report-history summary").click(); await expect(page.locator(".lpc-report-updates")).toContainText("Your report was received.");
  await page.getByRole("link", { name: "Back to Help" }).click(); await expect(f.summary).toHaveValue("New draft"); expect(writes).toBe(1);
});

test("keyboard guide, resource links and unavailable storage keep Help usable", async ({ page }) => {
  await page.addInitScript(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith("lpc:v2:help-draft:") || key.startsWith("incident-access:")) throw new DOMException("Unavailable", "QuotaExceededError"); return original.call(this, key, value); }; });
  await fixture(page); await page.setViewportSize({ width: 390, height: 844 }); const disclosure = page.locator(".v2-help-answer summary").first();
  await disclosure.focus(); await disclosure.press("Enter"); await expect(disclosure.locator("..")).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Report an issue", exact: true }).click(); await expect(page.getByRole("heading", { name: "Report an issue", exact: true })).toBeFocused();
  const f = await fill(page); await routeTo(page, "/home"); await routeTo(page, "/help"); await expect(f.description).toHaveValue(report.description);
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  for (const [name, href] of [["Attorney FAQ", "/attorney-faq.html"], ["Contact", "/contact.html"], ["Reset password", "/forgot-password.html"], ["Privacy Policy", "/privacy.html"]]) await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute("href", href);
  await page.route("**/api/incidents", route => json(route, success, 201)); await f.submit.click(); await expect(f.status).toContainText("Report received");
});

test("Help layouts and feedback are accessible in both themes and at enlarged text", async ({ page }, testInfo) => {
  await fixture(page); const f = fields(page); await f.submit.click(); await expect(f.status).toContainText("More detail needed");
  for (const [theme, width, fontSize] of [["light", 1440, "100%"], ["dark", 390, "100%"], ["dark", 320, "200%"]]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(({ theme, fontSize }) => { document.documentElement.classList.toggle("theme-dark", theme === "dark"); document.documentElement.style.fontSize = fontSize; }, { theme, fontSize });
    const root = page.locator(".av2-help"); await expect(root).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const result = await new AxeBuilder({ page }).include(".av2-help").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(result.violations).toEqual([]);
    await root.locator("h1").scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`help-guide-${theme}-${width}.png`) });
    await f.status.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`help-form-${theme}-${width}.png`) });
    for (const control of await root.locator("button, input, summary").all()) { const box = await control.boundingBox(); if (box) expect(box.height).toBeGreaterThanOrEqual(44); }
  }
});
