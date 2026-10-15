const { test, expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const mapStates = require("../../../../frontend/assets/data/us-states.json");

const REQUIRED_VIEWPORTS = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 900 },
  { width: 1920, height: 1080 },
];

const MOBILE_VIEWPORTS = REQUIRED_VIEWPORTS.slice(0, 2);

const WORKFLOW_TITLES = [
  "Scope",
  "Review fit, check conflicts",
  "Work",
  "Complete & close",
];

test("network dots pulse sparingly and respect reduced motion", async ({ page }) => {
  await page.route("**/api/public/paralegals/state-counts", route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ states: Object.fromEntries(mapStates.map(state => [state.code, ["CA", "NY"].includes(state.code) ? 14 : 0])), approvedTotal: 28 }),
  }));
  await page.goto("/index.html", { waitUntil: "domcontentloaded" });
  await page.locator(".paralegal-map__canvas").scrollIntoViewIfNeeded();
  await expect(page.locator(".paralegal-map__pin")).toHaveCount(28);
  const halos = page.locator(".paralegal-map__halo");
  await expect(halos).toHaveCount(3);
  await expect.poll(() => halos.first().evaluate(node => getComputedStyle(node).animationName)).toBe("paralegal-map-dot-pulse");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => halos.first().evaluate(node => getComputedStyle(node).animationName)).toBe("none");
});

async function settlePage(page) {
  await page.waitForFunction(() => document.body.classList.contains("home-motion-ready"));
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}


async function selectWorkflow(page, step) {
  const chapter = page.locator(`[data-workflow-chapter="${step}"]`);
  if (page.viewportSize().width <= 960) {
    await page.locator('.workflow-chapters').scrollIntoViewIfNeeded();
    const chooser = page.locator('.workflow-chapters');
    await chooser.focus();
    for (let attempt = 0; attempt < WORKFLOW_TITLES.length; attempt++) {
      const current = Number(await page.locator('[data-workflow-canvas]').getAttribute('data-workflow-state'));
      if (current === step) break;
      await chooser.press(current < step ? 'ArrowRight' : 'ArrowLeft');
      // Let the actual horizontal snap finish before sending another key.
      await expect.poll(() => chooser.evaluate(el => {
        const center = el.scrollLeft + el.clientWidth / 2;
        const chapters = [...el.querySelectorAll('[data-workflow-chapter]')];
        const closest = chapters.reduce((best, chapter) => Math.abs(chapter.offsetLeft + chapter.offsetWidth / 2 - center) < Math.abs(best.offsetLeft + best.offsetWidth / 2 - center) ? chapter : best);
        return Number(closest.dataset.workflowChapter);
      })).toBe(current + (current < step ? 1 : -1));

      await expect(page.locator('[data-workflow-canvas]')).toHaveAttribute('data-workflow-state', String(current + (current < step ? 1 : -1)));
    }
    await page.locator('.workflow-chapters').scrollIntoViewIfNeeded();
  } else {
    const top = await chapter.evaluate(node => scrollY + node.getBoundingClientRect().top + node.offsetHeight / 2 - innerHeight * 0.48);
    await page.evaluate(top => scrollTo({ top, behavior: 'instant' }), top);
  }
  await expect(page.locator('[data-workflow-canvas]')).toHaveAttribute('data-workflow-state', String(step));
  await expect(chapter).toHaveClass(/is-active/);
}

async function overflowSnapshot(page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    // Collect expensive per-element diagnostics only when the page overflows.
    if (scrollWidth <= viewportWidth) return { viewportWidth, scrollWidth, candidates: [] };
    const candidates = Array.from(document.body.querySelectorAll("*"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || "",
          classes: Array.from(element.classList).slice(0, 4).join("."),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          display: style.display,
          visibility: style.visibility,
        };
      })
      .filter((item) =>
        item.display !== "none" &&
        item.visibility !== "hidden" &&
        item.width > 0 &&
        (item.left < -1 || item.right > viewportWidth + 1)
      )
      .sort((a, b) => Math.max(b.right - viewportWidth, -b.left) - Math.max(a.right - viewportWidth, -a.left))
      .slice(0, 24);
    return {
      viewportWidth,
      scrollWidth: document.documentElement.scrollWidth,
      candidates,
    };
  });
}

