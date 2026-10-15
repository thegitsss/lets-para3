const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const repositoryRoot = path.resolve(__dirname, "../..");
const frontendRoot = path.join(repositoryRoot, "frontend");
const dashboardPath = path.join(frontendRoot, "dashboard-attorney.html");
const widths = [320, 360, 375, 390, 430, 768];

function contentTypeFor(filePath) {
  return {
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function buildFixture() {
  const source = fs.readFileSync(dashboardPath, "utf8");
  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  const mobileNavigation = scripts.find((script) => (
    script.includes('const sidebarToggle = document.getElementById("sidebarToggle")')
    && script.includes("syncSidebarToggle")
  ));
  assert.ok(mobileNavigation, "Attorney dashboard mobile-navigation implementation was not found");
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace("</body>", `<script>${mobileNavigation}</script></body>`);
}

function rectanglesOverlap(first, second, gap = 0) {
  return !(
    first.right + gap <= second.left
    || second.right + gap <= first.left
    || first.bottom + gap <= second.top
    || second.bottom + gap <= first.top
  );
}

async function readLayout(page) {
  return page.evaluate(() => {
    const rectangle = (selector) => {
      const node = document.querySelector(selector);
      if (!node || !node.getClientRects().length) return null;
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    };
    const sidebar = document.getElementById("sidebarNav");
    const toggle = document.getElementById("sidebarToggle");
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyOpen: document.body.classList.contains("nav-open"),
      toggle: rectangle("#sidebarToggle"),
      brand: rectangle("#sidebarNav .logo"),
      sidebar: rectangle("#sidebarNav"),
      account: rectangle(".topbar-header-slot"),
      content: rectangle(".view-home"),
      expanded: toggle?.getAttribute("aria-expanded"),
      label: toggle?.getAttribute("aria-label"),
      controls: toggle?.getAttribute("aria-controls"),
      sidebarHidden: sidebar?.getAttribute("aria-hidden"),
      sidebarInert: sidebar?.hasAttribute("inert"),
      activeElementId: document.activeElement?.id || "",
      activeInsideSidebar: Boolean(document.activeElement?.closest("#sidebarNav")),
    };
  });
}

function assertUnclipped(rect, width, label) {
  if (!rect) return;
  assert.ok(rect.left >= -1, `${label} is clipped on the left: ${JSON.stringify(rect)}`);
  assert.ok(rect.right <= width + 1, `${label} is clipped on the right: ${JSON.stringify(rect)}`);
}

function assertLayout(layout, width, state) {
  assert.ok(layout.toggle, `${width}px ${state}: menu control is not rendered`);
  assert.ok(layout.toggle.width >= 44 && layout.toggle.height >= 44, `${width}px ${state}: menu control is below 44px touch target`);
  assert.equal(layout.controls, "sidebarNav", `${width}px ${state}: menu control relationship is missing`);
  assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `${width}px ${state}: page clips horizontally`);
  assertUnclipped(layout.toggle, width, `${width}px ${state} menu control`);
  assertUnclipped(layout.account, width, `${width}px ${state} account controls`);
  assertUnclipped(layout.content, width, `${width}px ${state} page content`);
  if (layout.account) {
    assert.equal(rectanglesOverlap(layout.toggle, layout.account, 8), false, `${width}px ${state}: menu and account controls overlap`);
  }
  if (layout.content) {
    assert.equal(rectanglesOverlap(layout.toggle, layout.content, 8), false, `${width}px ${state}: menu and page content overlap`);
  }
  if (layout.bodyOpen) {
    assert.ok(layout.brand && layout.sidebar, `${width}px ${state}: open drawer brand is not rendered`);
    assert.equal(
      rectanglesOverlap(layout.toggle, layout.brand, 8),
      false,
      `${width}px ${state}: menu and brand overlap: ${JSON.stringify({ toggle: layout.toggle, brand: layout.brand })}`
    );
    assert.ok(layout.brand.top >= layout.sidebar.top && layout.brand.bottom <= layout.sidebar.bottom, `${width}px ${state}: brand clips outside drawer`);
    if (state === "open" || state === "keyboard-open") {
      assertUnclipped(layout.brand, width, `${width}px ${state} brand`);
    }
  }
}

async function verifyWidth(browser, html, width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await page.route("http://mobile.lpc/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/dashboard-attorney.html") {
      await route.fulfill({ contentType: "text/html", body: html });
      return;
    }
    const localPath = path.resolve(frontendRoot, `.${url.pathname}`);
    if (!localPath.startsWith(`${frontendRoot}${path.sep}`) || !fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    await route.fulfill({ contentType: contentTypeFor(localPath), body: fs.readFileSync(localPath) });
  });

  await page.goto("http://mobile.lpc/dashboard-attorney.html");
  await page.waitForTimeout(300);
  let layout = await readLayout(page);
  assert.equal(layout.bodyOpen, false);
  assert.equal(layout.expanded, "false");
  assert.equal(layout.label, "Show menu");
  assert.equal(layout.sidebarHidden, "true");
  assert.equal(layout.sidebarInert, true);
  assertLayout(layout, width, "closed");

  await page.tap("#sidebarToggle");
  layout = await readLayout(page);
  assert.equal(layout.bodyOpen, true);
  assert.equal(layout.expanded, "true");
  assert.equal(layout.label, "Hide menu");
  assert.equal(layout.sidebarHidden, "false");
  assert.equal(layout.sidebarInert, false);
  assert.equal(layout.activeInsideSidebar, true, `${width}px opening: focus did not enter the drawer`);
  assertLayout(layout, width, "opening");
  await page.waitForTimeout(300);
  assertLayout(await readLayout(page), width, "open");

  await page.tap("#sidebarToggle");
  layout = await readLayout(page);
  assert.equal(layout.bodyOpen, false);
  assert.equal(layout.expanded, "false");
  assert.equal(layout.label, "Show menu");
  assert.equal(layout.sidebarHidden, "true");
  assert.equal(layout.sidebarInert, true);
  assert.equal(layout.activeElementId, "sidebarToggle", `${width}px closing: focus did not return to the menu control`);
  assertLayout(layout, width, "closing");
  await page.waitForTimeout(300);
  assertLayout(await readLayout(page), width, "closed-after-touch");

  await page.focus("#sidebarToggle");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  layout = await readLayout(page);
  assert.equal(layout.bodyOpen, true);
  assert.equal(layout.activeInsideSidebar, true, `${width}px keyboard open: focus did not enter the drawer`);
  assertLayout(layout, width, "keyboard-open");
  await page.keyboard.press("Escape");
  layout = await readLayout(page);
  assert.equal(layout.bodyOpen, false);
  assert.equal(layout.activeElementId, "sidebarToggle", `${width}px keyboard close: focus did not return to the menu control`);
  assertLayout(layout, width, "keyboard-closing");

  await context.close();
}

(async () => {
  const html = buildFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of widths) await verifyWidth(browser, html, width);
    process.stdout.write(`Attorney mobile navigation passed at ${widths.join(", ")}px across closed, opening, open, and closing states.\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
