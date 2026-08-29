const { test, expect } = require("playwright/test");

const REQUIRED_VIEWPORTS = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 900 },
  { width: 1920, height: 1080 },
];

const MOBILE_VIEWPORTS = REQUIRED_VIEWPORTS.slice(0, 2);

const WORKFLOW_TITLES = [
  "Scope the work.",
  "Review applicants.",
  "Work together.",
  "Review deliverables.",
  "Confirm completion.",
  "Close the matter.",
];

async function settlePage(page) {
  await page.waitForFunction(() => document.body.classList.contains("home-motion-ready"));
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function overflowSnapshot(page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
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

test("homepage motion never expands the document width at any required viewport", async ({ page }) => {
  test.setTimeout(120_000);
  for (const viewport of REQUIRED_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    await settlePage(page);
    const samples = await page.evaluate(() => {
      const selectors = [".editorial-hero", ".workflow", ".paths", ".assistant-showcase", ".clarity-section", ".closing-scene"];
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

test("mobile workflow and long-form sections remain continuous rather than blank", async ({ page }) => {
  for (const viewport of MOBILE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    await settlePage(page);

    const geometry = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      const workflowStory = rect(".workflow__story");
      const chapters = Array.from(document.querySelectorAll(".workflow-chapter"));
      const chapterRects = chapters.map((chapter) => chapter.getBoundingClientRect());
      const chapterStyles = chapters.map((chapter) => {
        const style = getComputedStyle(chapter);
        return {
          background: style.backgroundColor,
          borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
        };
      });
      const pathsHeadingStyle = getComputedStyle(document.querySelector(".paths__heading"));
      const paths = rect(".paths");
      const pathsHeading = rect(".paths__heading");
      const pathsSplit = rect(".paths__split");
      const pathScenes = Array.from(document.querySelectorAll(".path-scene")).map((scene) => scene.getBoundingClientRect());
      const assistantStyle = getComputedStyle(document.querySelector(".assistant-showcase"));
      const clarityStyle = getComputedStyle(document.querySelector(".clarity-section"));
      return {
        viewportHeight: innerHeight,
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        workflowStoryHeight: workflowStory.height,
        chapterSeams: chapterRects.slice(0, -1).map((chapter, index) => chapterRects[index + 1].top - chapter.bottom),
        chapterStyles,
        pathsPadding: {
          top: parseFloat(pathsHeadingStyle.paddingTop),
          bottom: parseFloat(pathsHeadingStyle.paddingBottom),
        },
        pathsSeams: [
          pathsSplit.top - pathsHeading.bottom,
          pathScenes[1].top - pathScenes[0].bottom,
          paths.bottom - pathsSplit.bottom,
        ],
        assistantPadding: {
          top: parseFloat(assistantStyle.paddingTop),
          bottom: parseFloat(assistantStyle.paddingBottom),
        },
        clarityPadding: {
          top: parseFloat(clarityStyle.paddingTop),
          bottom: parseFloat(clarityStyle.paddingBottom),
        },
      };
    });

    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.workflowStoryHeight / geometry.viewportHeight).toBeGreaterThanOrEqual(547 / 100);
    expect(geometry.workflowStoryHeight / geometry.viewportHeight).toBeLessThanOrEqual(550 / 100);
    geometry.chapterSeams.forEach((gap) => expect(Math.abs(gap)).toBeLessThanOrEqual(1));
    geometry.chapterStyles.forEach((style) => {
      expect(style.background).toBe("rgba(0, 0, 0, 0)");
      style.borders.forEach((border) => expect(border).toBe("0px"));
    });
    expect(Math.abs(geometry.pathsPadding.top - geometry.pathsPadding.bottom)).toBeLessThanOrEqual(1);
    geometry.pathsSeams.forEach((gap) => expect(Math.abs(gap)).toBeLessThanOrEqual(1));
    expect(Math.abs(geometry.assistantPadding.top - geometry.assistantPadding.bottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.clarityPadding.top - geometry.clarityPadding.bottom)).toBeLessThanOrEqual(1);

    const chapters = page.locator(".workflow-chapter");
    for (let index = 0; index < WORKFLOW_TITLES.length; index += 1) {
      const target = await chapters.nth(index).evaluate((chapter) => {
        const rect = chapter.getBoundingClientRect();
        return window.scrollY + rect.top + (rect.height / 2) - (window.innerHeight * 0.48);
      });
      await page.evaluate((top) => window.scrollTo({ top, behavior: "auto" }), target);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.locator(".workflow-mobile-stage__heading h3")).toHaveText(WORKFLOW_TITLES[index]);
      await expect(page.locator(".workflow-mobile-stage__canvas .workflow-state.is-active")).toHaveCount(1);
    }

    await page.locator(".assistant-showcase").scrollIntoViewIfNeeded();
    const preview = page.locator(".assistant-preview");
    await expect(preview).toBeVisible();
    await expect(preview.locator("[data-assistant-role]")).toHaveText("Attorney Assistant");
    await expect(preview.locator("[data-assistant-question]")).toHaveText("When is my next deadline?");
    await expect(preview.locator("[data-assistant-answer]")).toContainText("Henderson v. Walker");
    await expect(preview.locator("[data-assistant-action]")).toHaveText("Open the active matter");
    await expect(preview.locator(".assistant-preview__suggestions span")).toHaveCount(2);
    await expect(preview.locator(".assistant-preview__composer")).toBeVisible();
    await expect(preview.locator(".assistant-showcase__disclaimer")).toBeVisible();
  }
});

test("approved motion ownership remains intact without moving Answers Before You Get Started", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/index.html", { waitUntil: "domcontentloaded" });
  await settlePage(page);

  await expect(page.locator(".home-faq")).not.toHaveAttribute("data-motion-layer");
  await expect(page.locator(".closing-scene .role-actions")).toHaveAttribute("data-motion-layer", "rise");
  await expect(page.locator(".matter-field--paths")).toHaveCount(1);
  await expect(page.locator(".paths > .matter-field--paths")).toHaveCount(1);
  await expect(page.locator(".editorial-hero .matter-field--paths")).toHaveCount(0);

  const pathsCanvas = page.locator(".matter-field--paths");
  const beforeTransform = await pathsCanvas.evaluate((canvas) => getComputedStyle(canvas).transform);
  await page.locator(".paths__heading").scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pathsState = await pathsCanvas.evaluate((canvas) => {
    const probe = document.createElement("canvas");
    probe.width = 160;
    probe.height = 160;
    const context = probe.getContext("2d", { willReadFrequently: true });
    const sourceHeight = Math.min(canvas.height, Math.round(innerHeight * Math.min(devicePixelRatio || 1, 1.5)));
    context.drawImage(canvas, 0, 0, canvas.width, sourceHeight, 0, 0, probe.width, probe.height);
    const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
    let cornflowerPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const alpha = pixels[index + 3];
      if (alpha > 10 && blue > red + 30 && blue > green + 20) cornflowerPixels += 1;
    }
    return {
      transform: getComputedStyle(canvas).transform,
      cornflowerPixels,
    };
  });
  expect(pathsState.transform).not.toBe(beforeTransform);
  expect(pathsState.cornflowerPixels).toBeGreaterThan(0);

  const assistantLink = page.locator(".assistant-message--assistant a");
  await assistantLink.focus();
  const focusGeometry = await assistantLink.evaluate((link) => {
    const linkRect = link.getBoundingClientRect();
    const previewRect = link.closest(".assistant-preview").getBoundingClientRect();
    return {
      leftSpace: linkRect.left - previewRect.left,
      rightSpace: previewRect.right - linkRect.right,
      topSpace: linkRect.top - previewRect.top,
      bottomSpace: previewRect.bottom - linkRect.bottom,
    };
  });
  Object.values(focusGeometry).forEach((space) => expect(space).toBeGreaterThanOrEqual(4));
});

test("reduced motion removes pinned empty space and leaves every section readable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/index.html", { waitUntil: "domcontentloaded" });
  await settlePage(page);

  await expect(page.locator("body")).not.toHaveClass(/home-cinematic-motion/);
  await expect(page.locator("[data-motion-layer]")).toHaveCount(0);
  await expect(page.locator(".workflow-mobile-stage")).toBeHidden();
  await expect(page.locator(".workflow-chapter")).toHaveCount(6);
  await expect(page.locator(".workflow-chapter .workflow-mobile-canvas")).toHaveCount(6);

  const reducedState = await page.evaluate(() => {
    const story = document.querySelector(".workflow__story").getBoundingClientRect();
    const chapters = document.querySelector(".workflow-chapters").getBoundingClientRect();
    const chapterStates = Array.from(document.querySelectorAll(".workflow-chapter")).map((chapter) => {
      const rect = chapter.getBoundingClientRect();
      const canvas = chapter.querySelector(".workflow-mobile-canvas");
      return {
        height: rect.height,
        visibility: getComputedStyle(chapter).visibility,
        opacity: getComputedStyle(chapter).opacity,
        canvasDisplay: getComputedStyle(canvas).display,
      };
    });
    return {
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      storyHeight: story.height,
      chaptersHeight: chapters.height,
      pathsTransform: getComputedStyle(document.querySelector(".matter-field--paths")).transform,
      closingTransform: getComputedStyle(document.querySelector(".matter-field--closing")).transform,
      chapterStates,
    };
  });

  expect(reducedState.scrollWidth).toBeLessThanOrEqual(reducedState.viewportWidth);
  expect(Math.abs(reducedState.storyHeight - reducedState.chaptersHeight)).toBeLessThanOrEqual(1);
  expect(reducedState.pathsTransform).toBe("none");
  expect(reducedState.closingTransform).toBe("none");
  reducedState.chapterStates.forEach((state) => {
    expect(state.height).toBeGreaterThan(0);
    expect(state.visibility).toBe("visible");
    expect(state.opacity).toBe("1");
    expect(state.canvasDisplay).toBe("block");
  });

  for (const selector of [
    ".editorial-hero",
    ".workflow",
    ".paths",
    ".assistant-showcase",
    ".trust-band",
    ".clarity-section",
    ".closing-scene",
  ]) {
    const section = page.locator(selector);
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
  }
});
