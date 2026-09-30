const { test, expect } = require("playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

const viewports = [
  { name: "mobile-320", width: 320, height: 844 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1366, height: 900 },
  { name: "wide", width: 1920, height: 1080 },
];

const phasePages = [
  { name: "Privacy", url: "/privacy.html", main: ".legal-document" },
  { name: "Terms", url: "/terms.html", main: ".legal-document" },
  { name: "Accessibility", url: "/accessibility.html", main: ".utility-content" },
  { name: "Contact", url: "/contact.html", main: ".contact-content" },
  { name: "Admission", url: "/paralegal-admission.html", main: ".admission-document" },
  { name: "Attorney FAQ", url: "/attorney-faq.html", main: ".faq-layout" },
  { name: "Paralegal FAQ", url: "/paralegal-faq.html", main: ".faq-layout" },
  { name: "404", url: "/nested/unknown/public-page", main: ".error-card", status: 404 },
];

const privacySections = [
  ["scope", "Scope"],
  ["information", "Information we collect"],
  ["use", "How we use information"],
  ["disclosure", "How we disclose information"],
  ["matter-assistant", "Matter-workspace LPC Assistant"],
  ["ai-support", "AI-assisted support"],
  ["cookies", "Cookies and performance data"],
  ["retention", "Retention and account deactivation"],
  ["security", "Security"],
  ["choices", "Your choices and privacy requests"],
  ["children", "Age restrictions"],
  ["changes", "Changes to this policy"],
  ["contact", "Contact us"],
  ["international", "Processing in the United States"],
];

const termsSections = [
  "Let’s-ParaConnect Platform Overview",
  "Flat-Fee Matters",
  "Paralegal Replacement and Early Termination",
  "Communication Between Attorneys and Paralegals",
  "Account Registration",
  "User Profiles",
  "Let’s-ParaConnect Profiles",
  "Working Together Outside the Platform",
  "Paralegals Are Independent Contractors",
  "Tax Reporting and IRS Forms",
  "Matter Review and Dispute Resolution",
  "Account Restrictions and Termination",
  "Using the Platform",
  "Content and Use of Platform Content",
  "Notices Regarding Let’s-ParaConnect",
  "Electronic Communications",
  "Indemnification",
  "Disclaimers and Limitations of Liability",
  "Choice of Law and Venue",
  "Waiver of Jury Trial and Class Action",
  "Termination",
  "General Terms",
  "Changes to This Agreement",
  "Definitions",
].map((heading, index) => [`section-${index + 1}`, heading]);

async function settle(page) {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("body")).toHaveClass(/public-site-chrome/);
  await expect(page.locator("[data-public-header]")).toBeVisible();
  await expect(page.locator("[data-public-footer]")).toBeAttached();
}

async function geometry(page, mainSelector) {
  return page.evaluate((selector) => {
    const rect = (node) => node?.getBoundingClientRect().toJSON() || null;
    const main = document.querySelector(selector);
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      header: rect(document.querySelector("[data-public-header]")),
      footer: rect(document.querySelector("[data-public-footer]")),
      main: rect(main),
    };
  }, mainSelector);
}