test("workflow examples keep one Matter identity and readable truthful states at every scroll step", async ({ page }, info) => {
  // This checks all four approved scenes at three widths, including an axe scan of each.
  test.setTimeout(300_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/index.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".workflow__intro-title")).not.toContainText("Illustrative example");
  await expect(page.locator(".paralegal-map__stat")).toHaveAttribute("aria-label", "Browse paralegal profiles");
  await expect(page.locator(".paralegal-map__note")).toHaveText("Dots show approved paralegals in each state.");
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width <= 640 ? 844 : 1000 });
    await page.goto("/index.html", { waitUntil: "domcontentloaded" }); await settlePage(page);
    for (let step = 1; step <= WORKFLOW_TITLES.length; step++) {
      await selectWorkflow(page, step);
      const scope = width <= 640 ? `.workflow-chapter[data-workflow-chapter="${step}"] .workflow-mobile-canvas` : ".workflow-canvas";
      const panel = page.locator(`${scope} .workflow-state[data-state="${step}"]`);
      if (width > 640) await expect(panel).toHaveAttribute("aria-hidden", "false"); else await expect(panel).not.toHaveAttribute("aria-hidden", "true");
      await expect.poll(() => panel.evaluate(el => { const style = getComputedStyle(el); return style.opacity === "1" && ["none", "blur(0px)"].includes(style.filter); })).toBe(true);
      const visible = page.locator(scope);
      const header = page.locator(".workflow-canvas > .product-topbar");
      await expect(header.locator(".matter-identity strong")).toHaveText("Medical Records Chronology");
      await expect(header.locator(".workflow-example-label")).toHaveCount(0);
      await expect(panel.locator("button, input, textarea")).toHaveCount(0);
      if (step === 3) { await expect(panel.locator('.workflow-review .compact-file')).toHaveCount(1); await expect(panel.locator('.workflow-review')).toContainText('Chronology.pdf'); }
      if (step === 4) { await expect(panel.locator('h4')).toHaveText('All tasks complete'); await expect(panel.locator('.workflow-completed-tasks li')).toHaveCount(3); await expect(panel.locator('.workflow-close-status')).toHaveText('Payment released'); await expect(panel.locator('.workflow-payout')).toHaveText('$650.00via Stripe'); await expect(panel.locator('.workflow-preview-action')).toHaveText('Download matter records'); }
      const scan = await new AxeBuilder({ page }).include(scope).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(scan.violations).toEqual([]);
      const overflow = await panel.evaluate(el => {
        const root = el.getBoundingClientRect();
        return [...el.querySelectorAll("h4, strong, b, .field, .applicant-row, .workflow-preview-action")]
          .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
          .map(node => ({ text: node.textContent.trim(), display: getComputedStyle(node).display, rect: node.getBoundingClientRect().toJSON(), scroll: node.scrollWidth, client: node.clientWidth }))
          // Inline elements have no clientWidth; Firefox still reports their scrollWidth.
          // Compare those against their rendered box, while retaining panel bounds.
          .filter(node => node.rect.left < root.left - 1 || node.rect.right > root.right + 1 || node.rect.bottom > root.bottom + 1 || node.scroll > (node.display === "inline" ? node.rect.width : node.client) + 1);
      });
      expect(overflow, `Workflow step ${step} at ${width}px`).toEqual([]);
      if (width <= 640) {
        if (step === 1) expect(await panel.locator('.workflow-create-preview__notes').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        const textSize = await panel.evaluate(el => {
          const scale = Number(el.querySelector('.workflow-mobile-stage__frame')?.style.getPropertyValue('--mobile-workflow-scale')) || 1;
          const sizes = selector => [...el.querySelectorAll(selector)].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden').map(node => parseFloat(getComputedStyle(node).fontSize) * scale);
          return { bodyCount: sizes('.workflow-create-preview__notes, .message p, .workflow-completed-tasks span, .applicant-row__identity strong').length, body: Math.min(...sizes('.workflow-create-preview__prompt, .workflow-create-preview__notes, .message p, .compact-file b, .workflow-completed-tasks span, .workflow-close-status, .applicant-row__identity strong')), labelCount: sizes('.workflow-create-preview__manual, .interface-label, .message small, .payment-summary small, .applicant-row__identity > span').length, labels: Math.min(...sizes('.workflow-create-preview__manual, .interface-label, .message small, .payment-summary small, .applicant-row__identity > span')) };
        });
        expect(textSize.bodyCount).toBeGreaterThan(0); expect(Number.isFinite(textSize.body)).toBe(true); expect(textSize.body).toBeGreaterThanOrEqual(13.5); if (textSize.labelCount) { expect(Number.isFinite(textSize.labels)).toBe(true); expect(textSize.labels).toBeGreaterThanOrEqual(12); }
      }
      await page.screenshot({ path: info.outputPath(`workflow-${width}-${step}.png`), animations: "disabled" });
    }
  }
  expect(errors).toEqual([]);
});

