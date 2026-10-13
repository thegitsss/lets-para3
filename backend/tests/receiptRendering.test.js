jest.mock("../utils/puppeteerBrowser", () => ({ launchPuppeteer: jest.fn() }));
const { launchPuppeteer } = require("../utils/puppeteerBrowser");
const { buildReceiptPdfBuffer } = require("../services/caseLifecycle");
let page, browser;
beforeEach(() => {
  page = { setContent: jest.fn(), pdf: jest.fn().mockResolvedValue(Buffer.from("%PDF-test")), close: jest.fn() };
  browser = { newPage: jest.fn().mockResolvedValue(page), close: jest.fn() }; launchPuppeteer.mockResolvedValue(browser);
});
test("receipt detail values, labels and payment fields are escaped before entering the renderer", async () => {
  const attack = '<img src="https://invalid.test/private" onerror="alert(1)">';
  await buildReceiptPdfBuffer({ title: attack, receiptId: attack, issuedAt: attack, dateLabel: attack, partyName: attack, caseTitle: attack, attorneyName: attack, paymentMethod: attack, paymentStatus: attack, lineItems: [{ label: attack, value: attack }], totalLabel: attack, totalAmount: attack });
  const html = page.setContent.mock.calls[0][0]; expect(html).not.toContain(attack); expect(html).toContain('&lt;img src=&quot;https://invalid.test/private&quot; onerror=&quot;alert(1)&quot;&gt;'); expect(browser.close).toHaveBeenCalledTimes(1);
  const footer = page.pdf.mock.calls[0][0].footerTemplate; expect(footer).not.toContain(attack); expect(footer).toContain("&lt;img");
});
test("payment dates are named explicitly while existing receipt callers retain Date issued", async () => {
  await buildReceiptPdfBuffer({ dateLabel: "Payment date", issuedAt: "Sep 5, 2026", partyName: "Lane & Hart", caseTitle: "Agreement <draft>" });
  expect(page.setContent.mock.calls[0][0]).toContain("Payment date"); expect(page.setContent.mock.calls[0][0]).toContain("Lane &amp; Hart"); expect(page.setContent.mock.calls[0][0]).toContain("Agreement &lt;draft&gt;");
  await buildReceiptPdfBuffer({ issuedAt: "Sep 5, 2026" }); expect(page.setContent.mock.calls[1][0]).toContain("Date issued");
});
test("a PDF renderer failure still closes the browser", async () => {
  page.pdf.mockRejectedValue(new Error("Synthetic PDF failure")); await expect(buildReceiptPdfBuffer({})).rejects.toThrow("Synthetic PDF failure"); expect(browser.close).toHaveBeenCalledTimes(1);
});
test("zero receipts show one amount and one outcome without an invented payment method", async () => {
  await buildReceiptPdfBuffer({ title: "Withdrawal receipt", paymentMethod: null, paymentStatus: "No payout", lineItems: [], totalLabel: "Net payout", totalAmount: "$0.00" });
  const html = page.setContent.mock.calls[0][0]; expect(html.match(/No payout/g)).toHaveLength(1); expect(html.match(/\$0\.00/g)).toHaveLength(1); expect(html).not.toContain("Payment method"); expect(html).not.toContain("Line items"); expect(html).not.toContain("On file");
});
test("test receipts are clearly distinguished from live receipts", async () => {
  await buildReceiptPdfBuffer({ testMode: true }); expect(page.setContent.mock.calls[0][0]).toContain("Test record - no money moved");
  await buildReceiptPdfBuffer({ testMode: false }); expect(page.setContent.mock.calls[1][0]).not.toContain("Test record - no money moved");
});
