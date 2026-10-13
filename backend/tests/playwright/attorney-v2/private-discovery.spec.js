const { createHash } = require("crypto");
const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const { projectCanonicalProfile, PROFILE_SOURCE_FIELDS } = require("../../../services/objectSystem/profileAuthorityContract");
const { projectPresentation } = require("../../../services/objectSystem/presentationContract");
const id = (n) => n.toString(16).padStart(24, "0");
const entry = "/attorney-v2.html";
const json = (route, payload, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
const region = (page, name) => page.locator(`[data-av2-region="${name}"]`);
const loaded = (page, name) => expect(region(page, name)).toHaveAttribute("data-state", "ready");
async function planning(page) {
  const data = { tasks: [], weeks: new Map(), writes: [], failCreate: false, failSave: false, failRead: false, slowSave: null };
  await page.route("**/api/cases/inventory/choices?**", route => {
    const q = new URL(route.request().url()).searchParams, selectedId = q.get('selectedId') || '', search = q.get('q') || '', number = Number(q.get('page') || 1);
    const items = [{ id: id(800), title: 'Synthetic current Matter', archived: false, status: 'open', practiceArea: '' }, { id: id(801), title: 'Synthetic archived Matter', archived: true, status: 'completed', practiceArea: '' }];
    return json(route, { ownerId: q.get('expectedOwnerId'), revision: 'a'.repeat(64), filters: { search, page: number, selectedId }, total: 2, page: number, pageSize: 10, pages: 1, items: number === 1 ? items : [], selected: items.find(item => item.id === selectedId) || null });
  });
  await page.route("**/api/users/me/weekly-notes**", async (route) => {
    const request = route.request();
    const key = request.method() === "GET" ? new URL(request.url()).searchParams.get("weekStart") : request.postDataJSON().weekStart;
    const revision = () => createHash("sha256").update(JSON.stringify(data.weeks.get(key) || Array(7).fill(""))).digest("hex");
    if (request.method() === "PUT") {
      data.writes.push({ path: "notes", body: request.postDataJSON() });
      if (data.slowSave) await data.slowSave;
      if (data.failSave) return json(route, { error: "Synthetic save failed" }, 503);
      if (request.postDataJSON().revision !== revision()) return json(route, { error: "Changed" }, 409);
      data.weeks.set(key, request.postDataJSON().notes);
    }
    if (data.failRead) return json(route, { error: "Synthetic unavailable" }, data.failReadStatus || 503);
    return json(route, { weekStart: key, notes: data.weeks.get(key) || Array(7).fill(""), updatedAt: "2026-09-05T12:00:00Z", revision: revision() });
  });
  await page.route("**/api/checklist**", (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() !== "GET") {
      data.writes.push({ path: url.pathname, body: request.postDataJSON(), csrf: request.headers()["x-csrf-token"] });
      if (url.pathname === "/api/checklist") {
        if (data.failCreate) return json(route, { error: "Synthetic unknown" }, 503);
        const task = { ...request.postDataJSON(), id: id(1000 + data.tasks.length), done: false };
        data.tasks.push(task); return json(route, { id: task.id }, 201);
      }
      const target = data.tasks.find((task) => url.pathname.includes(task.id));
      if (!target) return json(route, { error: "Missing" }, 404);
      if (request.method() === "DELETE") data.tasks = data.tasks.filter((task) => task !== target);
      else target.done = !target.done;
      return json(route, { ok: true, done: target.done });
    }
    const status = url.searchParams.get("status");
    let items = data.tasks.filter((task) => status === "all" || task.done === (status === "done"));
    if (url.searchParams.has("overdue")) items = items.filter((task) => !task.done && task.due && new Date(task.due) < new Date());
    if (url.searchParams.has("caseId")) items = items.filter((task) => task.caseId === url.searchParams.get("caseId"));
    const total = items.length; const page = Number(url.searchParams.get("page") || 1); const limit = Number(url.searchParams.get("limit") || 20);
    return json(route, { items: items.slice((page - 1) * limit, page * limit), total, page, limit, pages: Math.ceil(total / limit) });
  });
  return data;
}
function candidate(n, extra = {}) {
  const profile = { _id: id(n), id: id(n), firstName: `Candidate ${n}`, lastName: "Synthetic", role: "paralegal", status: "approved", bio: "Synthetic professional background.", location: "California", state: "CA", practiceAreas: ["Contract Law"], yearsExperience: 5, skills: ["Research"], profilePhotoStatus: "approved", profileImage: "approved-photo", resumeURL: `paralegal-resumes/${id(n)}/resume.pdf`, preferences: { hideProfile: false }, availability: "Available Now", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...extra };
  const source = Object.fromEntries(PROFILE_SOURCE_FIELDS.filter((field) => !field.includes(".") && Object.hasOwn(profile, field)).map((field) => [field, profile[field]]));
  source.preferences = { hideProfile: false };
  profile.presentation = projectPresentation(projectCanonicalProfile({ source, tier: "public", authorizationEvidence: { authorized: true, boundary: "public", publicVisibilityVerified: true }, expectedSourceUpdatedAt: profile.updatedAt }), { kind: "card" });
  return profile;
}
async function directory(page) {
  const data = { profiles: Array.from({ length: 12 }, (_, i) => candidate(i + 1)), queries: [], privateStatus: 200, publicStatus: 200, signedStatus: 200 };
  await page.route("**/api/public/paralegals**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/photo")) return route.abort();
    if (/\/paralegals\/[a-f0-9]{24}$/.test(url.pathname)) return json(route, data.profiles[0], data.publicStatus);
    data.queries.push(url.searchParams.toString());
    const page = Number(url.searchParams.get("page") || 1);
    return json(route, { items: data.profiles.slice((page - 1) * 10, page * 10), total: data.profiles.length, page, limit: 10, pages: Math.ceil(data.profiles.length / 10) });
  });
  await page.route("**/api/paralegals/*", (route) => json(route, { ...data.profiles[0], email: "PRIVATE_EMAIL_SENTINEL", stripeAccountId: "PRIVATE_STRIPE_SENTINEL", notificationPrefs: { private: "PRIVATE_PREF_SENTINEL" }, education: [{ degree: "Paralegal Studies", school: "Synthetic College" }], experience: [{ title: "Legal assistant", company: "Synthetic Firm", years: "2020–2025", description: "Research and case preparation." }], languages: [{ name: "Spanish", proficiency: "Fluent" }] }, data.privateStatus));
  await page.route("**/api/paralegals/saved/*?**", route => {
    const query = new URL(route.request().url()).searchParams;
    return json(route, { ownerId: query.get('expectedOwnerId'), paralegalId: id(1), saved: false, decided: false, available: true });
  });
  await page.route("**/api/uploads/signed-get?**", (route) => json(route, { url: "https://files.example.invalid/synthetic.pdf?expires=synthetic" }, data.signedStatus));
  return data;
}

