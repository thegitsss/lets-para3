const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const searchScript = path.resolve(__dirname, "../../frontend/assets/scripts/global-search.js");
const searchStyles = path.resolve(__dirname, "../../frontend/assets/styles/global-search.css");
const commandRegistry = path.resolve(__dirname, "../../frontend/assets/scripts/productivity-command-registry.js");
const searchScriptSource = fs.readFileSync(searchScript, "utf8");
const searchStylesSource = fs.readFileSync(searchStyles, "utf8");
const commandRegistrySource = fs.readFileSync(commandRegistry, "utf8");
const matterId = "64b000000000000000000001";
const profileId = "64b000000000000000000002";
const repositoryRoot = path.resolve(__dirname, "../..");

function payload(query, { title = "Alpha Matter", includeProfile = true } = {}) {
  return {
    query,
    types: ["matter", "profile"],
    results: {
      matters: [{
        type: "matter",
        id: matterId,
        title,
        status: { code: "in_progress", label: "In progress" },
        practiceArea: "Civil Litigation",
        relationship: { code: "owner", label: "Your matter" },
        attention: null,
        nextAction: { label: "Open matter", href: `/case-detail.html?caseId=${matterId}` },
      }],
      profiles: includeProfile ? [{
        type: "profile",
        id: profileId,
        title: "Taylor Profile",
        headline: "Litigation",
        location: "New York, NY",
        practiceAreas: ["Civil Litigation"],
        nextAction: { label: "View profile", href: `/profile-paralegal.html?paralegalId=${profileId}` },
      }] : [],
    },
  };
}

async function installPage(page, role = "attorney") {
  let retryCount = 0;
  await page.route("http://lpc.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/test") {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta charset="utf-8"><style>:root{--ink:#1a1a1a;--panel:#fff;--line:#ddd;--accent:#b6a47a;--font-sans:Arial;--font-serif:Georgia}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden}.hidden-dashboard-modal{display:none}${searchStylesSource}</style></head><body><aside class="sidebar"><nav><a href="#home">Home</a><a href="#matters">Matters</a></nav></aside><main tabindex="-1"><h1>Dashboard</h1><input id="editor" /></main><div class="hidden-dashboard-modal" role="dialog" aria-modal="true">Closed dashboard modal</div><script>${commandRegistrySource}</script><script>${searchScriptSource}</script></body></html>`,
      });
      return;
    }
    if (url.pathname === "/api/cases/search") {
      const query = url.searchParams.get("q") || "";
      if (query === "loading") {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (query === "none") {
        await route.fulfill({ json: { query, types: ["matter", "profile"], results: { matters: [], profiles: [] } } });
        return;
      }
      if (query === "slow alpha") {
        await new Promise((resolve) => setTimeout(resolve, 350));
        await route.fulfill({ json: payload(query, { title: "Stale Alpha" }) });
        return;
      }
      if (query === "retry") {
        retryCount += 1;
        if (retryCount === 1) {
          await route.fulfill({ status: 503, json: { error: "Temporary" } });
          return;
        }
      }
      await route.fulfill({ json: payload(query, { title: query === "fast beta" ? "Fresh Beta" : "Alpha Matter", includeProfile: role === "attorney" }) });
      return;
    }
    await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Destination</title><p>Destination</p>" });
  });

  await page.addInitScript((viewerRole) => {
    localStorage.setItem("lpc_user", JSON.stringify({ id: "viewer", role: viewerRole, status: "approved" }));
  }, role);
  await page.goto("http://lpc.test/test");
  await page.waitForSelector(".lpc-global-search-trigger");
}

