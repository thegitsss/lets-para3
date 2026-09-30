const { test, expect } = require("playwright/test");

const PHASE_TWO_VIEWPORTS = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 900 },
  { width: 1920, height: 1080 },
];

async function mockPublicDirectory(page) {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: null }),
    })
  );
  await page.route("**/api/csrf", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ csrfToken: "public-directory-phase-two" }),
    })
  );
  await page.route("**/public/paralegals?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, pages: 1, page: 1 }),
    })
  );
}

async function openSettledDirectory(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto("/browse-paralegals.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#resultsStatus")).toHaveText("No paralegals match your filters yet.");
}

function isDirectoryRequest(request, predicate) {
  const url = new URL(request.url());
  return url.pathname === "/public/paralegals" && predicate(url.searchParams);
}

test("branded sort control is singular, anchored, and functional at every required viewport", async ({ page }) => {
  await mockPublicDirectory(page);

  for (const viewport of PHASE_TWO_VIEWPORTS) {
    await openSettledDirectory(page, viewport);
    const nativeSelect = page.locator("#sortBy");
    const trigger = page.locator("#sortMenuTrigger");
    const menu = page.locator("#sortMenuOptions");
    const options = menu.locator("[role='option']");

    await expect(nativeSelect).toBeHidden();
    await expect(trigger).toBeVisible();
    await expect(menu).toBeHidden();

    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(options).toHaveCount(3);
    await expect(menu.locator("li")).toHaveCount(0);

    const geometry = await page.evaluate(() => {
      const triggerRect = document.getElementById("sortMenuTrigger").getBoundingClientRect();
      const menuRect = document.getElementById("sortMenuOptions").getBoundingClientRect();
      return {
        trigger: { left: triggerRect.left, right: triggerRect.right, bottom: triggerRect.bottom, width: triggerRect.width },
        menu: { left: menuRect.left, right: menuRect.right, top: menuRect.top, width: menuRect.width },
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    expect(geometry.menu.top).toBeGreaterThanOrEqual(geometry.trigger.bottom);
    expect(geometry.menu.left).toBeGreaterThanOrEqual(0);
    expect(geometry.menu.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(Math.abs(geometry.menu.width - geometry.trigger.width)).toBeLessThanOrEqual(1);

    const experienceRequest = page.waitForRequest((request) =>
      isDirectoryRequest(request, (params) => params.get("sort") === "experience")
    );
    await options.filter({ hasText: "Most experience" }).click();
    await experienceRequest;
    await expect(nativeSelect).toHaveValue("experience");
    await expect(page.locator("#sortMenuValue")).toHaveText("Most experience");
    await expect(options.filter({ hasText: "Most experience" })).toHaveAttribute("aria-selected", "true");
    await expect(trigger).toBeFocused();
    await expect(menu).toBeHidden();

    await trigger.press("ArrowDown");
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    const alphaRequest = page.waitForRequest((request) =>
      isDirectoryRequest(request, (params) => params.get("sort") === "alpha")
    );
    await page.keyboard.press("Enter");
    await alphaRequest;
    await expect(nativeSelect).toHaveValue("alpha");
    await expect(page.locator("#sortMenuValue")).toHaveText("Name A–Z");
    await expect(trigger).toBeFocused();

    await trigger.press("Space");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.press("Enter");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  }
});

test("filter lists stay inside the panel and preserve Apply and Reset behavior", async ({ page }) => {
  test.setTimeout(90_000);
  await mockPublicDirectory(page);

  for (const viewport of PHASE_TWO_VIEWPORTS) {
    await openSettledDirectory(page, viewport);
    const toggle = page.locator("#filterToggle");
    const panel = page.locator("#filterMenu");
    const specialtyInput = page.locator("#specialtyInput");
    const specialtyList = page.locator("#specialtyList");
    const stateInput = page.locator("#stateInput");
    const stateList = page.locator("#stateList");

    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panelBounds = await panel.boundingBox();
    expect(panelBounds.x).toBeGreaterThanOrEqual(0);
    expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(viewport.width + 1);
    const controlStyles = await page.evaluate(() => {
      const controls = ["experience", "specialtyInput", "stateInput"].map((id) =>
        document.getElementById(id).getBoundingClientRect().width
      );
      const navyProbe = document.createElement("span");
      navyProbe.style.backgroundColor = "var(--navy)";
      document.body.appendChild(navyProbe);
      const navyBackground = getComputedStyle(navyProbe).backgroundColor;
      navyProbe.remove();
      return {
        fieldWidths: controls,
        applyBackground: getComputedStyle(document.getElementById("applyFilters")).backgroundColor,
        navyBackground,
      };
    });
    expect(Math.max(...controlStyles.fieldWidths) - Math.min(...controlStyles.fieldWidths)).toBeLessThanOrEqual(1);
    expect(controlStyles.applyBackground).toBe(controlStyles.navyBackground);
    expect(controlStyles.applyBackground).not.toBe("rgb(99, 91, 255)");

    await page.locator("#experience").selectOption("3+ years");
    await specialtyInput.click();
    await expect(specialtyInput).toHaveAttribute("aria-expanded", "true");
    await expect(specialtyList).toBeVisible();
    await expect(specialtyList.locator("[role='option']")).toHaveCount(42);
    await expect(stateInput).toHaveAttribute("aria-expanded", "false");

    let listLayout = await page.evaluate(() => {
      const panelRect = document.getElementById("filterMenu").getBoundingClientRect();
      const inputRect = document.getElementById("specialtyInput").getBoundingClientRect();
      const list = document.getElementById("specialtyList");
      const listRect = list.getBoundingClientRect();
      const actionRect = document.querySelector("#filterMenu .filter-actions").getBoundingClientRect();
      return {
        panel: { top: panelRect.top, bottom: panelRect.bottom },
        inputWidth: inputRect.width,
        list: { top: listRect.top, bottom: listRect.bottom, width: listRect.width },
        actionsTop: actionRect.top,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
      };
    });
    expect(Math.abs(listLayout.list.width - listLayout.inputWidth)).toBeLessThanOrEqual(1);
    expect(listLayout.list.bottom).toBeLessThanOrEqual(listLayout.actionsTop + 1);
    expect(listLayout.scrollHeight).toBeGreaterThan(listLayout.clientHeight);

    const firstSpecialty = specialtyList.locator("[role='option']").first();
    await firstSpecialty.click();
    await expect(firstSpecialty).toHaveAttribute("aria-selected", "true");
    await expect(specialtyInput).toHaveValue("1 specialty selected");
    await specialtyList.locator("[role='option']").last().scrollIntoViewIfNeeded();

    await stateInput.click();
    await expect(specialtyList).toBeHidden();
    await expect(specialtyInput).toHaveAttribute("aria-expanded", "false");
    await expect(stateList).toBeVisible();
    await expect(stateList.locator("[role='option']")).toHaveCount(51);
    await expect(stateInput).toHaveAttribute("aria-expanded", "true");

    listLayout = await page.evaluate(() => {
      const inputRect = document.getElementById("stateInput").getBoundingClientRect();
      const list = document.getElementById("stateList");
      const listRect = list.getBoundingClientRect();
      const actionRect = document.querySelector("#filterMenu .filter-actions").getBoundingClientRect();
      return {
        inputWidth: inputRect.width,
        listBottom: listRect.bottom,
        listWidth: listRect.width,
        actionsTop: actionRect.top,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
      };
    });
    expect(Math.abs(listLayout.listWidth - listLayout.inputWidth)).toBeLessThanOrEqual(1);
    expect(listLayout.listBottom).toBeLessThanOrEqual(listLayout.actionsTop + 1);
    expect(listLayout.scrollHeight).toBeGreaterThan(listLayout.clientHeight);

    const firstState = stateList.locator("[role='option']").first();
    await firstState.click();
    await expect(firstState).toHaveAttribute("aria-selected", "true");
    await expect(stateInput).toHaveValue("1 state selected");
    await stateList.locator("[role='option']").last().scrollIntoViewIfNeeded();

    const appliedRequest = page.waitForRequest((request) =>
      isDirectoryRequest(request, (params) =>
        params.get("minYears") === "3" &&
        params.get("practice") === "Administrative Law" &&
        params.get("location") === "Alabama"
      )
    );
    await page.locator("#applyFilters").scrollIntoViewIfNeeded();
    await page.locator("#applyFilters").click();
    await appliedRequest;
    await expect(panel).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();
    const resetRequest = page.waitForRequest((request) =>
      isDirectoryRequest(request, (params) =>
        !params.has("minYears") && !params.has("practice") && !params.has("location")
      )
    );
    await page.locator("#clearFilters").click();
    await resetRequest;
    await expect(panel).toBeHidden();
    await expect(page.locator("#experience")).toHaveValue("");
    await expect(specialtyInput).toHaveValue("");
    await expect(stateInput).toHaveValue("");
    await expect(toggle).toHaveAttribute("aria-label", "Open filters");
  }
});

test("filter lists support mutual exclusion, outside click, and keyboard navigation", async ({ page }) => {
  await mockPublicDirectory(page);
  await openSettledDirectory(page, { width: 390, height: 844 });

  const toggle = page.locator("#filterToggle");
  const panel = page.locator("#filterMenu");
  const specialtyInput = page.locator("#specialtyInput");
  const specialtyList = page.locator("#specialtyList");
  const stateInput = page.locator("#stateInput");
  const stateList = page.locator("#stateList");

  await toggle.click();
  await specialtyInput.focus();
  await specialtyInput.press("ArrowDown");
  await expect(specialtyList).toBeVisible();
  await expect(specialtyList.locator("[role='option']").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(specialtyList.locator("[role='option']").last()).toBeFocused();
  await page.keyboard.press("Space");
  await expect(specialtyList.locator("[role='option']").last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(specialtyList).toBeHidden();
  await expect(specialtyInput).toBeFocused();
  await expect(panel).toBeVisible();

  await stateInput.press("Space");
  await expect(stateList).toBeVisible();
  await expect(stateList.locator("[role='option']").first()).toBeFocused();
  await specialtyInput.click();
  await expect(stateList).toBeHidden();
  await expect(stateInput).toHaveAttribute("aria-expanded", "false");
  await expect(specialtyList).toBeVisible();

  await page.locator("#experience").click();
  await expect(specialtyList).toBeHidden();
  await expect(specialtyInput).toHaveAttribute("aria-expanded", "false");

  await page.mouse.click(8, Math.round(page.viewportSize().height / 2));
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("mobile touch can operate sort and switch between both filter lists", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await mockPublicDirectory(page);
    await page.goto("/browse-paralegals.html", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#resultsStatus")).toHaveText("No paralegals match your filters yet.");

    await page.tap("#sortMenuTrigger");
    await expect(page.locator("#sortMenuOptions")).toBeVisible();
    await page.locator("#sortMenuOptions [data-sort-value='experience']").tap();
    await expect(page.locator("#sortBy")).toHaveValue("experience");

    await page.tap("#filterToggle");
    await page.tap("#specialtyInput");
    await expect(page.locator("#specialtyList")).toBeVisible();
    await page.tap("#stateInput");
    await expect(page.locator("#specialtyList")).toBeHidden();
    await expect(page.locator("#stateList")).toBeVisible();
    await expect(page.locator("#stateInput")).toHaveAttribute("aria-expanded", "true");
  } finally {
    await context.close();
  }
});