test("private task create/detail/toggle/delete use CSRF and actual visible controls", async ({ page }) => {
  const data = await planning(page);
  await page.goto(`${entry}#/tasks?week=2026-08-31`); await loaded(page, "private-tasks");
  await page.getByText("New private task", { exact: true }).click();
  const form = page.getByRole("form", { name: "New private task" });
  await form.getByLabel("Task title", { exact: true }).fill("Prepare synthetic filing packet");
  await form.getByLabel("Private details (optional)", { exact: true }).fill("Attorney-only confidential planning");
  await form.getByLabel("Due date and time (optional)", { exact: true }).fill("2026-01-01T12:00");
  await form.getByRole('button', { name: /^Matter \(optional\)/ }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a Matter', exact: true });
  await expect(picker).toHaveAttribute('data-state', 'ready');
  await picker.getByRole('button', { name: 'Synthetic current Matter Posted', exact: true }).click();
  await form.getByRole("button", { name: "Create private task" }).click();
  await expect(region(page, "private-tasks")).toContainText("Prepare synthetic filing packet");
  await expect(region(page, "private-tasks")).toContainText("Overdue");
  await page.getByText("Task details", { exact: true }).click();
  await expect(page.getByText("Attorney-only confidential planning", { exact: true })).toBeVisible();
  expect(data.writes[0].csrf).toBeTruthy(); expect(data.writes[0].body.caseId).toMatch(/^[a-f0-9]{24}$/);
  await page.getByRole("button", { name: "Mark complete", exact: true }).click();
  await expect(region(page, "private-tasks")).toContainText("No tasks match");
  await page.getByRole("combobox", { name: "Task status", exact: true }).selectOption("done");
  await page.getByRole("button", { name: "Apply task filters" }).click(); await loaded(page, "private-tasks");
  await page.getByRole("button", { name: "Delete task", exact: true }).click();
  await page.getByRole("button", { name: "Keep task", exact: true }).click(); expect(data.tasks).toHaveLength(1);
  await page.getByRole("button", { name: "Delete task", exact: true }).click();
  await page.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(region(page, "private-tasks")).toContainText("No tasks match"); expect(data.tasks).toHaveLength(0);
});

test("task paging and uncertain creation preserve the draft and never automatically resubmit", async ({ page }) => {
  const data = await planning(page);
  data.tasks = Array.from({ length: 22 }, (_, i) => ({ id: id(i + 100), title: `Planning task ${i}`, done: false }));
  await page.goto(`${entry}#/tasks?week=2026-08-31`); await loaded(page, "private-tasks");
  await expect(page.locator("[data-av2-task]")).toHaveCount(20);
  await page.getByRole("link", { name: "Next task page" }).click(); await expect(page.locator("[data-av2-task]")).toHaveCount(2);
  await page.getByText("New private task", { exact: true }).click();
  await page.getByLabel("Task title", { exact: true }).fill("Uncertain draft"); data.failCreate = true;
  await page.getByRole("button", { name: "Create private task" }).click();
  await expect(page.getByText("Creation wasn’t confirmed.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create private task" })).toBeDisabled();
  await page.locator(".av2-nav").getByRole("link", { name: "Home", exact: true }).click();
  await page.locator(".av2-nav").getByRole("link", { name: "Private Tasks", exact: true }).click();
  await expect(page.getByLabel("Task title", { exact: true })).toHaveValue("Uncertain draft");
  await expect(page.getByRole("button", { name: "Create private task" })).toBeDisabled();
  expect(data.writes).toHaveLength(1);
});