async function runRoleJourney(browser, role) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await installPage(page, role);

  const storageBefore = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  assert.equal(await page.locator(".lpc-global-search-dialog").evaluate((node) => node.open), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "lpcGlobalSearchInput");
  assert.ok(await page.locator("[data-command-code]").count() >= 4);

  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  assert.equal(await page.locator(".lpc-global-search-dialog").evaluate((node) => node.open), false);
  await page.focus("#editor");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  assert.equal(await page.locator(".lpc-global-search-dialog").evaluate((node) => node.open), false);
  await page.click(".lpc-global-search-trigger");

  await page.fill("#lpcGlobalSearchInput", "a");
  await page.waitForTimeout(300);
  assert.match(await page.locator(".lpc-global-search-remote-state").innerText(), /at least 2 characters/i);

  await page.fill("#lpcGlobalSearchInput", "alpha");
  await page.waitForSelector("[data-search-object-type]");
  assert.equal(await page.locator("[data-search-object-type]").count(), role === "attorney" ? 2 : 1);
  assert.match(await page.locator(".lpc-global-search-results").innerText(), /Alpha Matter/);
  if (role === "attorney") assert.match(await page.locator(".lpc-global-search-results").innerText(), /Taylor Profile/);
  else assert.doesNotMatch(await page.locator(".lpc-global-search-results").innerText(), /Taylor Profile/);
  if (role === "attorney") await page.screenshot({ path: "/tmp/lpc-prompt1-search-desktop.png", fullPage: true });

  await page.locator('[data-search-object-type="matter"]').focus();
  const focusedHref = await page.evaluate(() => document.activeElement?.getAttribute("href"));
  assert.equal(focusedHref, `/case-detail.html?caseId=${matterId}`);

  await page.focus("#lpcGlobalSearchInput");
  await page.fill("#lpcGlobalSearchInput", "none");
  await page.waitForFunction(() => document.querySelector(".lpc-global-search-remote-state")?.textContent.includes("No authorized record"));
  assert.match(await page.locator(".lpc-global-search-remote-state").innerText(), /No authorized record/i);

  await page.fill("#lpcGlobalSearchInput", "loading");
  await page.waitForFunction(() => document.querySelector(".lpc-global-search-remote-state")?.textContent.includes("Searching authorized"));

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => (
    !document.querySelector(".lpc-global-search-dialog")?.open &&
    document.activeElement?.classList.contains("lpc-global-search-trigger")
  ));
  assert.equal(await page.locator(".lpc-global-search-dialog").evaluate((node) => node.open), false);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("lpc-global-search-trigger")), true);

  await page.click(".lpc-global-search-trigger");
  await page.fill("#lpcGlobalSearchInput", "retry");
  await page.waitForSelector("[data-search-retry]");
  await page.click("[data-search-retry]");
  await page.waitForSelector("[data-search-object-type]");

  await page.fill("#lpcGlobalSearchInput", "slow alpha");
  await page.waitForTimeout(280);
  await page.fill("#lpcGlobalSearchInput", "fast beta");
  await page.waitForFunction(() => document.querySelector(".lpc-global-search-results")?.textContent.includes("Fresh Beta"));
  await page.waitForTimeout(400);
  const finalText = await page.locator(".lpc-global-search-results").innerText();
  assert.match(finalText, /Fresh Beta/);
  assert.doesNotMatch(finalText, /Stale Alpha/);

  const storageAfter = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.deepEqual(storageAfter, storageBefore);
  await page.close();
}

async function runMobile(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await installPage(page, "attorney");
  await page.click(".lpc-global-search-trigger");
  await page.fill("#lpcGlobalSearchInput", "alpha");
  await page.waitForSelector("[data-search-object-type]");
  const dimensions = await page.locator(".lpc-global-search-dialog").evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scrollWidth: node.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(dimensions.width <= dimensions.viewport);
  assert.ok(dimensions.scrollWidth <= dimensions.width + 1);
  const resultBox = await page.locator(".lpc-global-search-result").first().boundingBox();
  assert.ok(resultBox);
  assert.ok(resultBox.height >= 44);
  await page.screenshot({ path: "/tmp/lpc-prompt1-search-mobile.png", fullPage: true });
  await page.close();
}

async function runMatterCommandJourney(browser) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  await installPage(page, "attorney");
  await page.evaluate((caseIdValue) => {
    window.LPCProductivityContext = {
      caseId: caseIdValue,
      currentTab: "overview",
      availableMatterTabs: ["overview", "applications", "files"],
    };
    window.LPCMatterNavigation = {
      activateTab(tab) {
        window.__activatedMatterTab = tab;
        return true;
      },
    };
  }, matterId);
  const openMilliseconds = await page.evaluate(() => {
    const started = performance.now();
    document.querySelector(".lpc-global-search-trigger").click();
    if (!document.querySelector(".lpc-global-search-dialog")?.open) throw new Error("Palette did not open synchronously");
    return performance.now() - started;
  });
  assert.ok(openMilliseconds < 50, `Expected local palette open under 50ms, received ${openMilliseconds.toFixed(1)}ms`);
  await page.fill("#lpcGlobalSearchInput", "files");
  await page.locator('[data-command-code="matter.files"]').click();
  assert.equal(await page.evaluate(() => window.__activatedMatterTab), "files");
  assert.equal(new URL(page.url()).pathname, "/test");
  await page.close();
}

