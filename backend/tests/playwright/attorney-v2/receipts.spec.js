const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fs = require("fs/promises");
const fields = { title: "Synthetic receipt Matter", practiceArea: "Contract Law", state: "New York", compAmount: "400", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic attorney receipt verification", tasks: [{ title: "Prepare agreement" }] };
const panel = page => page.locator("[data-matter-receipt]");
const feedback = page => panel(page).locator("[data-receipt-feedback]");
const refresh = page => panel(page).getByRole("button", { name: "Refresh receipt", exact: true }).click();
const download = page => panel(page).getByRole("button", { name: "Download receipt", exact: true }).click();
const close = page => page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).click();
const reviewPattern = id => `**/api/payments/receipt/attorney/${id}/review?**`;
const pdfPattern = id => `**/api/payments/receipt/attorney/${id}?**`;
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
// A complete local PDF fixture; production renderer output is verified separately.
function pdfFixture() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>"];
  let value = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(value)); value += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}
const pdf = pdfFixture();
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { ...data, expectedOwnerId: user.id || user._id } });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function matter(page) {
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  return (await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" })).publication.caseId;
}
async function fixture(page, id) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user;
  return { caseId: id, ownerId: user.id || user._id, caseTitle: fields.title, reason: "available", revision: "a".repeat(64), receipt: { type: "payment", id: "pi_synthetic_receipt", currency: "USD", issuedAt: null, dateLabel: "Payment date", status: "received", method: "Visa ending 4242", lines: [{ label: "Matter amount", amount: 40000 }, { label: "Platform fee (22%)", amount: 8800 }], total: { label: "Total paid", amount: 48800 }, partyName: "Avery Lane", filename: "Agreement — payment-receipt.pdf" } };
}
async function open(page, id, current = false, ready = true) {
  await page.goto(current ? "/dashboard-attorney.html#cases:active" : `/attorney-v2.html#/matters/${id}/receipt`, { waitUntil: "domcontentloaded" });
  if (current) { const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first(); await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "View receipt", exact: true }).click(); }
  if (ready) await expect(panel(page)).toHaveAttribute("data-state", "ready");
}

test("both Matter menus read real unfunded payment evidence without calling it paid", async ({ page }) => {
  const id = await matter(page);
  await open(page, id, true); await expect(panel(page)).toContainText("No payment has been confirmed for this Matter."); await expect(panel(page).getByRole("button", { name: "Download receipt", exact: true })).toBeHidden(); await close(page);
  await page.goto(`/attorney-v2.html#/matters?highlightCase=${id}`, { waitUntil: "domcontentloaded" }); const row = page.locator(`[data-av2-matter="${id}"]`); await row.getByText("Matter actions", { exact: true }).click(); await row.getByRole("link", { name: "View receipt", exact: true }).click();
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText("No payment has been confirmed for this Matter."); await expect(page.locator('[data-av2-route="matters"][aria-current="page"]')).toBeVisible(); await expect(panel(page)).not.toContainText("Total paid");
});

test("each dashboard reviews and downloads exact PDF bytes using its reviewed revision", async ({ page }, info) => {
  const id = await matter(page), value = await fixture(page, id), requests = [];
  await page.route(reviewPattern(id), route => json(route, value)); await page.route(pdfPattern(id), route => { requests.push(route.request().url()); return route.fulfill({ contentType: "application/pdf", body: pdf }); });
  for (const current of [false, true]) {
    await open(page, id, current); await expect(panel(page)).toContainText("Payment confirmed"); await expect(panel(page)).toContainText("Date unavailable"); await expect(panel(page)).toContainText("$488.00");
    await page.screenshot({ path: info.outputPath(current ? "original-receipt-confirmation.png" : "v2-receipt-confirmation.png"), fullPage: true });
    const arriving = page.waitForEvent("download"); await download(page); const saved = await arriving; expect(saved.suggestedFilename()).toBe(value.receipt.filename); expect(await fs.readFile(await saved.path())).toEqual(pdf);
    await expect(feedback(page)).toContainText("Download requested. Check your browser’s downloads."); expect(new URL(requests.at(-1)).searchParams.get("revision")).toBe(value.revision); expect(new URL(requests.at(-1)).searchParams.get("expectedOwnerId")).toBe(value.ownerId);
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain(value.receipt.id);
  }
  expect(requests).toHaveLength(2);
});

