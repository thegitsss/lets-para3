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


module.exports={fixture,json,OWNER,OTHER,MATTER,workspaceMatter};