test("workflow copy remains readable with enlarged text and reduced motion", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" }); await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/index.html"); await settlePage(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  for (let step = 1; step <= WORKFLOW_TITLES.length; step++) {
    const selector = `.workflow-chapter[data-workflow-chapter="${step}"]`; const chapter = page.locator(selector);
    await selectWorkflow(page, step); const preview = chapter.locator(".workflow-mobile-canvas"); await expect(preview).toBeVisible(); await expect(chapter.locator("h3")).toHaveText(WORKFLOW_TITLES[step - 1]);
    const scan = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(scan.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await preview.evaluate(root => [...root.querySelectorAll("h4, .workflow-create-preview__notes, .applicant-row, .compact-file, .workflow-preview-action")].every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({ path: info.outputPath(`workflow-large-text-${step}.png`), animations: "disabled" });
    await chapter.evaluate(el => scrollTo({ top: scrollY + el.getBoundingClientRect().bottom - innerHeight + 24, behavior: 'instant' }));
    await page.screenshot({ path: info.outputPath(`workflow-large-text-${step}-bottom.png`), animations: "disabled" });
  }
});

test("homepage motion never expands the document width at any required viewport", async ({ page }) => {
  test.setTimeout(120_000);
  for (const viewport of REQUIRED_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    const samples = await page.evaluate(() => {
      const selectors = [".editorial-hero", ".workflow", ".assistant-spotlight", ".clarity-section", ".closing-mobile"];
      const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      return [...new Set([
        0,
        ...selectors.flatMap((selector) => {
          const element = document.querySelector(selector);
          if (!element) return [];
          const top = element.getBoundingClientRect().top + scrollY;
          return [top - (innerHeight * 0.5), top, top + (element.offsetHeight * 0.5)];
        }),
        maximum,
      ].map((value) => Math.max(0, Math.min(maximum, Math.round(value)))))];
    });

    for (const scrollTop of samples) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: "auto" }), scrollTop);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const snapshot = await overflowSnapshot(page);
      expect(
        snapshot.scrollWidth,
        `${viewport.width}x${viewport.height} at y=${scrollTop}: ${JSON.stringify(snapshot.candidates)}`
      ).toBeLessThanOrEqual(snapshot.viewportWidth);
    }
  }
});

test("mobile workflow keeps all four approved chapters and current homepage sections readable", async ({ page }) => {
  for (const viewport of MOBILE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/index.html"); await settlePage(page);
    const chapters = page.locator(".workflow-chapter");
    await expect(chapters).toHaveCount(WORKFLOW_TITLES.length);
    for (let i = 0; i < WORKFLOW_TITLES.length; i++) {
      await selectWorkflow(page, i + 1);
      await expect(chapters.nth(i).locator("h3")).toHaveText(WORKFLOW_TITLES[i]);
      await expect(chapters.nth(i).locator(".workflow-mobile-canvas")).toBeVisible();
    }
    for (const selector of [".assistant-spotlight", "#lpc-feature-cards", ".paralegal-map", ".clarity-section", ".closing-mobile"]) {
      const section = page.locator(selector); await section.scrollIntoViewIfNeeded();
      await expect(section).toBeVisible();
      expect(await section.evaluate(el => [...el.querySelectorAll("h2, h3, p, a, button")].every(node => {
        if (!node.getClientRects().length) return true;
        const rect = node.getBoundingClientRect();
        return rect.left >= -1 && rect.right <= innerWidth + 1 && node.scrollWidth <= (getComputedStyle(node).display === 'inline' ? rect.width : node.clientWidth) + 1;
      })), `${selector} content fits at ${viewport.width}px`).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});

test("homepage FAQ stays readable and Assistant example controls have visible keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/index.html"); await settlePage(page);
  await expect(page.locator(".home-faq")).not.toHaveAttribute("data-motion-layer");
  const link = page.locator('[data-assistant-example="deadlines"]');
  await link.scrollIntoViewIfNeeded(); await link.focus();
  await expect(link).toBeFocused();
  expect(await link.evaluate(el => parseFloat(getComputedStyle(el).outlineWidth))).toBeGreaterThanOrEqual(2);
  await expect(link).toHaveAttribute("aria-pressed", "true"); await expect(page.locator(".assistant-demo__source")).not.toHaveAttribute("href");
  const question = page.locator('.home-faq summary').filter({ hasText: 'conflicts check' });
  await question.click();
  await expect(question.locator('..')).toHaveAttribute('open', '');
});

test("reduced motion leaves all current homepage sections and workflow content available", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/index.html"); await settlePage(page);
  for (const selector of [".editorial-hero", ".workflow", ".assistant-spotlight", "#lpc-feature-cards", ".paralegal-map", ".clarity-section", ".closing-mobile"]) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    await expect(page.locator(selector)).toBeVisible();
  }
  for (const chapter of await page.locator('.workflow-chapter').all()) {
    const step = Number(await chapter.getAttribute('data-workflow-chapter')); await selectWorkflow(page, step);
    await expect(chapter).toHaveCSS('opacity', '1');
    await expect(chapter.locator(".workflow-mobile-canvas")).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