test("weekly edits recover across weeks, navigation, focus refresh and failed saves; explicit save persists on reload", async ({ page }) => {
  const data = await planning(page);
  await page.goto(`${entry}#/tasks?week=2026-08-31`); await loaded(page, "weekly-notes");
  await page.getByLabel("Monday, Aug 31", { exact: true }).fill("Private Monday work");
  await page.getByRole("link", { name: "Next week", exact: true }).click(); await loaded(page, "weekly-notes");
  await expect(page.getByLabel("Monday, Sep 7", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Previous week", exact: true }).click(); await loaded(page, "weekly-notes");
  await expect(page.getByLabel("Monday, Aug 31", { exact: true })).toHaveValue("Private Monday work");
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await loaded(page, "weekly-notes");
  await expect(page.getByLabel("Monday, Aug 31", { exact: true })).toHaveValue("Private Monday work");
  data.failSave = true;
  await page.getByRole("button", { name: "Save weekly notes", exact: true }).click();
  await expect(region(page, "weekly-notes")).toContainText("Saving wasn’t confirmed");
  expect(data.writes).toHaveLength(1);
  data.failSave = false;
  await page.getByRole("button", { name: "Refresh weekly notes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save weekly notes", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Save weekly notes", exact: true }).click();
  await expect(region(page, "weekly-notes")).toContainText("Weekly notes saved.");
  await page.reload(); await loaded(page, "weekly-notes");
  await expect(page.getByLabel("Monday, Aug 31", { exact: true })).toHaveValue("Private Monday work");
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("Private Monday work");
});

test("weekly notes detect changes elsewhere and preserve edits through explicit comparison", async ({ page }) => {
  const data = await planning(page);
  await page.goto(`${entry}#/tasks?week=2026-08-31`); await loaded(page, "weekly-notes");
  await page.getByLabel("Monday, Aug 31", { exact: true }).fill("My edited note");
  data.weeks.set("2026-08-31", ["Changed in another tab", "", "", "", "", "", ""]);
  await page.getByRole("button", { name: "Save weekly notes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "These notes changed elsewhere" })).toBeVisible();
  expect(data.writes).toHaveLength(0);
  await page.getByText("Saved Monday note", { exact: true }).click();
  await expect(page.getByText("Changed in another tab", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Keep my edits for review" }).click();
  await page.getByRole("button", { name: "Save weekly notes", exact: true }).click();
  await expect(region(page, "weekly-notes")).toContainText("Weekly notes saved.");
  expect(data.weeks.get("2026-08-31")[0]).toBe("My edited note");
  await page.getByLabel("Monday, Aug 31", { exact: true }).fill("Another local edit");
  data.weeks.set("2026-08-31", ["PRIVATE_CONFLICT_SENTINEL", "", "", "", "", "", ""]);
  await page.getByRole("button", { name: "Save weekly notes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "These notes changed elsewhere" })).toBeVisible();
  data.failRead = true; data.failReadStatus = 403;
  await page.getByRole("button", { name: "Refresh weekly notes", exact: true }).click();
  await expect(region(page, "weekly-notes")).toContainText("no longer available");
  await expect(page.getByRole("heading", { name: "These notes changed elsewhere" })).toHaveCount(0);
  expect(await page.content()).not.toContain("PRIVATE_CONFLICT_SENTINEL");
});

test("real notes source cannot silently shift the displayed week", async ({ page }) => {
  const response = await page.request.get("/api/users/me/weekly-notes?weekStart=2026-08-31");
  expect(response.status()).toBe(200); const payload = await response.json();
  await page.goto(`${entry}#/tasks?week=2026-08-31`);
  expect(payload.weekStart).toBe("2026-08-31");
  expect(payload.revision).toBeTruthy();
  await loaded(page, "weekly-notes");
});

test("access loss clears unsaved notes and task text before late requests can restore it", async ({ page }) => {
  await planning(page);
  await page.goto(`${entry}#/tasks?week=2026-08-31`); await loaded(page, "weekly-notes");
  await page.getByLabel("Monday, Aug 31", { exact: true }).fill("PRIVATE_NOTE_SENTINEL");
  await page.getByText("New private task", { exact: true }).click();
  await page.getByLabel("Task title", { exact: true }).fill("PRIVATE_TASK_SENTINEL");
  await page.route("**/api/auth/me", (route) => json(route, { error: "Session expired" }, 401));
  await page.route("**/login.html**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Signed out</h1>" }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  expect(await page.content()).not.toMatch(/PRIVATE_(NOTE|TASK)_SENTINEL/);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/PRIVATE_(NOTE|TASK)_SENTINEL/);
});

test("directory filters, paging, profiles and Back preserve context without business writes", async ({ page }) => {
  const data = await directory(page); const writes = [];
  page.on("request", (request) => { if (request.url().includes("/api/") && request.method() !== "GET") writes.push(request.url()); });
  await page.goto(`${entry}#/paralegals?caseId=${id(100)}&applicantId=${id(200)}`); await loaded(page, "directory");
  await page.getByText("Filter", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Clear filters", exact: true })).toHaveAttribute("href", `#/paralegals?caseId=${id(100)}&applicantId=${id(200)}`);
  await expect(page.locator("[data-av2-candidate]")).toHaveCount(10);
  await page.getByRole("link", { name: "Next profile page" }).click(); await loaded(page, "directory");
  await expect(page.locator("[data-av2-candidate]")).toHaveCount(2);
  await page.getByLabel("Search profiles", { exact: true }).fill("Candidate");
  await page.getByLabel("Search profiles", { exact: true }).press("Enter"); await loaded(page, "directory");
  await page.getByText("Filter", { exact: true }).click();
  await page.getByRole("combobox", { name: "Sort profiles", exact: true }).selectOption("experience");
  await expect(page).toHaveURL(/sort=experience/);
  await loaded(page, "directory"); await page.getByText("Filter", { exact: true }).click();
  await page.getByRole("combobox", { name: "Minimum experience", exact: true }).selectOption("5");
  await expect(page).toHaveURL(/minYears=5/);
  await loaded(page, "directory"); await page.getByText("Filter", { exact: true }).click();
  await page.getByText("States", { exact: true }).click(); await page.getByLabel("California", { exact: true }).check();
  await expect(page).toHaveURL(/location=California/);
  await loaded(page, "directory"); await page.getByText("Filter", { exact: true }).click();
  await page.getByText("Practice areas", { exact: true }).click(); await page.getByLabel("Contract Law", { exact: true }).check();
  await expect(page).toHaveURL(/practice=Contract/);
  await loaded(page, "directory");
  await expect.poll(() => new URLSearchParams(data.queries.at(-1)).get("minYears")).toBe("5");
  const query = new URLSearchParams(data.queries.at(-1)); expect(query.get("minYears")).toBe("5"); expect(query.get("location")).toBe("California"); expect(query.get("sort")).toBe("experience"); expect(query.get("page")).toBe("1");
  await page.getByRole("link", { name: /^Candidate \d+ Synthetic$/ }).first().click(); await loaded(page, "candidate-profile");
  await expect(page.locator(".av2-nav").getByRole("link", { name: "Find a Paralegal" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: /Back to results$/ }).click(); await loaded(page, "directory");
  await page.getByText("Filter", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Minimum experience", exact: true })).toHaveValue("5");
  await expect(page).toHaveURL(new RegExp(`caseId=${id(100)}`));
  expect(writes).toEqual([]);
});

test("profile projection hides private fields, opens authorized documents, and preserves applicant return", async ({ page }) => {
  const data = await directory(page);
  await page.goto(`${entry}#/paralegals/${id(1)}?caseId=${id(100)}&applicantId=${id(200)}&returnTo=${encodeURIComponent("#/matters?view=applications&page=2&matterSort=alphabetical")}`); await loaded(page, "candidate-profile");
  const profileBack = await page.getByRole("link", { name: /Back to Matters$/ }).getAttribute("href");
  expect(profileBack).toContain("page=2"); expect(profileBack).toContain("matterSort=alphabetical");
  await expect(region(page, "candidate-profile")).toContainText("Synthetic College");
  await expect(region(page, "candidate-profile")).toContainText("Research and case preparation.");
  expect(await page.content()).not.toMatch(/PRIVATE_(EMAIL|STRIPE|PREF)_SENTINEL/);
  await page.context().route('https://files.example.invalid/**', route => route.fulfill({ contentType: 'text/plain', body: 'Synthetic authorized document' }));
  const opened = page.waitForEvent('popup');
  await page.getByRole("button", { name: "View résumé", exact: true }).click();
  const document = await opened;
  await expect(document).toHaveURL('https://files.example.invalid/synthetic.pdf?expires=synthetic');
  await document.close();
  // A blocked popup retains a usable signed link; denial removes it.
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole("button", { name: "View résumé", exact: true }).click();
  await expect(page.getByRole("link", { name: "View résumé", exact: true })).toHaveAttribute("href", "https://files.example.invalid/synthetic.pdf?expires=synthetic");
  data.signedStatus = 403;
  await page.getByRole("button", { name: "View résumé", exact: true }).click();
  await expect(page.getByText("This document is no longer available to your account.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "View résumé", exact: true })).toHaveCount(0);
  const href = await page.getByRole("link", { name: "Continue to hiring", exact: true }).getAttribute("href");
  const target = new URL(href, "http://127.0.0.1:5051");
  const back = new URL(target.searchParams.get("returnTo"), "http://127.0.0.1:5051");
  expect(back.searchParams.get("caseId")).toBe(id(100)); expect(back.searchParams.get("applicantId")).toBe(id(200));
});

test("blocked profiles never use the public fallback; 404 fallback is public-only and directory errors recover", async ({ page }) => {
  const data = await directory(page); data.privateStatus = 403;
  let publicReads = 0; page.on("request", (request) => { if (request.url().includes(`/api/public/paralegals/${id(1)}`)) publicReads++; });
  await page.goto(`${entry}#/paralegals/${id(1)}`);
  await expect(region(page, "candidate-profile")).toHaveAttribute("data-state", "error"); expect(publicReads).toBe(0);
  await expect(page.getByRole("link", { name: "Continue to hiring", exact: true })).toHaveCount(0);
  data.privateStatus = 404;
  await page.getByRole("button", { name: "Retry candidate profile" }).click(); await loaded(page, "candidate-profile");
  await expect(region(page, "candidate-profile")).toContainText("Public profile preview");
  await expect(page.getByRole("button", { name: "View résumé" })).toHaveCount(0);
  data.profiles = [];
  await page.goto(`${entry}#/paralegals`); await loaded(page, "directory");
  await expect(region(page, "directory")).toContainText("No paralegals match");
  await page.route("**/api/public/paralegals?**", (route) => json(route, { error: "Synthetic error" }, 503));
  await region(page, "directory").evaluate(panel => panel.refresh());
  await expect(region(page, "directory")).toHaveAttribute("data-state", "error");
  await page.unroute("**/api/public/paralegals?**");
  await page.getByRole("button", { name: "Retry paralegal profiles" }).click(); await loaded(page, "directory");
});

test("visible Tasks notes and creation form meet automated AA and fit the full width matrix", async ({ page }, testInfo) => {
  await planning(page); await page.goto(`${entry}#/tasks?week=2026-08-31`); await loaded(page, "weekly-notes"); await loaded(page, "private-tasks");
  await page.getByText("New private task", { exact: true }).click();
  await expect(page.locator("[data-av2-weekly-grid]")).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations).toEqual([]);
  for (const width of [320, 360, 390, 768, 1024, 1366, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.locator("main").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const grid = await page.locator("[data-av2-weekly-grid]").boundingBox(); expect(grid.width).toBeGreaterThan(0); expect(grid.height).toBeGreaterThan(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-av2-weekly-grid]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("private-notes-390.png") });
});

test("directory and authorized profile meet automated AA with long content and narrow layout", async ({ page }, testInfo) => {
  const data = await directory(page); data.profiles = [candidate(1, { bio: "Long synthetic profile background. ".repeat(30) })];
  await page.goto(`${entry}#/paralegals`); await loaded(page, "directory");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(results.violations).toEqual([]);
  await page.getByRole("link", { name: /^Candidate \d+ Synthetic$/ }).click(); await loaded(page, "candidate-profile");
  await expect(page.getByRole("button", { name: "Save paralegal", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("candidate-desktop.png") });
  await page.setViewportSize({ width: 320, height: 800 });
  const actions = await page.locator('.av2-profile-actions').boundingBox();
  const bio = await page.locator('.av2-profile-content').boundingBox();
  const name = await page.locator('.av2-profile-intro h1').boundingBox();
  const availability = await page.locator('.av2-profile-name-actions').boundingBox();
  expect(actions.y + actions.height).toBeLessThanOrEqual(bio.y);
  expect(availability.y).toBeGreaterThanOrEqual(name.y);
  expect(availability.y + availability.height).toBeLessThanOrEqual(name.y + name.height + 1);
  await expect(page.locator('.av2-profile-invite > summary')).toBeInViewport();
  expect(await page.locator("main").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "best-practice"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("candidate-320.png") });
});

test("authorized profile meets dark-theme automated AA", async ({ page }) => {
  await directory(page); await page.goto(`${entry}#/paralegals/${id(1)}`); await loaded(page, "candidate-profile");
  await page.evaluate(() => document.documentElement.classList.add("theme-dark"));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  expect(results.violations).toEqual([]);
});
