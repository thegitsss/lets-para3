const { expect } = require("playwright/test");
const { test } = require("./shell-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const OWNER = "111111111111111111111111", OTHER = "222222222222222222222222", MATTER = "333333333333333333333333", PROFILE = "444444444444444444444444";
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const matter = (title = "Litigation review") => ({ type: "matter", id: MATTER, title, practiceArea: "Litigation", status: { code: "open", label: "Posted" }, relationship: { code: "owner", label: "Your matter" }, attention: null, nextAction: { label: "Open Matter", href: `/case-detail.html?caseId=${MATTER}` } });
const profile = () => ({ type: "profile", id: PROFILE, title: "Amélie Rivera", headline: "Litigation", location: "New York", practiceAreas: ["Litigation"], nextAction: { label: "View profile", href: `/profile-paralegal.html?paralegalId=${PROFILE}` } });

async function fixture(page, role) {
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
    if (pathname === "/api/csrf") return json(route, { csrfToken: "workspace-search-csrf" });
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
  await page.goto(`/${role}-v2.html#/help`);
  await expect(page.locator(role === "attorney" ? "html" : "body")).toHaveAttribute(role === "attorney" ? "data-attorney-state" : "data-v2-session", "ready");
  const input = page.locator(role === "attorney" ? "#av2-query" : "[data-v2-search-input]");
  const panel = page.locator(role === "attorney" ? '[data-av2-panel="search"]' : "[data-v2-search-panel]");
  const open = async () => {
    if (role === "attorney") await page.getByRole("button", { name: "Search your workspace", exact: true }).click();
    else await page.keyboard.press("ControlOrMeta+KeyK");
    await expect(input).toBeFocused();
  };
  await open();
  return { state, input, panel, open };
}

for (const role of ["attorney", "paralegal"]) {
  test(`${role} searches while typing and sends the verified account expectation`, async ({ page }) => {
    const { state, input, panel } = await fixture(page, role);
    await input.fill("litigation");
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
    expect(state.searchCalls).toHaveLength(1);
    expect(state.searchCalls[0].expectedOwnerId).toBe(OWNER);
    expect(state.searchCalls[0].types).toEqual(role === "attorney" ? ["matter", "profile"] : ["matter"]);
  });

  test(`${role} changing query discards an older response before debounce fires`, async ({ page }) => {
    const { state, input, panel } = await fixture(page, role);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 100));
    let release;
    state.respond = (route, { query, types }) => new Promise(resolve => {
      release = () => json(route, { ownerId: OWNER, query, types, results: { matters: [matter("Older private result")], profiles: [] } }).catch(() => {}).finally(resolve);
    });
    await input.fill("older");
    await input.press("Enter");
    await expect.poll(() => Boolean(release)).toBe(true);
    await input.fill("newer");
    release();
    await page.clock.runFor(120);
    await expect(panel.getByText("Older private result", { exact: true })).toHaveCount(0);
    expect(state.searchCalls).toHaveLength(1);
  });

  test(`${role} malformed search results remain an error with deliberate retry`, async ({ page }) => {
    const { state, input, panel } = await fixture(page, role);
    state.respond = route => json(route, { ownerId: OWNER, query: "litigation", results: { matters: "invalid" } });
    await input.fill("litigation"); await input.press("Enter");
    await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(panel).not.toContainText(/No (?:matching Matters|results)/);
    state.respond = null;
    await panel.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
  });

  test(`${role} replacement-account result cannot enter the previous workspace`, async ({ page }) => {
    const { state, input, panel } = await fixture(page, role);
    state.respond = (route, { query, types }) => {
      state.user = { ...state.user, id: OTHER, _id: OTHER, firstName: "Replacement" };
      return json(route, { ownerId: OTHER, query, types, results: { matters: [matter("Other account private result")], profiles: [] } });
    };
    await input.fill("replacement"); await input.press("Enter");
    await expect(page).toHaveURL(/\/login\.html/);
    await expect(page.getByText("Other account private result", { exact: true })).toHaveCount(0);
    await expect(panel).toHaveCount(0);
  });

  test(`${role} reopening a previous query checks current access before showing records`, async ({ page }) => {
    const { state, input, panel, open } = await fixture(page, role);
    await input.fill("litigation"); await input.press("Enter");
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
    await input.press("Escape");
    await expect(input).toHaveValue("litigation");
    const previous = state.searchCalls.length;
    state.respond = route => json(route, { error: "Search access unavailable" }, 403);
    await open();
    await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect(panel.getByText("Litigation review", { exact: true })).toHaveCount(0);
    expect(state.searchCalls.length).toBeGreaterThan(previous);
  });
}

