const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const frontendRoot = path.resolve(__dirname, "../../frontend");

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".css" ? "text/css" : "text/javascript";
}

async function installPage(page) {
  await page.addInitScript(() => {
    window.alert = () => { throw new Error("Native alert must not be used"); };
    window.confirm = () => { throw new Error("Native confirm must not be used"); };
    window.prompt = () => { throw new Error("Native prompt must not be used"); };
  });
  await page.route("http://dialogs.lpc/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/test") {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dialog contract</title></head><body>
          <main><button id="openConfirm" type="button">Open confirm</button><output id="result"></output></main>
          <script type="module">
            import { confirmAction, promptForText, showAlert } from "/assets/scripts/utils/dialogs.js";
            const result = document.getElementById("result");
            document.getElementById("openConfirm").addEventListener("click", async () => {
              const confirmed = await confirmAction("Delete <img src=x onerror=window.__injected=true> permanently?", {
                title: "Delete Matter?", confirmLabel: "Delete Matter", tone: "danger"
              });
              result.textContent = String(confirmed);
            });
            window.testDialogs = {
              prompt: async () => {
                const value = await promptForText("Explain the change.", {
                  title: "Request edits", label: "Edit request", required: true,
                  requiredMessage: "Enter the requested edits.", confirmLabel: "Send request", maxLength: 24
                });
                result.textContent = value === null ? "cancelled" : value;
              },
              queue: async () => {
                const first = showAlert("First queued dialog", { title: "First" });
                const second = showAlert("Second queued dialog", { title: "Second" });
                await Promise.all([first, second]);
                result.textContent = "queue-complete";
              }
            };
          </script>
        </body></html>`,
      });
      return;
    }
    const filePath = path.resolve(frontendRoot, url.pathname.replace(/^\/+/, ""));
    if (!filePath.startsWith(`${frontendRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    await route.fulfill({ contentType: contentType(filePath), body: fs.readFileSync(filePath) });
  });
  await page.goto("http://dialogs.lpc/test");
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await installPage(page);

    await page.click("#openConfirm");
    const dialog = page.locator(".lpc-dialog");
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    assert.equal(await dialog.getAttribute("data-tone"), "danger");
    assert.equal(await dialog.locator("img").count(), 0, "Dialog messages must render as text, never HTML");
    assert.match(await dialog.locator(".lpc-dialog__description").innerText(), /<img src=x/);
    assert.equal(await page.evaluate(() => Boolean(window.__injected)), false);
    assert.match(await page.evaluate(() => document.activeElement?.textContent || ""), /Cancel/);
    const box = await dialog.boundingBox();
    assert.ok(box && box.width <= 390 && box.x >= 0 && box.x + box.width <= 390);
    await page.screenshot({ path: "/tmp/lpc-dialog-mobile.png", fullPage: true });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("result")?.textContent === "false");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "openConfirm");

    await page.click("#openConfirm");
    await dialog.locator(".lpc-dialog__button--primary").click();
    await page.waitForFunction(() => document.getElementById("result")?.textContent === "true");

    await page.evaluate(() => { void window.testDialogs.prompt(); });
    await dialog.waitFor();
    await dialog.locator(".lpc-dialog__button--primary").click();
    assert.equal(await dialog.locator(".lpc-dialog__status").innerText(), "Enter the requested edits.");
    const input = dialog.locator(".lpc-dialog__input");
    assert.equal(await input.getAttribute("maxlength"), "24");
    await input.fill("  Exact wording  ");
    await dialog.locator(".lpc-dialog__button--primary").click();
    await page.waitForFunction(() => document.getElementById("result")?.textContent === "Exact wording");

    await page.evaluate(() => { void window.testDialogs.queue(); });
    await dialog.waitFor();
    assert.equal(await page.locator(".lpc-dialog").count(), 1);
    assert.equal(await dialog.locator(".lpc-dialog__title").innerText(), "First");
    await dialog.locator(".lpc-dialog__button--primary").click();
    await page.waitForFunction(() => document.querySelector(".lpc-dialog__title")?.textContent === "Second");
    assert.equal(await page.locator(".lpc-dialog").count(), 1);
    await dialog.locator(".lpc-dialog__button--primary").click();
    await page.waitForFunction(() => document.getElementById("result")?.textContent === "queue-complete");
    assert.equal(await page.locator(".lpc-dialog").count(), 0);

    console.log("Dialog browser contract passed (safe text, focus, cancellation, required input, queueing, mobile bounds).");
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
