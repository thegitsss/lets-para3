const { test, expect } = require("../support-session-fixture");

async function readSidebar(page) {
  await expect(page.locator("#sidebarNav .lpc-sidebar-profile-trigger")).toBeVisible();
  await expect(page.locator("#sidebarNav nav .lpc-sidebar-nav-link").first()).toBeVisible();
  return page.locator("#sidebarNav").evaluate((sidebar) => {
    const style = (node) => getComputedStyle(node);
    const rect = (node) => node.getBoundingClientRect();
    const measured = (value) => Math.round(Number(value) * 1000) / 1000;
    const profile = sidebar.querySelector(".lpc-sidebar-profile-trigger");
    const nav = sidebar.querySelector("nav:not([hidden])");
    const footer = sidebar.querySelector(".sidebar-footer");
    return {
      sidebar: {
        width: measured(rect(sidebar).width),
        padding: style(sidebar).padding,
        background: style(sidebar).backgroundColor,
        borderRight: style(sidebar).borderRight,
      },
      profile: {
        height: measured(rect(profile).height),
        padding: style(profile).padding,
        borderRadius: style(profile).borderRadius,
        background: style(profile).backgroundColor,
      },
      nav: {
        gap: style(nav).gap,
        labels: Array.from(nav.querySelectorAll(":scope > .lpc-sidebar-nav-link"))
          .filter((link) => rect(link).width > 0 && rect(link).height > 0)
          .map((link) => String(link.querySelector(".lpc-sidebar-nav-label")?.textContent || link.textContent || "").trim()),
        links: Array.from(nav.querySelectorAll(":scope > .lpc-sidebar-nav-link"))
          .filter((link) => rect(link).width > 0 && rect(link).height > 0)
          .map((link) => ({
          height: measured(rect(link).height),
          padding: style(link).padding,
          borderRadius: style(link).borderRadius,
          fontSize: style(link).fontSize,
          lineHeight: style(link).lineHeight,
          minHeight: style(link).minHeight,
          boxSizing: style(link).boxSizing,
          iconWidth: measured(rect(link.querySelector(".sidebar-nav-icon")).width),
          iconMarkup: link.querySelector(".sidebar-nav-icon")?.innerHTML || "",
          })),
      },
      footer: {
        text: String(footer?.textContent || "").trim(),
        fontSize: footer ? style(footer).fontSize : "",
        textAlign: footer ? style(footer).textAlign : "",
      },
    };
  });
}

test("paralegal member pages use the Home sidebar presentation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  const home = await readSidebar(page);
  await page.screenshot({ path: "/tmp/lpc-sidebar-home.png", fullPage: false });

  await page.goto("/browse-jobs.html", { waitUntil: "domcontentloaded" });
  const browse = await readSidebar(page);
  await page.screenshot({ path: "/tmp/lpc-sidebar-browse.png", fullPage: false });

  expect(browse).toEqual(home);

  await page.goto("/profile-settings.html", { waitUntil: "domcontentloaded" });
  const settings = await readSidebar(page);
  expect(settings.sidebar).toEqual(home.sidebar);
  expect(settings.profile).toEqual(home.profile);
  expect(settings.footer).toEqual(home.footer);
  expect(settings.nav.gap).toEqual(home.nav.gap);
  const homeLinkPresentation = home.nav.links.map(({ iconMarkup, ...presentation }) => presentation);
  const settingsLinkPresentation = settings.nav.links.map(({ iconMarkup, ...presentation }) => presentation);
  for (const presentation of settingsLinkPresentation) {
    expect(homeLinkPresentation).toContainEqual(presentation);
  }
});

test("paralegal member pages use the Home mobile sidebar presentation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const openAndRead = async (url) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#sidebarToggle")).toBeVisible();
    await page.locator("#sidebarToggle").click();
    await expect(page.locator("#sidebarNav .lpc-sidebar-profile-trigger")).toBeVisible();
    return readSidebar(page);
  };

  const home = await openAndRead("/dashboard-paralegal.html");
  const browse = await openAndRead("/browse-jobs.html");
  expect(browse).toEqual(home);

  const settings = await openAndRead("/profile-settings.html");
  expect(settings.sidebar).toEqual(home.sidebar);
  expect(settings.profile).toEqual(home.profile);
  expect(settings.footer).toEqual(home.footer);
  expect(settings.nav.gap).toEqual(home.nav.gap);
});
