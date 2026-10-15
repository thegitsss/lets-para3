const { test, expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const fs = require("fs");
const path = require("path");

const pages = [
  ["home", "/index.html"],
  ["login", "/login.html"],
  ["signup", "/signup.html"],
  ["browse paralegals", "/browse-paralegals.html"],
  ["forgot password", "/forgot-password.html"],
  ["reset password", "/reset-password.html?token=invalid"],
  ["verify email", "/verify-email.html?token=invalid"],
  ["privacy", "/privacy.html"],
  ["terms", "/terms.html"],
  ["accessibility statement", "/accessibility.html"],
  ["contact", "/contact.html"],
  ["paralegal admission", "/paralegal-admission.html"],
  ["attorney FAQ", "/attorney-faq.html"],
  ["paralegal FAQ", "/paralegal-faq.html"],
  ["attorney Help", "/help.html"],
  ["paralegal Help", "/paralegalhelp.html"],
  ["not found", "/this-page-does-not-exist", 404],
];
const visualAuditPages = new Set(["home", "login", "signup", "not found"]);
const visualAuditPhase = String(process.env.VISUAL_AUDIT_PHASE || "").trim();
const visualAuditRoot = path.resolve(
  __dirname,
  "../../../test-results/visual-brand-audit",
  visualAuditPhase || "verification",
  "public"
);

function prepareVisualAuditDirectory() {
  if (!visualAuditPhase) return;
  fs.mkdirSync(visualAuditRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(visualAuditRoot, 0o700);
}

async function captureAuditScreenshot(page, name, viewportName) {
  if (!visualAuditPhase) return;
  prepareVisualAuditDirectory();
  const fileName = `${name.replace(/\s+/g, "-")}-${viewportName}.png`;
  await page.screenshot({ path: path.join(visualAuditRoot, fileName), fullPage: true });
}

async function readVisualIntegrity(page) {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    };
    const loadedFonts = [...document.fonts].map((font) => String(font.family).replace(/["']/g, ""));
    const brokenImages = [...document.images]
      .filter((image) => image.currentSrc && visible(image) && (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1))
      .map((image) => image.currentSrc);
    const zeroSizedGraphics = [...document.querySelectorAll("svg, canvas")]
      .filter((graphic) => visible(graphic))
      .filter((graphic) => {
        const rect = graphic.getBoundingClientRect();
        return rect.width < 1 || rect.height < 1;
      })
      .map((graphic) => graphic.outerHTML.slice(0, 120));
    const persistentLoadingCopy = [...document.querySelectorAll("body *")]
      .filter((element) => element.children.length === 0 && element.tagName !== "OPTION" && visible(element))
      .map((element) => element.textContent.trim())
      .filter((value) => /^(?:loading(?:\s+[^.!?…]+)?(?:\.{3}|…)?|please wait)$/i.test(value));
    return {
      fontsReady: document.fonts.status === "loaded",
      hasSarabun: loadedFonts.includes("Sarabun"),
      hasCormorant: loadedFonts.includes("Cormorant Garamond"),
      brokenImages,
      zeroSizedGraphics,
      persistentLoadingCopy,
    };
  });
}
const homeVisualSelectors = [
  ".editorial-hero__inner",
  ".workflow__intro",
  ".workflow__story",
  ".assistant-spotlight__copy",
  ".assistant-spotlight__visual",
  "#lpc-feature-cards",
  ".paralegal-map",
  ".clarity-section__intro",
  ".fee-card",
  ".home-faq",
  ".closing-scene",
];

const readHomeVisualState = async (page) => {
  const findScrollHomepage = await page.locator("[data-hero-scene], [data-find-hero]").count();
  if (findScrollHomepage) {
    const unavailable = [];
    for (const selector of homeVisualSelectors.map(selector => selector === ".closing-scene" && page.viewportSize().width <= 767 ? ".closing-mobile" : selector)) {
      const element = page.locator(selector).first();
      if (selector === ".hero-copy") {
        await page.evaluate(() => new Promise((resolve) => {
          window.scrollTo({ top: 0, behavior: "auto" });
          requestAnimationFrame(() => {
            window.scrollTo({ top: 0, behavior: "auto" });
            window.dispatchEvent(new Event("scroll"));
            requestAnimationFrame(resolve);
          });
        }));
      } else if (await element.count()) {
        await element.scrollIntoViewIfNeeded();
      }
      await page.waitForTimeout(1100);
      const visible = await element.evaluate((node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) >= 0.95
          && rect.width >= 1
          && rect.height >= 1;
      }).catch(() => false);
      if (!visible) unavailable.push(selector);
    }
    return page.evaluate((missing) => ({
      viewportHeight: window.innerHeight,
      pageHeight: document.documentElement.scrollHeight,
      unavailable: missing,
    }), unavailable);
  }

  const fixedStage = await page.locator("body").evaluate((body) => body.classList.contains("home-fixed-stage"));
  if (fixedStage) {
    const sceneChecks = [
      [0.72, [".hero-bridge__inner"]],
      [2.05, [".workflow__intro"]],
      [10.75, [".assistant-showcase__intro", ".assistant-stage"]],
      [12.85, [".path-scene--attorney .path-scene__copy", ".path-scene--attorney .audience-interface"]],
      [14.75, [".path-scene--paralegal .path-scene__copy", ".path-scene--paralegal .audience-interface"]],
      [20.92, [".closing-scene__content"]],
    ];
    const unavailable = [];
    await page.evaluate(() => document.documentElement.classList.add("is-purposeful-scrolling"));
    const geometry = await page.evaluate(() => {
      const story = document.querySelector("[data-home-motion-story]");
      return {
        top: story.getBoundingClientRect().top + window.scrollY,
        span: story.offsetHeight - window.innerHeight,
      };
    });
    for (const [unit, selectors] of sceneChecks) {
      await page.evaluate(({ stageGeometry, stageUnit }) => new Promise((resolve) => {
        document.scrollingElement.scrollTop = stageGeometry.top + ((stageUnit / 22.4) * stageGeometry.span);
        window.dispatchEvent(new Event("scroll"));
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }), { stageGeometry: geometry, stageUnit: unit });
      await page.waitForFunction((activeSelectors) => activeSelectors.every((selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) >= 0.99 && rect.height >= 1;
      }), selectors, { timeout: 600 }).catch(() => {});
      unavailable.push(...await page.evaluate((activeSelectors) => activeSelectors.filter((selector) => {
        const element = document.querySelector(selector);
        if (!element) return true;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.99 || rect.height < 1;
      }), selectors));
    }
    return page.evaluate((missing) => ({
      viewportHeight: window.innerHeight,
      pageHeight: document.documentElement.scrollHeight,
      unavailable: missing,
    }), unavailable);
  }

  const unavailable = [];
  for (const selector of homeVisualSelectors.map(selector => selector === ".closing-scene" && page.viewportSize().width <= 767 ? ".closing-mobile" : selector)) {
    const element = page.locator(selector).first();
    if (await element.count()) { await element.scrollIntoViewIfNeeded(); await page.waitForTimeout(900); }
    const visible = await element.evaluate(node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) >= .99 && rect.width >= 1 && rect.height >= 1;
    }).catch(() => false);
    if (!visible) unavailable.push(selector);
  }
  return page.evaluate(missing => ({ viewportHeight: innerHeight, pageHeight: document.documentElement.scrollHeight, unavailable: missing }), unavailable);
};

