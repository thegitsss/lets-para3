const { test, expect } = require("../support-session-fixture");
const { enterSecondaryDocument: enterInitialDocument } = require("../secondary-document-entry");
const AxeBuilder = require("@axe-core/playwright").default;
const scope = "attorney_matters", endpoint = "/api/account/dashboard-views";
const filters = { view: "archived", search: "Synthetic Contract", practice: "Contract Law", deadline: "none", updated: "30_days", sort: "alphabetical", archiveStatus: "paused" };
const panel = page => page.locator("[data-saved-views]");
const picker = page => page.locator("#av2-saved-views, [data-matter-saved-view]");
const feedback = page => page.locator(".attorney-saved-views > [role=status], [data-matter-saved-view-status]");
const check = page => panel(page).getByRole("button", { name: "Check saved views", exact: true }).click();
async function api(page, method, path = endpoint, data) {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const user = (await (await page.request.get("/api/auth/me")).json()).user;
  const result = await page.request[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(result.ok(), `${method} ${path}: ${await result.text()}`).toBeTruthy(); return result.json();
}
const read = page => api(page, "get", `${endpoint}?scope=${scope}`);
const seed = async (page, name = "Seed view", selected = filters) => (await api(page, "post", endpoint, { id: require("crypto").randomUUID(), scope, name, filters: selected, revision: null })).view;
async function open(page, current = false, query = "") {
  const target = current ? `/dashboard-attorney.html${query}#cases:archived` : `/attorney-v2.html#/matters${query}`;
  if (page.url() === "about:blank") {
    await enterInitialDocument(page, new URL(target, test.info().project.use.baseURL).href);
  } else await page.goto(target, { waitUntil: "domcontentloaded" });
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
async function start(page, name, current = false) {
  await (current ? page.locator("[data-matter-save-view]") : page.getByRole("button", { name: "Save applied view", exact: true })).click();
  await panel(page).getByRole("textbox", { name: "View name", exact: true }).fill(name);
}
const save = page => panel(page).getByRole("button", { name: "Save view", exact: true }).click();
async function reviewDelete(page, current = false) {
  await (current ? page.locator("[data-matter-delete-view]") : page.getByRole("button", { name: "Delete selected view", exact: true })).click();
}
test.beforeEach(async ({ page }) => { for (const view of (await read(page)).views) await api(page, "delete", `${endpoint}/${scope}/${view.id}`, { revision: view.revision }); });

test("V2 creates and restores every filter, the current dashboard restores the same view after reload", async ({ page }) => {
  await open(page, false, "?view=archived&q=Synthetic%20Contract&matterPractice=Contract%20Law&matterDeadline=none&matterUpdated=30_days&matterSort=alphabetical&archiveStatus=paused");
  await start(page, "Complete filter preset"); await expect(panel(page)).toContainText("Paused"); await save(page); await expect(feedback(page)).toContainText("View saved");
  const saved = (await read(page)).views[0]; expect(saved.filters).toEqual(filters);
  await picker(page).selectOption("builtin:active"); await expect(page).toHaveURL(/view=active/);
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await picker(page).selectOption(`saved:${saved.id}`); await expect(page).toHaveURL(/archiveStatus=paused/);
  await expect(page.getByRole("combobox", { name: "Archive status", exact: true })).toHaveValue("paused");
  await open(page, true); await picker(page).selectOption(`saved:${saved.id}`);
  await expect(page.locator("[data-cases-search]")).toHaveValue(filters.search); await expect(page.locator("[data-matter-practice-filter]")).toHaveValue(filters.practice);
  await expect(page.locator("[data-archived-status-filter]")).toHaveValue("paused"); await page.reload({ waitUntil: "domcontentloaded" });
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(page.locator("[data-cases-search]")).toHaveValue(filters.search); await expect(page.locator("[data-archived-status-filter]")).toHaveValue("paused");
  expect((await read(page)).views).toHaveLength(1);
});

test("current dashboard creation is readable in V2 and deletion preserves applied filters", async ({ page }) => {
  await open(page, true, "?q=Current%20search&archiveStatus=completed"); await start(page, "From current", true); await save(page); await expect(feedback(page)).toContainText("View saved");
  const view = (await read(page)).views[0]; expect(view.filters.archiveStatus).toBe("completed");
  await open(page); await picker(page).selectOption(`saved:${view.id}`); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  const applied = page.url(); await reviewDelete(page); await expect(panel(page)).toContainText("From current"); expect((await read(page)).views).toHaveLength(1);
  await panel(page).getByRole("button", { name: "Delete view", exact: true }).click(); await expect(feedback(page)).toContainText("Saved view deleted"); expect(page.url()).toBe(applied); expect((await read(page)).views).toEqual([]);
});

test("a lost create response is checked without a duplicate write, including route recovery", async ({ page }) => {
  await open(page); let writes = 0;
  await page.route("**/api/account/dashboard-views", async route => { if (route.request().method() !== "POST") return route.continue(); writes++; await route.fetch(); await route.abort("failed"); });
  await start(page, "Lost response"); await save(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain");
  await expect(panel(page).getByRole("textbox", { name: "View name", exact: true })).toHaveValue("Lost response");
  await page.evaluate(() => { location.hash = "/home"; }); await expect(panel(page)).toHaveCount(0); await page.evaluate(() => { location.hash = "/matters"; });
  await expect(feedback(page)).toContainText("View saved"); expect(writes).toBe(1); expect((await read(page)).views).toHaveLength(1);
});

test("failed creation retains its name and requires a check before explicit retry", async ({ page }) => {
  await open(page); let writes = 0;
  await page.route("**/api/account/dashboard-views", route => { if (route.request().method() !== "POST") return route.continue(); writes++; return route.fulfill({ status: 503, contentType: "application/json", body: '{}' }); });
  await start(page, "Retry retained"); await save(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await check(page);
  await expect(feedback(page)).toContainText("No saved view was found"); await expect(panel(page).getByRole("textbox", { name: "View name", exact: true })).toHaveValue("Retry retained"); expect(writes).toBe(1);
  await page.unroute("**/api/account/dashboard-views"); await save(page); await expect(feedback(page)).toContainText("View saved"); expect((await read(page)).views).toHaveLength(1);
});

test("a stale deletion requires review of the other tab's latest filters", async ({ page }) => {
  const view = await seed(page); await open(page); await picker(page).selectOption(`saved:${view.id}`); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await reviewDelete(page);
  const newer = await api(page, "post", endpoint, { ...view, name: "Changed elsewhere", filters: { ...filters, archiveStatus: "completed" } });
  await panel(page).getByRole("button", { name: "Delete view", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await check(page);
  await expect(panel(page)).toHaveAttribute("data-state", "conflict"); await expect(panel(page)).toContainText("Changed elsewhere"); await expect(panel(page)).toContainText("Completed"); expect((await read(page)).views[0]).toEqual(newer.view);
  await panel(page).getByRole("button", { name: "Keep saved view", exact: true }).click(); expect((await read(page)).views).toHaveLength(1);
});

test("lost deletion responses resolve through a read and do not repeat deletion", async ({ page }) => {
  const view = await seed(page); await open(page); await picker(page).selectOption(`saved:${view.id}`); await expect(panel(page)).toHaveAttribute("data-state", "ready"); let writes = 0;
  await page.route(`**/api/account/dashboard-views/${scope}/${view.id}`, async route => { writes++; await route.fetch(); await route.abort("failed"); });
  await reviewDelete(page); await panel(page).getByRole("button", { name: "Delete view", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await check(page);
  await expect(feedback(page)).toContainText("Saved view deleted"); expect(writes).toBe(1); expect((await read(page)).views).toEqual([]);
});

test("unavailable initial reads disable creation, while duplicate names and capacity keep the draft", async ({ page }) => {
  await seed(page, "Existing");
  await page.route("**/api/account/dashboard-views?**", route => route.fulfill({ status: 503, contentType: "application/json", body: '{}' }));
  await page.goto("/attorney-v2.html#/matters", { waitUntil: "domcontentloaded" }); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(page.getByRole("button", { name: "Save applied view" })).toBeDisabled();
  await page.unroute("**/api/account/dashboard-views?**"); await check(page); await start(page, "Existing"); await save(page); await expect(feedback(page)).toContainText("name already exists");
  const name = panel(page).getByRole("textbox", { name: "View name", exact: true }); await expect(name).toHaveValue("Existing");
  for (let i = 0; i < 11; i++) await seed(page, `Existing ${i}`);
  await name.fill("Over capacity"); await save(page); await expect(feedback(page)).toContainText("up to 12 views"); await expect(name).toHaveValue("Over capacity");
  await panel(page).getByRole("button", { name: "Cancel view creation" }).click();
});

test("account changes clear current-dashboard drafts and ignore late responses", async ({ page }) => {
  await open(page, true); await start(page, "PRIVATE_SAVED_VIEW_SENTINEL", true);
  let release; const gate = new Promise(resolve => { release = resolve; }); let arrived; const committed = new Promise(resolve => { arrived = resolve; });
  await page.route("**/api/account/dashboard-views", async route => { if (route.request().method() !== "POST") return route.continue(); const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await save(page); await committed;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { id: "0".repeat(24), role: "attorney" } })));
  release(); await expect(panel(page)).toHaveAttribute("data-state", "restricted"); await expect(panel(page).getByRole("textbox")).toHaveCount(0); await expect(picker(page)).not.toContainText("PRIVATE_SAVED_VIEW_SENTINEL");
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain("PRIVATE_SAVED_VIEW_SENTINEL");
});

test("review controls fit mobile and desktop and meet scoped AA checks in both dashboards", async ({ page }, testInfo) => {
  for (const current of [false, true]) {
    await open(page, current, current ? "?archiveStatus=paused" : "?view=archived&archiveStatus=paused"); await start(page, "Accessible saved view", current);
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: 900 }); await panel(page).scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const result = await new AxeBuilder({ page }).include("[data-saved-views]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(result.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-saved-views-${width}.png`), fullPage: true });
    }
    await panel(page).getByRole("button", { name: "Cancel view creation" }).click();
  }
});

const { inventoryFixture } = require('./inventory-fixture');
const inventoryLayoutObservations = new Map();
test.afterEach(async ({}, info) => {
  await info.attach('saved-view-layout-observation.json', {body:Buffer.from(JSON.stringify({project:info.project.name,status:info.status,...inventoryLayoutObservations.get(info.testId)},null,2)),contentType:'application/json'});
  inventoryLayoutObservations.delete(info.testId);
});
for (const width of [390,1280]) for (const outcome of ['empty','failure']) test(`inventory ${outcome} keeps the pressed saved-view control in place at ${width}px`, async ({page}, info) => {
  const user=(await (await page.request.get('/api/auth/me')).json()).user,owner=user.id||user._id;
  const observed={width,outcome,held:0,delivered:0,errors:[]};inventoryLayoutObservations.set(info.testId,observed);
  page.on('pageerror',e=>observed.errors.push(e.message));
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/cases/inventory?**',async route=>{
    observed.held++;await gate;
    const data=await inventoryFixture({active:[],archived:[],drafts:{items:[]}},owner,new URL(route.request().url()).searchParams);
    await route.fulfill({status:outcome==='failure'?503:200,contentType:'application/json',body:JSON.stringify(outcome==='failure'?{}:data)}).catch(()=>{});observed.delivered++;
  });
  try {
    await page.setViewportSize({width,height:720});
    await page.goto('/attorney-v2.html#/matters?view=archived&archiveStatus=paused',{waitUntil:'domcontentloaded'});
    const panel=page.locator('[data-saved-views]'),inventory=page.locator('[data-av2-region="matter-list"]'),trigger=page.getByRole('button',{name:'Save applied view',exact:true}),main=page.locator('[data-av2-outlet]');
    await expect(panel).toHaveAttribute('data-state','ready');await expect(inventory).toHaveAttribute('data-state','loading');await expect.poll(()=>observed.held).toBe(1);
    await trigger.scrollIntoViewIfNeeded();const original=await trigger.elementHandle();
    const before=await trigger.boundingBox();await page.mouse.move(before.x+before.width/2,before.y+before.height/2);await page.mouse.down();
    observed.before=await trigger.boundingBox();observed.scrollBefore=await main.evaluate(n=>n.scrollTop);observed.inventoryBefore=await inventory.boundingBox();
    release();await expect.poll(()=>observed.delivered).toBe(1);await expect(inventory).toHaveAttribute('data-state',outcome==='failure'?'error':'ready');
    observed.after=await trigger.boundingBox();observed.scrollAfter=await main.evaluate(n=>n.scrollTop);observed.inventoryAfter=await inventory.boundingBox();observed.connected=await original.evaluate(n=>n.isConnected);
    await page.mouse.up();observed.formVisible=await panel.getByRole('textbox',{name:'View name',exact:true}).isVisible();
    expect(observed.connected).toBe(true);expect(observed.after.y).toBe(observed.before.y);
    await expect(panel.getByRole('textbox',{name:'View name',exact:true})).toBeVisible();
    await panel.getByRole('textbox',{name:'View name',exact:true}).fill('Inventory completion review');
    await expect(panel).toContainText('Paused');
    await expect(inventory).toContainText(outcome==='failure'?'This information couldn’t be loaded. Refresh to try again.':'No matters match this view.');
    await panel.getByRole('button',{name:'Cancel view creation',exact:true}).click();await expect(trigger).toBeEnabled();expect(observed.errors).toEqual([]);
    await page.screenshot({path:info.outputPath(`saved-view-layout-${width}-${outcome}.png`),fullPage:true});
  } finally { release();await page.mouse.up(); }
});