test("both screens distinguish processed refunds, pending refunds and recorded withdrawal payouts", async ({ page }) => {
  const id = await matter(page), original = await fixture(page, id); let value = original;
  await page.route(reviewPattern(id), route => json(route, value));
  for (const current of [false, true]) {
    await open(page, id, current);
    for (const status of ["partially_refunded", "refund_pending", "refunded"]) {
      value = { ...original, receipt: { ...original.receipt, status, lines: [...original.receipt.lines, { label: "Original payment", amount: 48800 }, { label: "Refunds processed", amount: status === "refunded" ? 48800 : 10000 }, ...(status === "refund_pending" ? [{ label: "Refunds pending", amount: 5000 }] : [])], total: { label: "Payment less processed refunds", amount: status === "refunded" ? 0 : 38800 } } };
      await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText(status === "refunded" ? "$0.00" : "$388.00"); await expect(panel(page)).not.toContainText("Paid in full");
      if (status === "refund_pending") { await expect(panel(page)).toContainText("$50.00"); await expect(panel(page)).toContainText("The total subtracts only refunds already processed."); }
    }
    value = { ...original, receipt: { ...original.receipt, type: "withdrawal", id: "tr_synthetic_payout", dateLabel: "Payout date", status: "payout_recorded", method: "Stripe transfer", lines: [{ label: "Paralegal payout", amount: 8100 }, { label: "Paralegal platform fee", amount: 1900 }, { label: "Attorney fee", amount: 0 }], total: { label: "Total released from Matter", amount: 10000 } } };
    await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText("$81.00"); await expect(panel(page)).toContainText("Arrival in the paralegal’s bank account has not been confirmed."); value = original;
  }
});