const activateHomeWorkflowStep = async (page, step) => {
  const selector = `[data-workflow-select="${step}"]`;
  if (await page.locator(selector).count()) {
    await page.locator(selector).evaluate((control) => control.click());
    return;
  }

  if (page.viewportSize().width <= 960) {
    const chooser = page.locator('.workflow-chapters'); await chooser.scrollIntoViewIfNeeded(); await chooser.focus();
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = Number(await page.locator('[data-workflow-canvas]').getAttribute('data-workflow-state'));
      if (current === Number(step)) break;
      await chooser.press(current < Number(step) ? 'ArrowRight' : 'ArrowLeft');
      await expect(page.locator('[data-workflow-canvas]')).toHaveAttribute('data-workflow-state', String(current + (current < Number(step) ? 1 : -1)));
    }
    return;
  }
  await page.locator(`[data-workflow-chapter="${step}"]`).evaluate((chapter) => {
    chapter.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
    window.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction((activeStep) => (
    document.querySelector("[data-workflow-canvas]")?.getAttribute("data-workflow-state") === activeStep ||
    document.querySelector(`[data-workflow-chapter="${activeStep}"]`)?.classList.contains("is-active")
  ), String(step));
};

async function settleRenderedLazyImages(page) {
  const images = page.locator('img[loading="lazy"]');
  if (!await images.count()) return { nativeWheelSteps: 0, images: [] };
  // Deferred assets can be outside Playwright's visibility predicate before load.
  // Traverse the page through native wheel input so deferred rendering and
  // loading run, then apply the original health predicate without filtering it.
  const before = await images.evaluateAll(nodes => nodes.map(node => ({ src: node.currentSrc || node.getAttribute('src') || '', complete: node.complete, naturalWidth: node.naturalWidth })));
  const viewport = page.viewportSize();
  await page.mouse.move(Math.min(120, viewport.width / 2), Math.floor(viewport.height / 2));
  let nativeWheelSteps = 0;
  for (; nativeWheelSteps < 200; nativeWheelSteps++) {
    const position = await page.evaluate(() => ({ y: scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight }));
    if (position.y + position.viewport >= position.height - 1) break;
    await page.mouse.wheel(0, Math.max(1, Math.floor(position.viewport * 0.8)));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  expect(nativeWheelSteps, 'Native page traversal must reach the end within its bounded steps').toBeLessThan(200);
  await expect.poll(() => images.evaluateAll(nodes => nodes.filter(node => { const style = getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0; }).every(node => node.complete && node.naturalWidth > 0)), { message: 'Rendered lazy assets must really load after native viewport traversal' }).toBe(true);
  const after = await images.evaluateAll(nodes => nodes.map(node => ({ src: node.currentSrc || node.getAttribute('src') || '', complete: node.complete, naturalWidth: node.naturalWidth })));
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.mouse.wheel(0, -height);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return { nativeWheelSteps, images: { before, after }, noImageOrLoadingOverrides: true };
}


for (const [name, url, expectedStatus = 200] of pages) {
  test(`${name} has no automated WCAG A/AA violations`, async ({ page, browserName }, testInfo) => {
    // Homepage coverage includes scroll scenes and three responsive layouts.
    if (name === "home") test.setTimeout(180_000);
    const visualNetworkFailures = [];
    page.on("requestfailed", (request) => {
      if (!new Set(["image", "font", "stylesheet", "script"]).has(request.resourceType())) return;
      if (request.url().startsWith("https://challenges.cloudflare.com/")) return;
      visualNetworkFailures.push(`${request.resourceType()} ${request.url()} ${request.failure()?.errorText || "failed"}`);
    });
    page.on("response", (response) => {
      if (!new Set(["image", "font", "stylesheet", "script"]).has(response.request().resourceType())) return;
      if (response.status() >= 400) {
        visualNetworkFailures.push(`${response.status()} ${response.request().resourceType()} ${response.url()}`);
      }
    });
    await page.route("https://challenges.cloudflare.com/**", (route) => route.abort());
    if (name === "browse paralegals") {
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
          body: JSON.stringify({ csrfToken: "public-visual-audit" }),
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
    if (visualAuditPages.has(name) || (visualAuditPhase && browserName === "chromium")) {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    expect(response.status()).toBe(expectedStatus);
    await page.locator("main").waitFor({ state: "attached" });
    if (name === "browse paralegals") {
      await expect(page.locator("#resultsStatus")).toHaveText("No paralegals match your filters yet.");
    }
    if (name === "home") {
      const readiness = await settleRenderedLazyImages(page);
      require("node:fs").writeFileSync(testInfo.outputPath("home-native-lazy-readiness.json"), JSON.stringify(readiness, null, 2));
    }
    const visualIntegrity = await readVisualIntegrity(page);
    expect(visualIntegrity.fontsReady, `${name} fonts did not settle`).toBe(true);
    expect(visualIntegrity.hasSarabun, `${name} did not register the bundled Sarabun family`).toBe(true);
    expect(visualIntegrity.hasCormorant, `${name} did not register the bundled Cormorant Garamond family`).toBe(true);
    expect(visualIntegrity.brokenImages, `${name} has broken rendered images`).toEqual([]);
    expect(visualIntegrity.zeroSizedGraphics, `${name} has zero-size rendered graphics`).toEqual([]);
    expect(visualIntegrity.persistentLoadingCopy, `${name} exposes a persistent loader`).toEqual([]);
    expect(visualNetworkFailures, `${name} has failed visual resources`).toEqual([]);
    if (name === "signup" && browserName === "chromium") {
      const brandState = await page.locator(".brand-fixed").evaluate((brand) => {
        const rect = brand.getBoundingClientRect();
        const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          left: rect.left,
          right: rect.right,
          viewportWidth: document.documentElement.clientWidth,
          unobscured: Boolean(topElement && brand.contains(topElement)),
        };
      });
      expect(brandState.left).toBeGreaterThanOrEqual(0);
      expect(brandState.right).toBeLessThanOrEqual(brandState.viewportWidth);
      expect(brandState.unobscured, "signup wordmark is obscured by another panel").toBe(true);
    }
    if (name === "home") {
      const layout = await readHomeVisualState(page);
      expect(layout.unavailable, "homepage sections must reveal when reached").toEqual([]);
      expect(layout.pageHeight, "desktop homepage exceeds its 28-viewport cinematic-story budget")
        .toBeLessThanOrEqual(layout.viewportHeight * 28);
      await activateHomeWorkflowStep(page, "4");
      await expect(page.locator("[data-workflow-canvas]")).toHaveAttribute("data-workflow-state", "4");
      await activateHomeWorkflowStep(page, "1");
      await page.waitForTimeout(900);
    }
    // Scan the existing reduced-motion state, rather than a mid-fade animation frame.
    if (name === "home") {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(page.locator('#lpc-feature-cards')).toHaveClass(/animation-still/);
    }
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
      .analyze();
    const summary = results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    }));
    expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
    if (visualAuditPages.has(name)) {
      const fileName = name.replace(/\s+/g, "-");
      await page.screenshot({ path: `/tmp/lpc-public-${fileName}-desktop.png`, fullPage: true });
    }
    if (visualAuditPhase && browserName === "chromium") {
      await captureAuditScreenshot(page, name, "1440x900");
    }
    if (visualAuditPages.has(name) || (visualAuditPhase && browserName === "chromium")) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      const mobileLayout = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
      }));
      expect(mobileLayout.contentWidth, `${name} mobile horizontal overflow`)
        .toBeLessThanOrEqual(mobileLayout.viewportWidth + 1);
      if (name === "home") {
        await activateHomeWorkflowStep(page, "4");
        await expect(page.locator('[data-workflow-chapter="4"]')).toHaveClass(/is-active/);
        await expect(page.locator('[data-workflow-chapter="1"]')).not.toHaveClass(/is-active/);
        await activateHomeWorkflowStep(page, "1");
        const layout = await readHomeVisualState(page);
        expect(layout.unavailable, "mobile homepage sections must reveal when reached").toEqual([]);
        expect(layout.pageHeight, "mobile homepage exceeds its 28-viewport cinematic-story budget")
          .toBeLessThanOrEqual(layout.viewportHeight * 28);
      }
      if (visualAuditPages.has(name)) {
        const fileName = name.replace(/\s+/g, "-");
        await page.screenshot({ path: `/tmp/lpc-public-${fileName}-mobile.png`, fullPage: true });
      }
      if (visualAuditPhase && browserName === "chromium") {
        await captureAuditScreenshot(page, name, "390x844");
      }
    }
    if (visualAuditPhase && browserName === "chromium") {
      await page.setViewportSize({ width: 720, height: 900 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const reflow = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: document.documentElement.scrollWidth,
      }));
      expect(reflow.contentWidth, `${name} overflows at 200%-equivalent desktop reflow`)
        .toBeLessThanOrEqual(reflow.viewportWidth + 1);
    }
  });
}

test("critical public actions expose a visible keyboard focus indicator", async ({ page }) => {
  await page.route("https://challenges.cloudflare.com/**", (route) => route.abort());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });

  for (const url of ["/index.html", "/login.html", "/signup.html", "/contact.html"]) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator("main").waitFor({ state: "attached" });
    let inspected = 0;
    for (let index = 0; index < 12 && inspected < 4; index += 1) {
      await page.keyboard.press("Tab");
      const focusState = await page.evaluate(() => {
        const element = document.activeElement;
        if (!(element instanceof HTMLElement) || element === document.body) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        if (!visible) return null;
        const hasOutline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
        const hasShadow = style.boxShadow !== "none";
        const hasUnderline = style.textDecorationLine.includes("underline");
        return {
          label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
          indicator: hasOutline || hasShadow || hasUnderline,
        };
      });
      if (!focusState) continue;
      inspected += 1;
      expect(focusState.indicator, `${url}: ${focusState.label} has no visible focus indicator`).toBe(true);
    }
    expect(inspected, `${url} did not expose enough keyboard-reachable controls`).toBeGreaterThanOrEqual(4);
  }
});