for (const viewport of viewports) {
  test(`Phase 6 pages reflow as one public family at ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ reducedMotion: "reduce" });

    for (const item of phasePages) {
      const response = await page.goto(item.url, { waitUntil: "domcontentloaded" });
      expect(response.status(), `${item.name} response status`).toBe(item.status || 200);
      await settle(page);
      await expect(page.locator(item.main)).toBeVisible();

      const state = await geometry(page, item.main);
      expect(state.documentWidth, `${item.name} overflows at ${viewport.name}`).toBeLessThanOrEqual(state.viewportWidth + 1);
      for (const [label, bounds] of Object.entries({ header: state.header, footer: state.footer, main: state.main })) {
        expect(bounds, `${item.name} is missing ${label}`).not.toBeNull();
        expect(bounds.left, `${item.name} ${label} clips left`).toBeGreaterThanOrEqual(-1);
        expect(bounds.right, `${item.name} ${label} clips right`).toBeLessThanOrEqual(state.viewportWidth + 1);
      }

      if (viewport.width <= 390) {
        expect(state.main.left, `${item.name} does not use the shared compact gutter`).toBeGreaterThanOrEqual(19);
        expect(state.main.left, `${item.name} compact gutter is too large`).toBeLessThanOrEqual(21);
        expect(state.viewportWidth - state.main.right, `${item.name} right gutter is inconsistent`).toBeGreaterThanOrEqual(19);
        expect(state.viewportWidth - state.main.right, `${item.name} right gutter is too large`).toBeLessThanOrEqual(21);
      }
    }
  });
}

test("Terms and Privacy use the same legal reader without losing sections or anchors", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const results = [];

  for (const item of [
    { url: "/privacy.html", sections: privacySections },
    { url: "/terms.html", sections: termsSections },
  ]) {
    await page.goto(item.url, { waitUntil: "domcontentloaded" });
    await settle(page);
    await expect(page.locator("main.legal-document")).toBeVisible();
    await expect(page.locator(".document-toc")).toHaveCount(0);
    const sections = page.locator(".legal-document section.card");
    await expect(sections).toHaveCount(item.sections.length);
    for (const [index, [id, heading]] of item.sections.entries()) {
      await expect(sections.nth(index)).toHaveAttribute("id", id);
      await expect(sections.nth(index).locator("h2")).toHaveText(`${index + 1}. ${heading}.`);
    }
    const ids = await sections.evaluateAll(nodes => nodes.map(node => node.id));
    expect(new Set(ids).size).toBe(item.sections.length);
    results.push(await page.locator("main.legal-document").evaluate((main) => {
      const style = getComputedStyle(main);
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        textAlign: style.textAlign,
      };
    }));
  }

  expect(results[0]).toEqual(results[1]);
  expect(results[1].textAlign).not.toBe("justify");
  await page.goto("/terms.html", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle("Terms of Service – Let’s-ParaConnect");
});

test("Attorney and Paralegal FAQs retain role content inside one shared structure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const layouts = [];

  for (const url of ["/attorney-faq.html", "/paralegal-faq.html"]) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(page);
    await expect(page.locator(".faq-toc")).toHaveCount(0);
    await expect(page.locator(".faq-group")).toHaveCount(4);
    const labelledGroups = await page.locator(".faq-group").evaluateAll((groups) =>
      groups.every((group) => Boolean(document.getElementById(group.getAttribute("aria-labelledby")))))
    expect(labelledGroups).toBe(true);
    layouts.push(await page.locator(".faq-group").first().evaluate((group) => {
      const style = getComputedStyle(group);
      return { borderRadius: style.borderRadius, padding: style.padding, background: style.backgroundColor };
    }));
  }

  expect(layouts[0]).toEqual(layouts[1]);
  await page.goto("/attorney-faq.html", { waitUntil: "domcontentloaded" });
  await page.getByText("What is the minimum Matter amount?", { exact: true }).click();
  await expect(page.locator("details[open]")).toContainText("$400");
});

test("Admission is compact and every repaired footer destination resolves", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/paralegal-admission.html", { waitUntil: "domcontentloaded" });
  await settle(page);

  const state = await page.evaluate(() => {
    const hero = document.querySelector(".admission-hero").getBoundingClientRect();
    const main = document.querySelector(".admission-document").getBoundingClientRect();
    const links = [...document.querySelectorAll(".home-footer__directory a")]
      .filter((link) => ["How It Works", "For Attorneys", "For Paralegals"].includes(link.textContent.trim()))
      .map((link) => new URL(link.href).pathname + new URL(link.href).hash);
    return { heroHeight: hero.height, gap: main.top - hero.bottom, links };
  });
  expect(state.heroHeight).toBeGreaterThan(0);
  expect(state.heroHeight).toBeLessThanOrEqual(600);
  expect(state.gap).toBeGreaterThanOrEqual(47);
  expect(state.gap).toBeLessThanOrEqual(90);
  expect(state.links).toEqual([
    "/index.html#how",
    "/attorney-faq.html",
    "/paralegal-faq.html",
  ]);
});

test("Contact keeps its submission behavior with the public button geometry", async ({ page }) => {
  await page.route("**/api/csrf", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ csrfToken: "phase-six-csrf" }),
  }));
  await page.route("**/api/public/contact", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe("phase-six-csrf");
    expect(route.request().postDataJSON()).toEqual(expect.objectContaining({
      name: "Phase Six",
      email: "phase6@example.com",
      role: "attorney",
      subject: "Visual verification",
      message: "Confirm that the contact form behavior remains intact.",
    }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/contact.html", { waitUntil: "domcontentloaded" });
  await settle(page);
  const submit = page.getByRole("button", { name: "Submit message", exact: true });
  const buttonStyle = await submit.evaluate((button) => {
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return { height: rect.height, radius: parseFloat(style.borderRadius), background: style.backgroundColor };
  });
  expect(buttonStyle.height).toBeGreaterThanOrEqual(48);
  expect(buttonStyle.radius).toBeGreaterThan(20);
  expect(buttonStyle.background).not.toBe("rgba(0, 0, 0, 0)");

  await page.locator("#name").fill("Phase Six");
  await page.locator("#email").fill("phase6@example.com");
  await page.locator("#role").selectOption("attorney");
  await page.locator("#subject").fill("Visual verification");
  await page.locator("#message").fill("Confirm that the contact form behavior remains intact.");
  await submit.click();
  await expect(page.locator("#formStatus")).toHaveText("Message sent. We’ll reply to the email address you provided.");
  await expect(page.locator("#formStatus")).toHaveClass(/success/);
});

test("the branded 404 remains a true nested-route response with root-safe assets and actions", async ({ page }) => {
  const failedAssets = [];
  page.on("response", (response) => {
    if (!["stylesheet", "script", "font", "image"].includes(response.request().resourceType())) return;
    if (response.status() >= 400) failedAssets.push(`${response.status()} ${response.url()}`);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto("/nested/unknown/public-page", { waitUntil: "load" });
  expect(response.status()).toBe(404);
  await settle(page);
  expect(failedAssets).toEqual([]);
  await expect(page.getByRole("heading", { name: "We couldn’t find that page." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to homepage" })).toHaveAttribute("href", "/");
  await expect(page.locator(".home-header .home-brand")).toHaveAttribute("href", "/index.html");
  const actions = await page.locator(".error-action").evaluateAll((links) => links.map((link) => {
    const style = getComputedStyle(link);
    const rect = link.getBoundingClientRect();
    return { height: rect.height, radius: parseFloat(style.borderRadius) };
  }));
  expect(actions.every(({ height, radius }) => height >= 48 && radius > 20)).toBe(true);
});

for (const item of phasePages) {
  test(`${item.name} passes the focused Phase 6 WCAG scan`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto(item.url, { waitUntil: "domcontentloaded" });
    expect(response.status()).toBe(item.status || 200);
    await settle(page);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
      .analyze();
    expect(
      axe.violations,
      `${item.name}: ${JSON.stringify(axe.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), null, 2)}`
    ).toEqual([]);
  });
}