test("Financials follows payment changes while preserving receipt details and visible qualifications", async ({ page }, info) => {
  const id = await matter(page), original = await fixture(page, id);
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url, options) { super(url, options); if (/\/api\/cases\//.test(String(url))) window.financialMatterStream = this; }
    };
  });
  let value = original, status = 200;
  await page.route(reviewPattern(id), route => json(route, value, status));
  await page.goto(`/attorney-v2.html#/matters/${id}/financials`, { waitUntil: "domcontentloaded" });
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
  await expect(page.getByRole("button", { name: "Refresh Matter", exact: true })).toBeEnabled();
  const details = panel(page).locator(".av2-financial-receipt-details"), summary = details.locator("summary").first();
  const variants = [
    { name: "pending-refund", receipt: { ...original.receipt, status: "refund_pending", lines: [...original.receipt.lines, { label: "Refunds processed", amount: 10000 }, { label: "Refunds pending", amount: 5000 }], total: { label: "Payment less processed refunds", amount: 38800 } }, notice: "Refund pending · Net payment: $388.00", qualification: "Refunds still processing are not deducted from this total." },
    { name: "full-refund", receipt: { ...original.receipt, status: "refunded", lines: [...original.receipt.lines, { label: "Refunds processed", amount: 48800 }], total: { label: "Payment less processed refunds", amount: 0 } }, notice: "Refund processed · Net payment: $0.00" },
    { name: "zero-payout", receipt: { ...original.receipt, type: "withdrawal", status: "no_payout", dateLabel: "Withdrawal decision date", method: null, lines: [], total: { label: "Paralegal payout", amount: 0 } }, notice: "Paralegal payout: $0.00" },
    { name: "live-payout", receipt: { ...original.receipt, type: "withdrawal", status: "payout_recorded", stripeMode: "live", dateLabel: "Payout date", lines: [{ label: "Paralegal payout", amount: 8100 }], total: { label: "Total released from Matter", amount: 10000 } }, notice: "Payout recorded · Total released from Matter: $100.00", qualification: "Arrival in the paralegal’s bank account has not been confirmed." },
    { name: "test-payment", receipt: { ...original.receipt, stripeMode: "test" }, qualification: "Test record - no money moved" },
  ];
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => {
    for (const element of [document.documentElement, document.body]) { element.classList.remove("theme-light"); element.classList.add("theme-dark"); }
    document.documentElement.style.fontSize = "20px";
  });
  for (const [index, variant] of variants.entries()) {
    value = { ...original, revision: (index + 11).toString(16).repeat(64), receipt: variant.receipt };
    const updated = page.waitForResponse(response => response.url().includes(`/api/payments/receipt/attorney/${id}/review?`));
    await page.evaluate(() => window.financialMatterStream.dispatchEvent(new MessageEvent("projection", { data: "{}" })));
    await updated; await expect(panel(page)).toHaveAttribute("data-state", "ready");
    await expect(details).not.toHaveAttribute("open");
    if (variant.notice) await expect(panel(page).getByText(variant.notice, { exact: true })).toBeVisible();
    if (variant.qualification) await expect(panel(page).getByText(variant.qualification, { exact: true })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Download receipt", exact: true })).toBeVisible();
    await panel(page).screenshot({ path: info.outputPath(`financials-${variant.name}-320-dark.png`) });
    expect((await new AxeBuilder({ page }).include("[data-matter-receipt]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await expect(page.getByRole("button", { name: "Refresh Matter", exact: true })).toBeEnabled();
  }
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open");
  await expect(details.getByText(original.receipt.id, { exact: true })).toBeVisible();
  value = { ...original, revision: "9".repeat(64), receipt: variants[0].receipt };
  await page.evaluate(() => window.financialMatterStream.dispatchEvent(new MessageEvent("projection", { data: "{}" })));
  await expect(panel(page).getByText(variants[0].notice, { exact: true })).toBeVisible();
  await expect(details).toHaveAttribute("open");
  await expect(details.getByText("$50.00", { exact: true })).toBeVisible();
  expect((await panel(page).innerText()).match(/\$388\.00/g)).toHaveLength(1);
  await panel(page).screenshot({ path: info.outputPath("financials-pending-refund-expanded-320-dark.png") });
  for (const amount of await details.locator("dl > dd").all()) {
    await amount.scrollIntoViewIfNeeded();
    await expect(amount).toBeInViewport();
  }
  const download = panel(page).getByRole("button", { name: "Download receipt", exact: true });
  await download.focus(); await expect(download).toBeFocused(); await expect(download).toBeInViewport();
  await expect(details).toHaveAttribute("open");
  await page.screenshot({ path: info.outputPath("financials-pending-refund-expanded-bottom-320-dark.png") });
  status = 503; await refresh(page);
  await expect(panel(page)).toHaveAttribute("data-state", "error");
  await expect(feedback(page)).toContainText("couldn’t be loaded");
  await expect(panel(page)).not.toContainText(original.receipt.id);
  await expect(panel(page).getByText(variants[0].notice, { exact: true })).toHaveCount(0);
  await expect(panel(page).getByText(variants[0].qualification, { exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "Download receipt", exact: true })).toBeHidden();
  await panel(page).screenshot({ path: info.outputPath("financials-receipt-unavailable-320-dark.png") });
  status = 200; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  await expect(details).toHaveAttribute("open");
  await expect(details.getByText(original.receipt.id, { exact: true })).toBeVisible();
});

test("failed refreshes and malformed projections clear private financial details before explicit recovery", async ({ page }) => {
  const id = await matter(page), original = await fixture(page, id); let value = original, status = 200;
  await page.route(reviewPattern(id), route => json(route, value, status)); await open(page, id);
  status = 503; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText("$488.00"); await expect(panel(page)).not.toContainText(original.caseTitle);
  status = 200;
  for (const invalid of [{ ...original, caseId: "0".repeat(24) }, { ...original, revision: "invalid" }, { ...original, receipt: { ...original.receipt, currency: "ZZZ" } }, { ...original, receipt: { ...original.receipt, total: { label: "Total paid", amount: -1 } } }, { ...original, reason: "not_funded" }]) { value = invalid; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page).getByRole("button", { name: "Download receipt", exact: true })).toBeHidden(); }
  value = original; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText("$488.00");
  value = { ...original, ownerId: "0".repeat(24) }; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "restricted"); await expect(panel(page)).not.toContainText(original.caseTitle);
});

test("changed payment evidence clears the old review and requires an explicit refresh and download", async ({ page }) => {
  const id = await matter(page), original = await fixture(page, id); let value = original, stale = true, requests = 0, reads = 0, saves = 0;
  page.on("download", () => saves++); await page.route(reviewPattern(id), route => { reads++; return json(route, value); }); await page.route(pdfPattern(id), route => { requests++; return stale ? json(route, { code: "RECEIPT_CHANGED" }, 409) : route.fulfill({ contentType: "application/pdf", body: pdf }); });
  await open(page, id); await download(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(feedback(page)).toContainText("Refresh the receipt before downloading"); await expect(panel(page)).not.toContainText("$488.00"); expect(requests).toBe(1); expect(reads).toBe(1); expect(saves).toBe(0);
  value = { ...original, revision: "b".repeat(64) }; stale = false; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "ready"); const arriving = page.waitForEvent("download"); await download(page); await arriving; expect(requests).toBe(2); expect(reads).toBe(2);
});