async function runHistoryJourney(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await installPage(page, "attorney");
  await page.click(".lpc-global-search-trigger");
  await page.fill("#lpcGlobalSearchInput", "alpha");
  await page.waitForSelector("[data-search-object-type]");

  await page.locator('[data-search-object-type="matter"]').click();
  await page.waitForURL(`**/case-detail.html?caseId=${matterId}`);
  const matterUrl = page.url();
  await page.reload();
  assert.equal(page.url(), matterUrl);
  await page.goBack();
  assert.equal(new URL(page.url()).pathname, "/test");

  if (!(await page.locator(".lpc-global-search-dialog").evaluate((node) => node.open))) {
    await page.click(".lpc-global-search-trigger");
  }
  await page.fill("#lpcGlobalSearchInput", "");
  await page.fill("#lpcGlobalSearchInput", "alpha");
  await page.waitForSelector('[data-search-object-type="profile"]');
  await page.locator('[data-search-object-type="profile"]').click();
  await page.waitForURL(`**/profile-paralegal.html?paralegalId=${profileId}`);
  const profileUrl = page.url();
  await page.reload();
  assert.equal(page.url(), profileUrl);
  await page.goBack();
  assert.equal(new URL(page.url()).pathname, "/test");
  await page.close();
}

function withoutScripts(html) {
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
  }[extension] || "application/octet-stream";
}

async function revealStaticVisualFixture(page, { legacyBaseline = false } = {}) {
  const loaderCount = await page.locator("[data-page-loader]").count();
  if (!legacyBaseline) {
    assert.equal(loaderCount, 0, "Current visual evidence must not contain a full-screen page loader");
    return;
  }
  await page.evaluate(() => document.querySelectorAll("[data-page-loader]").forEach((loader) => loader.remove()));
}