test("attorney search includes authorized paralegals and keeps exact destinations in V2", async ({ page }) => {
  const { input, panel } = await fixture(page, "attorney");
  await input.fill("litigation"); await input.press("Enter");
  await expect(panel.getByText("Amélie Rivera", { exact: true })).toBeVisible();
  await expect(panel.getByRole("option", { name: /Amélie Rivera/ })).toHaveAttribute("href", `/attorney-v2.html#/paralegals/${PROFILE}`);
  await expect(panel.getByRole("option", { name: /Litigation review/ })).toHaveAttribute("href", `/attorney-v2.html#/matters/${MATTER}/overview`);
});

for (const role of ["attorney", "paralegal"]) {
  test(`${role} validates every row and envelope without showing partial trusted data`, async ({ page }) => {
    const { state, input, panel } = await fixture(page, role);
    const valid = () => ({ ownerId: OWNER, query: "litigation", types: role === "attorney" ? ["matter", "profile"] : ["matter"], results: { matters: [matter()], profiles: [] } });
    const corrupt = [
      payload => { payload.query = "previous"; },
      payload => { payload.types = ["profile"]; },
      payload => { payload.results.matters.push({ ...matter(), id: "invalid" }); },
      payload => { payload.results.matters[0].nextAction.href = "https://example.com/private"; },
      payload => { payload.results.matters[0].nextAction.href = `/case-detail.html?caseId=${OTHER}`; },
      payload => { payload.results.matters.push(matter()); },
      payload => { payload.results.profiles = [profile()]; if (role === "attorney") payload.results.profiles[0].practiceAreas = "invalid"; },
    ];
    await input.fill("litigation");
    for (const change of corrupt) {
      state.respond = route => { const payload = valid(); change(payload); return json(route, payload); };
      await input.press("Enter");
      await expect(panel.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(panel.getByText("Litigation review", { exact: true })).toHaveCount(0);
      await expect(panel.getByText("Amélie Rivera", { exact: true })).toHaveCount(0);
    }
  });

  test(`${role} checks identity after the result read and before display`, async ({ page }) => {
    const { state, input } = await fixture(page, role);
    state.respond = (route, { query, types }) => {
      state.user = { ...state.user, id: OTHER, _id: OTHER };
      return json(route, { ownerId: OWNER, query, types, results: { matters: [matter("Previous account result")], profiles: [] } });
    };
    await input.fill("litigation"); await input.press("Enter");
    await expect(page).toHaveURL(/\/login\.html/);
    await expect(page.getByText("Previous account result", { exact: true })).toHaveCount(0);
  });

  test(`${role} unavailable session verification does not query or invent results`, async ({ page }) => {
    const { state, input, panel } = await fixture(page, role);
    state.authRespond = route => json(route, { error: "Internal diagnostics must not be displayed" }, 503);
    await input.fill("litigation"); await input.press("Enter");
    await expect(panel.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(state.searchCalls).toHaveLength(0);
    await expect(panel).not.toContainText("Internal diagnostics");
    state.authRespond = null;
    await panel.getByRole("button", { name: "Try again" }).click();
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
  });

  test(`${role} times out once and requires explicit retry`, async ({ page }) => {
    const { state, input, panel } = await fixture(page, role);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 100));
    let release;
    state.respond = (route, { query, types }) => new Promise(resolve => {
      release = () => json(route, { ownerId: OWNER, query, types, results: { matters: [matter("Late result")], profiles: [] } }).catch(() => {}).finally(resolve);
    });
    await input.fill("litigation"); await input.press("Enter");
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.clock.runFor(15100);
    await expect(panel.getByText("Search took too long. Please try again.", { exact: true })).toBeVisible();
    expect(state.searchCalls).toHaveLength(1);
    release();
    await expect(panel.getByText("Late result", { exact: true })).toHaveCount(0);
    state.respond = null;
    await panel.getByRole("button", { name: "Try again" }).click();
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
    expect(state.searchCalls).toHaveLength(2);
    await expect(input).toBeFocused();
  });

  test(`${role} closing cancels a held read and reopening obtains a new one`, async ({ page }) => {
    const { state, input, panel, open } = await fixture(page, role);
    let release;
    state.respond = (route, { query, types }) => new Promise(resolve => {
      release = () => json(route, { ownerId: OWNER, query, types, results: { matters: [matter("Closed result")], profiles: [] } }).catch(() => {}).finally(resolve);
    });
    await input.fill("litigation"); await input.press("Enter");
    await expect.poll(() => Boolean(release)).toBe(true);
    await input.press("Escape"); release();
    await expect(panel).toBeHidden();
    await expect(panel.getByText("Closed result", { exact: true })).toHaveCount(0);
    state.respond = null; await open();
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
    expect(state.searchCalls).toHaveLength(2);
  });

  test(`${role} respects composition and does not duplicate Enter searches`, async ({ page }, testInfo) => {
    const { state, input, panel } = await fixture(page, role);
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 100));
    await input.evaluate(element => {
      window.__searchCompositionEvents = [];
      for (const type of ["input", "keydown", "keyup", "compositionstart", "compositionend"]) element.addEventListener(type, event => window.__searchCompositionEvents.push({ type, key: event.key, composing: event.isComposing, value: element.value, time: Date.now() }));
      element.form.addEventListener("submit", () => window.__searchCompositionEvents.push({ type: "submit", value: element.value, time: Date.now() }));
    });
    await input.dispatchEvent("compositionstart");
    // Firefox's Playwright fill emits a complete native composition sequence.
    // Keep this synthetic composition open until the explicit end event below.
    await input.evaluate(element => {
      element.value = "litigation";
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "litigation", inputType: "insertCompositionText", isComposing: true }));
    });
    await input.press("Enter");
    await testInfo.attach("composition-before-end", { body: JSON.stringify({ events: await page.evaluate(() => window.__searchCompositionEvents), requests: state.searchCalls }, null, 2), contentType: "application/json" });
    expect(state.searchCalls).toHaveLength(0);
    await input.dispatchEvent("compositionend");
    await input.press("Enter");
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
    await page.clock.runFor(500);
    await testInfo.attach("composition-events", { body: JSON.stringify({ events: await page.evaluate(() => window.__searchCompositionEvents), requests: state.searchCalls }, null, 2), contentType: "application/json" });
    expect(state.searchCalls).toHaveLength(1);
    await input.fill("x");
    await expect(panel.getByText("Litigation review", { exact: true })).toHaveCount(0);
    expect(state.searchCalls).toHaveLength(1);
  });

  test(`${role} keyboard page selection preserves the shell and has one result list`, async ({ page }) => {
    const { state, input, panel } = await fixture(page, role);
    state.respond = (route, { query, types }) => json(route, { ownerId: OWNER, query, types, results: { matters: [], profiles: [] } });
    const before = await page.evaluate(() => { window.__searchPersistentProbe = "same document"; return performance.getEntriesByType("navigation").length; });
    await input.fill("preferences"); await input.press("Enter");
    const option = panel.getByRole("option", { name: role === "attorney" ? "Account Settings Navigation" : "Preferences", exact: true });
    await expect(option).toBeVisible();
    await expect(panel).not.toContainText("Destination");
    await expect(panel.getByRole("listbox")).toHaveCount(1);
    await input.press("ArrowDown");
    await expect(option).toHaveAttribute("aria-selected", "true");
    await expect(input).toHaveAttribute("aria-activedescendant", await option.getAttribute("id"));
    await input.press("Enter");
    await expect(page).toHaveURL(role === "attorney" ? /#\/settings$/ : /#\/settings\?tab=preferences$/);
    expect(await page.evaluate(() => ({ marker: window.__searchPersistentProbe, entries: performance.getEntriesByType("navigation").length }))).toEqual({ marker: "same document", entries: before });
  });

  test(`${role} Search wraps long content at narrow and doubled text sizes`, async ({ page }, testInfo) => {
    const { state, input, panel } = await fixture(page, role);
    state.respond = (route, { query, types }) => json(route, { ownerId: OWNER, query, types, results: { matters: [matter("Litigation chronology and discovery coordination for a long multi-party commercial matter")], profiles: role === "attorney" ? [profile()] : [] } });
    await input.fill("litigation"); await input.press("Enter");
    await expect(panel.getByRole("option", { name: /Litigation chronology/ })).toBeVisible();
    for (const variant of [{ width: 1440, height: 900, dark: false, size: 16 }, { width: 320, height: 780, dark: true, size: 20 }, { width: 390, height: 844, dark: false, size: 32 }]) {
      await page.setViewportSize({ width: variant.width, height: variant.height });
      await page.evaluate(({ dark, size }) => {
        document.documentElement.classList.toggle("theme-dark", dark);
        document.body.classList.toggle("theme-dark", dark);
        document.documentElement.style.fontSize = `${size}px`;
      }, variant);
      await expect(panel).toBeVisible();
      const metrics = await panel.evaluate(element => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, width: innerWidth, overflow: element.scrollWidth > element.clientWidth + 1, rows: [...element.querySelectorAll('[role="option"]')].map(row => ({ height: row.getBoundingClientRect().height, overflow: row.scrollWidth > row.clientWidth + 1 })) };
      });
      expect(metrics.left).toBeGreaterThanOrEqual(0); expect(metrics.right).toBeLessThanOrEqual(metrics.width + 1); expect(metrics.overflow).toBe(false);
      for (const row of metrics.rows) { expect(row.height).toBeGreaterThanOrEqual(44); expect(row.overflow).toBe(false); }
      const axe = await new AxeBuilder({ page }).include(role === "attorney" ? '[data-av2-panel="search"]' : '[data-v2-search-panel]').withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(axe.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${role}-search-${variant.width}-${variant.size}.png`) });
    }
  });
}

for (const role of ["attorney", "paralegal"]) {
  test(`${role} rejects an overlong normalized query without silently changing intent`, async ({ page }) => {
    const { state, input, panel } = await fixture(page, role);
    await input.fill("litigation"); await input.press("Enter");
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
    const before = state.searchCalls.length;
    const raw = `${"a".repeat(79)}ﬃ`;
    await input.fill(raw); await input.press("Enter");
    await expect(input).toHaveValue(raw);
    await expect(panel.getByText("Use 80 characters or fewer.", { exact: true })).toBeVisible();
    await expect(panel.getByRole("option")).toHaveCount(0);
    expect(state.searchCalls).toHaveLength(before);
    await input.fill("litigation"); await input.press("Enter");
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
    expect(state.searchCalls).toHaveLength(before + 1);
  });

  test(`${role} keeps a keyboard-selected page when remote records finish loading`, async ({ page }) => {
    const { state, input, panel } = await fixture(page, role);
    let release;
    state.respond = (route, { query, types }) => new Promise(resolve => {
      release = () => json(route, { ownerId: OWNER, query, types, results: { matters: [matter()], profiles: [] } }).catch(() => {}).finally(resolve);
    });
    await input.fill("help"); await input.press("Enter");
    await expect.poll(() => Boolean(release)).toBe(true);
    const option = panel.getByRole("option", { name: role === "attorney" ? "Help Navigation" : "Help", exact: true });
    await expect(option).toBeVisible();
    await input.press("ArrowDown");
    await expect(option).toHaveAttribute("aria-selected", "true");
    release();
    await expect(panel.getByText("Litigation review", { exact: true })).toBeVisible();
    await expect(option).toHaveAttribute("aria-selected", "true");
    await expect(input).toHaveAttribute("aria-activedescendant", await option.getAttribute("id"));
    await expect(input).toBeFocused();
  });

  test(`${role} shortcut respects an active modal and another editable field`, async ({ page }) => {
    const { input, panel } = await fixture(page, role);
    await input.press("Escape");
    await page.evaluate(() => {
      const field = document.createElement("textarea"); field.id = "search-other-editor"; document.body.append(field); field.focus();
    });
    await page.keyboard.press("ControlOrMeta+KeyK");
    await expect(page.locator("#search-other-editor")).toBeFocused();
    await expect(panel).toBeHidden();
    await page.evaluate(() => {
      document.querySelector("#search-other-editor").remove();
      const dialog = document.createElement("dialog"); dialog.id = "search-modal-probe"; dialog.innerHTML = '<button type="button">Review action</button>'; document.body.append(dialog); dialog.showModal(); dialog.querySelector("button").focus();
    });
    await page.keyboard.press("ControlOrMeta+KeyK");
    await expect(page.getByRole("button", { name: "Review action" })).toBeFocused();
    await expect(panel).toBeHidden();
    await page.evaluate(() => document.querySelector("#search-modal-probe").close());
  });
}

test("attorney keeps the focused search field visible while moving through twelve records", async ({ page }, testInfo) => {
  const { state, input, panel } = await fixture(page, "attorney");
  state.respond = (route, { query, types }) => json(route, { ownerId: OWNER, query, types, results: {
    matters: Array.from({ length: 6 }, (_, i) => { const id = `${"5".repeat(23)}${i}`; return { ...matter(`Litigation chronology and discovery coordination ${i + 1}`), id, nextAction: { href: `/case-detail.html?caseId=${id}` } }; }),
    profiles: Array.from({ length: 6 }, (_, i) => { const id = `${"6".repeat(23)}${i}`; return { ...profile(), title: `Paralegal with litigation experience ${i + 1}`, id, nextAction: { href: `/profile-paralegal.html?paralegalId=${id}` } }; }),
  } });
  await page.setViewportSize({ width: 390, height: 780 });
  await input.fill("litigation"); await input.press("Enter");
  await expect(panel.getByRole("option")).toHaveCount(12);
  await input.press("ArrowDown");
  for (const key of ["End", "Home", "End"]) {
    await input.press(key);
    await expect(input).toBeFocused();
    const metrics = await panel.evaluate(element => {
      const box = element.getBoundingClientRect(), field = element.querySelector("input").getBoundingClientRect(), scroller = element.querySelector("[data-av2-search-results]"), selected = element.querySelector('[aria-selected="true"]').getBoundingClientRect(), clip = scroller.getBoundingClientRect();
      return { fieldTop: field.top, fieldBottom: field.bottom, top: box.top, bottom: box.bottom, selectedTop: selected.top, selectedBottom: selected.bottom, clipTop: clip.top, clipBottom: clip.bottom, outerScroll: element.scrollTop };
    });
    expect(metrics.fieldTop).toBeGreaterThanOrEqual(metrics.top);
    expect(metrics.fieldBottom).toBeLessThanOrEqual(metrics.bottom);
    expect(metrics.selectedTop).toBeGreaterThanOrEqual(metrics.clipTop - 1);
    expect(metrics.selectedBottom).toBeLessThanOrEqual(metrics.clipBottom + 1);
    expect(metrics.outerScroll).toBe(0);
  }
  await page.screenshot({ path: testInfo.outputPath("attorney-search-visible-focus.png") });
});