test("HTTP failures, HTML responses and counterfeit PDF bodies never start a download or retry automatically", async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id); let failure = {}, requests = 0, saves = 0; page.on("download", () => saves++);
  await page.route(reviewPattern(id), route => json(route, value)); await page.route(pdfPattern(id), route => { requests++; return route.fulfill(failure); }); await open(page, id);
  for (const next of [{ status: 503, contentType: "application/json", body: JSON.stringify({ code: "RECEIPT_UNAVAILABLE" }) }, { status: 200, contentType: "text/html", body: "<h1>Failure</h1>" }, { status: 200, contentType: "application/pdf", body: "<h1>Not a PDF</h1>" }]) {
    failure = next; const before = requests; await download(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(feedback(page)).toContainText("No download was sent to your browser"); expect(requests).toBe(before + 1); expect(saves).toBe(0);
  }
});

test("both dashboards cancel a delayed receipt and allow a separate explicit download", async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id); let saves = 0; page.on("download", () => saves++); await page.route(reviewPattern(id), route => json(route, value));
  for (const current of [false, true]) {
    await open(page, id, current); let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
    await page.route(pdfPattern(id), async route => { arrived(); await gate; await route.fulfill({ contentType: "application/pdf", body: pdf }).catch(() => {}); }); await download(page); await waiting;
    const before = saves; await panel(page).getByRole("button", { name: "Cancel download", exact: true }).click(); await expect(feedback(page)).toContainText("Receipt download canceled."); release(); await page.unroute(pdfPattern(id)); expect(saves).toBe(before);
    await page.route(pdfPattern(id), route => route.fulfill({ contentType: "application/pdf", body: pdf })); const arriving = page.waitForEvent("download"); await download(page); const saved = await arriving; expect(await fs.readFile(await saved.path())).toEqual(pdf); await page.unroute(pdfPattern(id));
  }
});

for (const current of [false, true]) test(`${current ? "current" : "V2"} account changes discard a delayed receipt without sending it to the browser`, async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id); value.receipt.partyName = "PRIVATE_RECEIPT_ATTORNEY"; let saves = 0, release, arrived; page.on("download", () => saves++);
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(reviewPattern(id), route => json(route, value)); await page.route(pdfPattern(id), async route => { arrived(); await gate; await route.fulfill({ contentType: "application/pdf", body: pdf }).catch(() => {}); }); await open(page, id, current); await download(page); await waiting;
  if (current) await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { id: "0".repeat(24), role: "attorney" } })));
  else { await page.route("**/api/auth/me", route => json(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); await expect(page).toHaveURL(/dashboard-attorney\.html/); }
  release(); await expect(panel(page)).toHaveCount(0); await expect(page.locator("body")).not.toContainText(value.receipt.partyName); expect(saves).toBe(0);
});

test("navigation and dialog close discard late receipt details and a reopened screen reads again", async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id); value.receipt.partyName = "PRIVATE_DELAYED_RECEIPT_ATTORNEY";
  for (const current of [false, true]) {
    let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
    await page.route(reviewPattern(id), async route => { arrived(); await gate; await json(route, value).catch(() => {}); }); await open(page, id, current, false); await waiting;
    if (current) await close(page); else await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); release(); await expect(panel(page)).toHaveCount(0); await expect(page.locator("body")).not.toContainText(value.receipt.partyName); await page.unroute(reviewPattern(id));
    await open(page, id, current); await expect(panel(page)).toContainText("No payment has been confirmed for this Matter.");
  }
});

test("mobile and desktop receipt details wrap long names and keep actions accessible by keyboard", async ({ page }, testInfo) => {
  const id = await matter(page), value = await fixture(page, id); value.caseTitle = `Agreement & document review: ${"LongMatterName".repeat(18)}`; value.receipt.partyName = `Lane & Hart ${"LongAttorneyName".repeat(8)}`; let reads = 0;
  await page.route(reviewPattern(id), route => { reads++; return json(route, value); });
  for (const current of [false, true]) {
    await page.setViewportSize({ width: 390, height: 900 }); await open(page, id, current);
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: 900 }); const action = panel(page).getByRole("button", { name: "Download receipt", exact: true }); await action.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (current) { const actionBox = await action.boundingBox(), closeBox = await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).boundingBox(); expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(closeBox.y); expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(880); }
      const result = await new AxeBuilder({ page }).include(current ? "#caseNoteModal" : "[data-matter-receipt]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(result.violations).toEqual([]); await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-receipt-${width}.png`), fullPage: true });
    }
    const before = reads; await panel(page).getByRole("button", { name: "Refresh receipt", exact: true }).focus(); await page.keyboard.press("Enter"); await expect(panel(page)).toHaveAttribute("data-state", "ready"); expect(reads).toBe(before + 1);
    if (current) { await page.keyboard.press("Escape"); await expect(page.locator("#caseNoteModal")).toBeHidden(); }
  }
});