async function captureVisualComparison(browser) {
  const targets = [
    { role: "attorney", file: "frontend/dashboard-attorney.html" },
    { role: "paralegal", file: "frontend/dashboard-paralegal.html" },
  ];
  const outputPaths = [];
  for (const target of targets) {
    const baselineHtml = withoutScripts(execFileSync("git", ["show", `HEAD:${target.file}`], { cwd: repositoryRoot, encoding: "utf8" }));
    const currentHtml = withoutScripts(fs.readFileSync(path.join(repositoryRoot, target.file), "utf8"));
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("http://visual.lpc/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/baseline") return route.fulfill({ contentType: "text/html", body: baselineHtml });
      if (url.pathname === "/current") return route.fulfill({ contentType: "text/html", body: currentHtml });
      const localPath = path.resolve(repositoryRoot, `frontend${url.pathname}`);
      const frontendRoot = path.resolve(repositoryRoot, "frontend");
      if (!localPath.startsWith(`${frontendRoot}${path.sep}`) || !fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
        return route.fulfill({ status: 404, body: "" });
      }
      return route.fulfill({ contentType: contentTypeFor(localPath), body: fs.readFileSync(localPath) });
    });
    await page.addInitScript((viewerRole) => {
      localStorage.setItem("lpc_user", JSON.stringify({ id: "viewer", role: viewerRole, status: "approved" }));
    }, target.role);
    for (const variant of ["baseline", "current"]) {
      await page.goto(`http://visual.lpc/${variant}`);
      await revealStaticVisualFixture(page, { legacyBaseline: variant === "baseline" });
      if (variant === "current") {
        await page.addScriptTag({ path: commandRegistry });
        await page.addScriptTag({ path: searchScript });
        const typography = await page.evaluate((viewerRole) => {
          const styleFor = (selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const style = getComputedStyle(node);
            return { family: style.fontFamily, size: parseFloat(style.fontSize), weight: Number(style.fontWeight) };
          };
          return {
            body: styleFor("body"),
            heading: styleFor("h1"),
            button: styleFor(viewerRole === "attorney" ? "[data-matter-save-view]" : '[data-action="browse"]'),
            regular: styleFor(viewerRole === "attorney" ? ".queue-meta" : ".info-label"),
            logo: styleFor(".logo"),
            userName: styleFor("#user-name-heading"),
            brand: styleFor(".lpc-brand-name"),
          };
        }, target.role);
        Object.entries({ body: typography.body, heading: typography.heading, button: typography.button, regular: typography.regular }).forEach(([name, style]) => {
          assert.match(style?.family || "", /Sarabun/i, `${target.role} ${name} typography must use Sarabun`);
        });
        Object.entries({ logo: typography.logo, userName: typography.userName, brand: typography.brand }).forEach(([name, style]) => {
          assert.match(style?.family || "", /Cormorant Garamond/i, `${target.role} ${name} typography must use Cormorant Garamond`);
        });
        assert.ok(typography.heading.weight >= 600, `${target.role} heading typography: ${JSON.stringify(typography.heading)}`);
        assert.ok(typography.button.weight >= 600, `${target.role} button typography: ${JSON.stringify(typography.button)}`);
        assert.ok(typography.button.size >= 14, `${target.role} button typography: ${JSON.stringify(typography.button)}`);
        assert.ok(typography.regular.weight >= 400, `${target.role} regular typography: ${JSON.stringify(typography.regular)}`);
      }
      const output = `/tmp/lpc-prompt1-${target.role}-${variant}.png`;
      await page.screenshot({ path: output, fullPage: true });
      outputPaths.push(output);
      if (variant === "current") {
        const searchState = await page.locator(".lpc-global-search-trigger").evaluate((node) => {
          node.click();
          const dialog = document.querySelector(".lpc-global-search-dialog");
          const blockers = [...document.querySelectorAll('[aria-modal="true"]')]
            .filter((candidate) => {
              if (candidate === dialog || candidate.hidden || candidate.getAttribute("aria-hidden") === "true" || candidate.hasAttribute("inert")) return false;
              const style = getComputedStyle(candidate);
              return style.display !== "none" && style.visibility !== "hidden" && candidate.getClientRects().length > 0;
            })
            .map((candidate) => ({ id: candidate.id, className: candidate.className }));
          return {
            open: Boolean(dialog?.open),
            disabled: node.disabled,
            expanded: node.getAttribute("aria-expanded"),
            blockers,
          };
        });
        assert.equal(searchState.open, true, `${target.role} search did not open: ${JSON.stringify(searchState)}`);
        const openOutput = `/tmp/lpc-prompt1-${target.role}-search-open.png`;
        await page.screenshot({ path: openOutput, fullPage: true });
        outputPaths.push(openOutput);
        await page.keyboard.press("Escape");
        if (target.role === "attorney") {
          await page.evaluate(() => {
            const home = document.querySelector('[data-view="home"]');
            const matters = document.querySelector('[data-view="cases"]');
            if (home) home.hidden = true;
            if (matters) matters.hidden = false;
          });
          const mattersOutput = "/tmp/lpc-prompt1-attorney-matters-typography.png";
          await page.screenshot({ path: mattersOutput, fullPage: true });
          outputPaths.push(mattersOutput);
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://visual.lpc/current");
    await revealStaticVisualFixture(page);
    await page.addScriptTag({ path: commandRegistry });
    await page.addScriptTag({ path: searchScript });
    await page.evaluate(() => {
      document.body.classList.add("nav-open");
      document.querySelector("#sidebarToggle")?.setAttribute("aria-expanded", "true");
      const sidebar = document.querySelector("#sidebarNav");
      if (sidebar) {
        sidebar.style.transform = "translateX(0)";
        sidebar.style.visibility = "visible";
      }
    });
    await page.waitForTimeout(350);
    const mobileNavMetrics = await page.locator("#sidebarNav").evaluate((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return { display: style.display, visibility: style.visibility, opacity: style.opacity, width: rect.width, left: rect.left, zIndex: style.zIndex };
    });
    assert.notEqual(mobileNavMetrics.display, "none");
    assert.equal(mobileNavMetrics.visibility, "visible");
    assert.ok(mobileNavMetrics.width >= 200);
    assert.ok(mobileNavMetrics.left >= -1);
    assert.ok(Number(mobileNavMetrics.zIndex) > 1900);
    const mobileHeaderSpacing = await page.evaluate(() => {
      const toggle = document.getElementById("sidebarToggle")?.getBoundingClientRect();
      const logo = document.querySelector("#sidebarNav .logo")?.getBoundingClientRect();
      return toggle && logo ? { toggleBottom: toggle.bottom, logoTop: logo.top } : null;
    });
    assert.ok(
      mobileHeaderSpacing && mobileHeaderSpacing.logoTop >= mobileHeaderSpacing.toggleBottom + 8,
      `Mobile menu control overlaps the sidebar brand: ${JSON.stringify(mobileHeaderSpacing)}`
    );
    const mobileOutput = `/tmp/lpc-prompt1-${target.role}-mobile.png`;
    await page.screenshot({ path: mobileOutput, fullPage: true });
    outputPaths.push(mobileOutput);
    await page.close();
  }
  return outputPaths;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await runRoleJourney(browser, "attorney");
    await runRoleJourney(browser, "paralegal");
    await runHistoryJourney(browser);
    await runMobile(browser);
    await runMatterCommandJourney(browser);
    const visualPaths = await captureVisualComparison(browser);
    process.stdout.write(`Global search UI and mocked role journeys passed.\n${visualPaths.join("\n")}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
