const { test, expect } = require("../support-session-fixture");

async function readHeader(page) {
  await page.mouse.move(1, 500);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(260);
  const header = page.locator("[data-lpc-universal-header='true']").first();
  await expect(header).toBeVisible();
  await expect(header.locator(":scope > .lpc-universal-header-controls")).toBeVisible();
  await expect(header.locator(".lpc-global-search-host")).toBeVisible();

  return header.evaluate((node) => {
    const style = (element) => getComputedStyle(element);
    const rect = (element) => element.getBoundingClientRect();
    const controls = node.querySelector(":scope > .lpc-universal-header-controls");
    const search = controls.querySelector(".lpc-global-search-host");
    const trigger = search.querySelector(".lpc-global-search-trigger");
    const label = search.querySelector(".lpc-global-search-trigger-label");
    const notification = controls.querySelector(".notification-icon");
    const assistant = controls.querySelector(".support-launcher");
    const headerRect = rect(node);
    const controlsRect = rect(controls);
    return {
      header: {
        height: rect(node).height,
        minHeight: style(node).minHeight,
        margin: style(node).margin,
        padding: style(node).padding,
        display: style(node).display,
        alignItems: style(node).alignItems,
        justifyContent: style(node).justifyContent,
        gap: style(node).gap,
        background: style(node).backgroundColor,
        borderStyle: style(node).borderStyle,
        borderWidth: style(node).borderWidth,
      },
      controls: {
        height: rect(controls).height,
        gap: style(controls).gap,
        justifyContent: style(controls).justifyContent,
        rightInset: Math.abs(Math.round((headerRect.right - controlsRect.right) * 100) / 100),
      },
      search: {
        width: rect(search).width,
        height: rect(search).height,
        triggerHeight: rect(trigger).height,
        labelWidth: rect(label).width,
        labelOpacity: style(label).opacity,
      },
      notification: {
        width: rect(notification).width,
        height: rect(notification).height,
      },
      assistant: {
        width: rect(assistant).width,
        height: rect(assistant).height,
      },
    };
  });
}

test("Home and Account Settings use the Browse Matters header", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto("/browse-jobs.html", { waitUntil: "domcontentloaded" });
  const browse = await readHeader(page);

  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  const home = await readHeader(page);
  expect(home).toEqual(browse);

  const tourClose = page.locator("#tourCloseBtn");
  if (await tourClose.isVisible().catch(() => false)) await tourClose.click();

  await page.locator(".lpc-global-search-trigger").click();
  await expect(page.locator("#lpcGlobalSearchDialog")).toBeVisible();
  await expect(page.locator("#lpcGlobalSearchInput")).toBeVisible();
  const searchLayer = await page.locator("#lpcGlobalSearchInput").evaluate((input) => {
    const box = input.getBoundingClientRect();
    const point = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const dialog = input.closest(".lpc-global-search-dialog");
    const header = document.querySelector("[data-lpc-universal-header='true']");
    const trigger = document.querySelector(".lpc-global-search-trigger");
    const triggerBox = trigger.getBoundingClientRect();
    const dialogBox = dialog.getBoundingClientRect();
    return {
      receivesPointer: Boolean(point && dialog?.contains(point)),
      dialogZIndex: Number(getComputedStyle(dialog).zIndex),
      headerZIndex: Number(getComputedStyle(header).zIndex),
      triggerWidth: triggerBox.width,
      triggerHeight: triggerBox.height,
      dialogWidth: dialogBox.width,
      dropdownGap: dialogBox.top - triggerBox.bottom,
      rightAlignment: Math.abs(dialogBox.right - triggerBox.right),
      dialogShadow: getComputedStyle(dialog).boxShadow,
    };
  });
  expect(searchLayer.receivesPointer).toBe(true);
  expect(searchLayer.dialogZIndex).toBeGreaterThan(searchLayer.headerZIndex);
  expect(searchLayer.triggerWidth).toBe(46);
  expect(searchLayer.triggerHeight).toBe(46);
  expect(searchLayer.dialogWidth).toBe(360);
  expect(searchLayer.dropdownGap).toBeGreaterThanOrEqual(7);
  expect(searchLayer.rightAlignment).toBeLessThanOrEqual(1);
  expect(searchLayer.dialogShadow).toBe("none");
  await page.keyboard.press("Escape");

  await page.goto("/profile-settings.html", { waitUntil: "domcontentloaded" });
  const settings = await readHeader(page);
  expect(settings).toEqual(browse);
  await page.screenshot({ path: `/tmp/lpc-global-header-${testInfo.project.name}.png`, fullPage: false });
});

test("Home and Account Settings use the Browse Matters mobile header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/browse-jobs.html", { waitUntil: "domcontentloaded" });
  const browse = await readHeader(page);

  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  expect(await readHeader(page)).toEqual(browse);

  await page.goto("/profile-settings.html", { waitUntil: "domcontentloaded" });
  expect(await readHeader(page)).toEqual(browse);
});

test("authenticated sidebars keep the profile cluster and selected destination unfilled", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const url of ["/dashboard-paralegal.html", "/browse-jobs.html", "/profile-settings.html"]) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const profile = page.locator("#sidebarNav .lpc-sidebar-profile-trigger");
    const active = page.locator('#sidebarNav nav :is(a, button).active, #sidebarNav nav a[aria-current="page"]').first();
    await expect(profile, `${url} profile cluster`).toBeVisible();
    await expect(active, `${url} selected destination`).toBeVisible();

    const styles = await page.evaluate(() => {
      const read = (node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, shadow: style.boxShadow, color: style.color };
      };
      return {
        profile: read(document.querySelector("#sidebarNav .lpc-sidebar-profile-trigger")),
        active: read(document.querySelector('#sidebarNav nav :is(a, button).active, #sidebarNav nav a[aria-current="page"]')),
      };
    });
    expect(styles.profile.background).toBe("rgba(0, 0, 0, 0)");
    expect(styles.profile.shadow).toBe("none");
    expect(styles.active).toEqual({
      background: "rgba(0, 0, 0, 0)",
      shadow: "none",
      color: "rgb(71, 114, 188)",
    });
  }
});