test("an account change before downloading prevents the PDF request", async ({ page }) => {
  const id = await matter(page), value = await fixture(page, id); let requests = 0;
  await page.route(reviewPattern(id), route => json(route, value)); await page.route(pdfPattern(id), route => { requests++; return json(route, {}, 403); }); await open(page, id);
  await page.route("**/api/auth/me", route => json(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); await download(page); await expect(panel(page)).toHaveCount(0); expect(requests).toBe(0);
});
test("zero receipts show one amount and one outcome in both dashboards across themes and narrow screens", async ({ page }, info) => {
  const id = await matter(page), original = await fixture(page, id);
  const value = { ...original, receipt: { ...original.receipt, type: "withdrawal", dateLabel: "Withdrawal decision date", status: "no_payout", method: null, lines: [], total: { label: "Total released", amount: 0 } } };
  await page.route(reviewPattern(id), route => json(route, value));
  for (const current of [false, true]) {
    await open(page, id, current);
    for (const dark of [false, true]) for (const width of [320, 1366]) {
      await page.setViewportSize({ width, height: 1000 }); await page.evaluate(dark => { document.documentElement.classList.toggle("theme-dark", dark); document.body.classList.toggle("theme-dark", dark); document.documentElement.style.fontSize = "20px"; }, dark);
      await expect(page.getByRole("heading", { name: "Withdrawal receipt", exact: true })).toHaveCount(1);
      const surface = current ? page.locator("#caseNoteModal .note-modal-card") : page.locator("body");
      const channels = (await surface.evaluate(el => getComputedStyle(el).backgroundColor)).match(/[\d.]+/g).slice(0, 3).map(Number);
      expect(channels.every(value => dark ? value < 80 : value > 220)).toBe(true);
      await expect(panel(page).getByText("No payout", { exact: true })).toHaveCount(1); await expect(panel(page).getByText("$0.00", { exact: true })).toHaveCount(1); await expect(panel(page).getByText("Payment method", { exact: true })).toHaveCount(0);
      const action = panel(page).getByRole("button", { name: "Download receipt", exact: true });
      for (const name of ["Download receipt", "Refresh receipt", "Choose another receipt"]) {
        const control = panel(page).getByRole("button", { name, exact: true }); await control.focus(); await expect(control).toBeFocused();
        const box = await control.boundingBox(); expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(1000);
        if (current) expect(box.y + box.height).toBeLessThanOrEqual((await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).boundingBox()).y);
      }
      await action.focus(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).include(current ? "#caseNoteModal" : "[data-matter-receipt]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`zero-${current ? "current" : "v2"}-${dark ? "dark" : "light"}-${width}.png`), fullPage: true });
    }
  }
});
test("both dashboards distinguish test payouts from live recorded transfers", async ({ page }, info) => {
  const id = await matter(page), original = await fixture(page, id);
  let value = { ...original, receipt: { ...original.receipt, type: "withdrawal", stripeMode: "test", dateLabel: "Payout date", status: "payout_recorded", method: "Stripe transfer", lines: [{ label: "Paralegal payout", amount: 8100 }, { label: "Paralegal platform fee", amount: 1900 }], total: { label: "Total released", amount: 10000 } } };
  await page.route(reviewPattern(id), route => json(route, value));
  for (const current of [false, true]) {
    value.receipt.stripeMode = "test"; await open(page, id, current); await expect(panel(page).getByText("Test record - no money moved", { exact: true })).toHaveCount(1); await expect(panel(page)).not.toContainText("Arrival in the paralegal’s bank account");
    await page.screenshot({ path: info.outputPath(`test-payout-${current ? "current" : "v2"}.png`), fullPage: true });
    value = { ...value, receipt: { ...value.receipt, stripeMode: "live" } }; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).not.toContainText("Test record"); await expect(panel(page)).toContainText("Arrival in the paralegal’s bank account has not been confirmed.");
  }
});
