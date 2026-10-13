const { test, expect } = require("../support-session-fixture");

const PHASE_ONE_VIEWPORTS = [
  { width: 320, height: 720 },
  { width: 360, height: 800 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

async function shellGeometry(page) {
  return page.evaluate(() => {
    const visible = (node) => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
    const rect = (node) => {
      const box = node?.getBoundingClientRect();
      return box ? [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 10) / 10) : null;
    };
    const sidebar = document.getElementById("sidebarNav");
    const header = document.querySelector("[data-lpc-universal-header='true']");
    const controls = header?.querySelector(":scope > .lpc-universal-header-controls");
    const main = document.querySelector("main#main");
    const toggle = document.getElementById("sidebarToggle");
    const profile = sidebar?.querySelector("[data-lpc-sidebar-profile-trigger]");
    return {
      sidebar: rect(sidebar),
      header: rect(header),
      controls: rect(controls),
      main: rect(main),
      toggle: rect(toggle),
      profile: rect(profile),
      sidebarVisible: visible(sidebar),
      headerVisible: visible(header),
      controlsVisible: visible(controls),
      mainVisible: visible(main),
      toggleVisible: visible(toggle),
      profileVisible: visible(profile),
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

function overlap(first, second) {
  if (!first || !second) return false;
  const [ax, ay, aw, ah] = first;
  const [bx, by, bw, bh] = second;
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

async function dismissTour(page) {
  for (const selector of ["#tourCloseBtn", "#profileTourCloseBtn"]) {
    const close = page.locator(selector);
    if (await close.isVisible().catch(() => false)) await close.click();
  }
}

test("authenticated paralegal shell remains geometrically stable at every Phase 1 width", async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const me = await page.request.get("/api/users/me");
  const user = await me.json();
  const userId = String(user?._id || user?.id || "");
  expect(userId).toMatch(/^[a-f0-9]{24}$/i);

  const surfaces = [
    "/dashboard-paralegal.html",
    "/dashboard-paralegal.html#cases",
    "/browse-jobs.html",
    "/profile-settings.html",
    `/profile-paralegal.html?paralegalId=${encodeURIComponent(userId)}`,
    "/case-detail.html",
  ];

  for (const url of surfaces) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/login\.html/);
    await dismissTour(page);
    if (url === "/case-detail.html") {
      const picker = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Choose a Matter", exact: true }) });
      await expect(picker).toBeVisible();
      await picker.getByRole("button", { name: "Close", exact: true }).click();
      await expect(picker).toBeHidden();
    }
    if (url === "/profile-settings.html") {
      await expect(page.locator("body")).toHaveClass(/paralegal-flat/);
    }
    await expect(page.locator("[data-lpc-universal-header='true']")).toBeVisible();
    await expect(page.locator("#sidebarNav [data-lpc-sidebar-profile-trigger]")).toBeAttached();
    await expect(page.locator(".support-launcher")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    for (const viewport of PHASE_ONE_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(260);
      const first = await shellGeometry(page);
      await page.waitForTimeout(140);
      const settled = await shellGeometry(page);

      expect(settled, `${url} at ${viewport.width}px`).toEqual(first);
      expect(settled.headerVisible, `${url} header at ${viewport.width}px`).toBe(true);
      expect(settled.controlsVisible, `${url} controls at ${viewport.width}px`).toBe(true);
      expect(settled.mainVisible, `${url} content at ${viewport.width}px`).toBe(true);
      expect(settled.scrollWidth, `${url} overflow at ${viewport.width}px`).toBeLessThanOrEqual(settled.width + 1);
      expect(settled.header[0], `${url} header left edge at ${viewport.width}px`).toBeGreaterThanOrEqual(0);
      expect(settled.header[0] + settled.header[2], `${url} header right edge at ${viewport.width}px`).toBeLessThanOrEqual(settled.width + 1);
      expect(settled.controls[0] + settled.controls[2], `${url} tool clipping at ${viewport.width}px`).toBeLessThanOrEqual(settled.width + 1);
      expect(settled.main[1], `${url} content/header overlap at ${viewport.width}px`).toBeGreaterThanOrEqual(settled.header[1] + settled.header[3] - 1);

      if (viewport.width <= 1024) {
        expect(settled.toggleVisible, `${url} menu control at ${viewport.width}px`).toBe(true);
        expect(overlap(settled.toggle, settled.controls), `${url} menu/header overlap at ${viewport.width}px`).toBe(false);
        await page.locator("#sidebarToggle").click();
        await expect(page.locator("body"), `${url} menu opens at ${viewport.width}px`).toHaveClass(/nav-open/);
        await expect(page.locator("#sidebarToggle")).toHaveAttribute("aria-expanded", "true");
        const open = await shellGeometry(page);
        expect(open.profileVisible, `${url} open account control at ${viewport.width}px`).toBe(true);
        expect(overlap(open.toggle, open.profile), `${url} menu/account overlap at ${viewport.width}px`).toBe(false);
        await page.keyboard.press("Escape");
        await expect(page.locator("body")).not.toHaveClass(/nav-open/);
        await expect(page.locator("#sidebarToggle")).toHaveAttribute("aria-expanded", "false");
      } else {
        expect(settled.sidebarVisible, `${url} desktop sidebar at ${viewport.width}px`).toBe(true);
        expect(settled.profileVisible, `${url} desktop account control at ${viewport.width}px`).toBe(true);
        expect(settled.sidebar[0] + settled.sidebar[2], `${url} sidebar/header boundary at ${viewport.width}px`).toBeLessThanOrEqual(settled.header[0] + 1);
      }
    }
  }
});

test("primary paralegal surfaces share one content anchor", async ({ page }) => {
  const surfaces = [
    { url: "/dashboard-paralegal.html#home", selector: "#paralegalHomeView" },
    { url: "/dashboard-paralegal.html#cases", selector: "#paralegalCasesView" },
    { url: "/browse-jobs.html", selector: ".jobs-shell" },
    { url: "/profile-settings.html", selector: ".page-header" },
  ];

  for (const viewport of [
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    const anchors = [];
    for (const surface of surfaces) {
      await page.setViewportSize(viewport);
      await page.goto(surface.url, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/login\.html/);
      await dismissTour(page);
      const content = page.locator(surface.selector);
      await expect(content).toBeVisible();
      await expect(page.locator("[data-lpc-universal-header='true']")).toBeVisible();
      const box = await content.boundingBox();
      anchors.push({
        url: surface.url,
        x: Math.round(box.x),
        y: Math.round(box.y),
      });
    }

    const expected = anchors[0].x;
    for (const anchor of anchors) {
      expect(
        Math.abs(anchor.x - expected),
        `${anchor.url} content rail at ${viewport.width}px: ${JSON.stringify(anchors)}`
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(anchor.y - anchors[0].y),
        `${anchor.url} content start at ${viewport.width}px: ${JSON.stringify(anchors)}`
      ).toBeLessThanOrEqual(1);
    }
  }
});

test("cross-document sidebar navigation keeps the existing shell until the next shell is ready", async ({ page }, testInfo) => {
  const expectsNativeViewTransition = testInfo.project.name === "chromium";
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard-paralegal.html#home", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#sidebarNav nav:visible > .lpc-sidebar-nav-link")).toHaveCount(5);

  const navigateWithoutBlanking = async (selector, destination, nativeTransition = true) => {
    await page.evaluate(() => {
      sessionStorage.removeItem("lpc:last-navigation-used-view-transition");
      window.addEventListener("pageswap", (event) => {
        // The outgoing transition's ready promise rejects when that document
        // is hidden. Handle the observer-owned promise, retaining page errors
        // from application code and the actual shell/navigation assertions.
        event.viewTransition?.ready.catch(() => {});
        sessionStorage.setItem(
          "lpc:last-navigation-used-view-transition",
          event.viewTransition ? "true" : "false"
        );
      }, { once: true });
    });
    await page.locator(selector).click();
    await page.waitForURL(destination);
    await expect(page.locator("[data-lpc-universal-header='true']")).toBeVisible();
    await expect(page.locator("#sidebarNav nav:visible > .lpc-sidebar-nav-link")).toHaveCount(5);
    if (expectsNativeViewTransition) {
      expect(await page.evaluate(() => sessionStorage.getItem("lpc:last-navigation-used-view-transition"))).toBe(String(nativeTransition));
    }
  };

  await navigateWithoutBlanking('#sidebarNav a[href="browse-jobs.html"]', /\/browse-jobs\.html$/);
  await navigateWithoutBlanking('#sidebarNav a[href="profile-settings.html"]', /\/profile-settings\.html$/, false);
  await navigateWithoutBlanking('#sidebarNav a[href="dashboard-paralegal.html#home"]', /\/dashboard-paralegal\.html(?:#home)?$/);

  await page.evaluate(() => {
    document.getElementById("sidebarNav").dataset.navigationIdentity = "preserved";
    document.querySelector("[data-lpc-universal-header='true']").dataset.navigationIdentity = "preserved";
  });
  await page.locator('#sidebarNav a[href="#cases"]').click();
  await expect(page).toHaveURL(/\/dashboard-paralegal\.html#cases$/);
  await expect(page.locator("#paralegalCasesView")).toBeVisible();
  await expect(page.locator('#sidebarNav[data-navigation-identity="preserved"]')).toBeVisible();
  await expect(page.locator('[data-lpc-universal-header="true"][data-navigation-identity="preserved"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("authenticated sidebars are structurally complete before enhancement", async ({ page }) => {
  for (const url of ["/dashboard-paralegal.html", "/browse-jobs.html", "/profile-settings.html"]) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const nav = page.locator(url === "/profile-settings.html" ? "#sidebarNav .paralegal-account-nav" : "#sidebarNav nav").first();
    const links = nav.locator(":scope > .lpc-sidebar-nav-link");
    await expect(links, `${url} navigation links`).toHaveCount(5);
    await expect(nav.locator(":scope > .lpc-sidebar-section-label")).toHaveText("Account");
    for (const link of await links.all()) {
      await expect(link.locator(":scope > .sidebar-nav-icon")).toHaveCount(1);
      await expect(link.locator(":scope > .lpc-sidebar-nav-label")).toHaveCount(1);
    }
  }
});

test("public paralegal Help remains stable and unclipped at every Phase 1 width", async ({ page }) => {
  await page.goto("/paralegalhelp.html", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Help for Paralegals", exact: true })).toBeVisible();
  for (const viewport of PHASE_ONE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(80);
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      main: Boolean(document.querySelector("main#main")?.getClientRects().length),
    }));
    expect(layout.main).toBe(true);
    expect(layout.scrollWidth, `Help overflow at ${viewport.width}px`).toBeLessThanOrEqual(layout.width + 1);
  }
});
