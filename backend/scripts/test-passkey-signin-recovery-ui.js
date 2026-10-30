const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { expect } = require("playwright/test");
const frontend = path.resolve(__dirname, "../../frontend");
const pending = "We’re reviewing your application. We’ll email you when your account is ready.";
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

async function pageFor(browser, mode, width) {
  const context = await browser.newContext({ viewport: { width, height: width === 320 ? 640 : 900 } });
  const page = await context.newPage();
  await page.clock.install();
  const state = { authenticate: 0, errors: [] };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("http://lpc.test/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/assets/vendor/simplewebauthn-13.3.0.js") {
      return route.fulfill({ contentType: "text/javascript", body: `
        window.nativeCalls = 0;
        window.SimpleWebAuthnBrowser = {
          browserSupportsWebAuthn: () => true,
          startAuthentication: () => {
            window.nativeCalls += 1;
            if (${JSON.stringify(mode)} === 'canceled') return Promise.reject(new DOMException('Canceled', 'NotAllowedError'));
            if (['waiting', 'passwordFallback'].includes(${JSON.stringify(mode)})) return new Promise(resolve => { window.finishNative = resolve; });
            return Promise.resolve({id: 'controlled-credential'});
          },
          WebAuthnAbortService: { cancelCeremony: () => { window.nativeCanceled = true; } }
        };` });
    }
    if (url.pathname === "/api/csrf") return route.fulfill({ json: { csrfToken: "controlled-csrf" } });
    if (url.pathname === "/api/auth/me") return route.fulfill({ status: 401, json: { user: null } });
    if (url.pathname === "/api/health") return route.fulfill({ json: { ok: true } });
    if (url.pathname === "/api/auth/passkeys/authentication-options") {
      return route.fulfill({ json: { challengeId: "controlled-challenge", options: { challenge: "controlled" } } });
    }
    if (url.pathname === "/api/auth/passkeys/authenticate") {
      state.authenticate += 1;
      return route.fulfill({ status: 403, json: { error: pending, accountStatus: "pending", email: "pending@example.test",
        ...(mode === "verified" ? {} : { emailVerificationRequired: true }) } });
    }
    if (url.pathname === "/api/auth/login") return route.fulfill({ status: 403, json: { msg: pending, emailVerificationRequired: true } });
    if (url.pathname === "/api/performance/vitals") return route.fulfill({ status: 204 });
    if (route.request().method() !== "GET") throw new Error(`Unexpected write: ${url.pathname}`);
    const file = path.join(frontend, url.pathname === "/" ? "login.html" : url.pathname.slice(1));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file, contentType: types[path.extname(file)] || "application/octet-stream" });
    return route.fulfill({ status: 404, body: "Not found" });
  });
  await page.goto("http://lpc.test/login.html");
  await expect(page.locator("#passkeyLoginBtn")).toBeEnabled();
  return { context, page, state };
}

(async () => {
  const browser = await chromium.launch();
  let checks = 0;
  try {
    for (const width of [1440, 320]) {
      for (const mode of ["pending", "verified", "waiting", "canceled", "passwordFallback"]) {
        const { context, page, state } = await pageFor(browser, mode, width);
        try {
          const button = page.locator("#passkeyLoginBtn");
          await button.click();
          if (mode === "waiting" || mode === "passwordFallback") {
            await expect(button).toHaveText("Waiting for passkey…");
            await expect(button).toHaveAttribute("aria-busy", "true");
            await expect(page.locator("#toastBanner")).toContainText("No saved passkey?");
            if (process.env.LPC_UI_EVIDENCE_DIR) {
              await page.screenshot({ path: path.join(process.env.LPC_UI_EVIDENCE_DIR, `passkey-waiting-${width}.png`), fullPage: true });
            }
            if (mode === "passwordFallback") {
              await page.locator("#email").fill("pending@example.test");
              await page.locator("#password").fill("Controlled test passphrase");
              await page.getByRole("button", { name: "Sign in", exact: true }).click();
              await expect(page.locator("#loginApprovalDialog")).toBeVisible();
              await page.evaluate(() => window.finishNative({ id: "late-credential" }));
              await page.clock.runFor(1);
              assert.equal(state.authenticate, 0, "Late device result must not start passkey authentication");
              await expect(page.locator("#loginApprovalDialog")).toBeVisible();
            } else {
              await page.clock.fastForward(30001);
              await expect(page.locator("#toastBanner")).toContainText("Sign in with your password");
              await page.evaluate(() => window.finishNative({ id: "late-credential" }));
              await page.clock.runFor(1);
              assert.equal(state.authenticate, 0);
            }
          } else if (mode === "canceled") {
            await expect(page.locator("#toastBanner")).toContainText("Passkey sign-in was canceled");
            assert.equal(state.authenticate, 0);
          } else {
            await expect(page.locator("#loginApprovalDialog")).toBeVisible();
            const note = page.locator("#loginApprovalDialog .verification-note");
            if (mode === "verified") await expect(note).not.toBeVisible();
            else {
              await expect(note).toBeVisible();
              await page.locator("#loginApprovalDialog summary").click();
              await expect(page.locator("#loginApprovalEmail")).toHaveValue("pending@example.test");
            }
            assert.equal(state.authenticate, 1);
          }
          await expect(button).toBeEnabled();
          await expect(button).toHaveText("Sign in with a passkey");
          assert.deepEqual(state.errors, []);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          checks += 1;
        } finally { await context.close(); }
      }
    }
    console.log(`${checks} passkey sign-in recovery browser cases passed.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
