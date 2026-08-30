"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const frontendRoot = path.resolve(__dirname, "../../frontend");

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".woff2": "font/woff2",
  })[extension] || "application/octet-stream";
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const state = {
    acknowledged: false,
    chargebackRequests: 0,
    actionRequests: [],
  };

  const items = () => [{
    id: "64b000000000000000000201",
    matter: {
      id: "64b000000000000000000202",
      title: "Discovery response Matter",
      caseNumber: "LPC-2042",
      status: "completed",
      archived: true,
    },
    chargebackAmount: 50000,
    currency: "usd",
    processorFees: 1500,
    payoutPosition: "pre_payout",
    payoutHold: true,
    stripeMode: "test",
    processorStatus: "won",
    administrativeStatus: state.acknowledged ? "acknowledged" : "pending_review",
    evidenceStatus: "verified",
    netExposure: 51500,
    debitEvidence: 51500,
    creditEvidence: 0,
    evidenceCount: 2,
    disputeRef: "dp_…4b2a",
  }, {
    id: "64b000000000000000000203",
    matter: {
      id: "64b000000000000000000204",
      title: "Completed filing Matter",
      caseNumber: "LPC-2043",
      status: "completed",
      archived: true,
    },
    chargebackAmount: 22500,
    currency: "usd",
    processorFees: 0,
    payoutPosition: "post_payout",
    payoutHold: false,
    stripeMode: "live",
    processorStatus: "lost",
    administrativeStatus: "pending_review",
    evidenceStatus: "needs_reconciliation",
    netExposure: 22500,
    debitEvidence: 22500,
    creditEvidence: 0,
    evidenceCount: 1,
    disputeRef: "dp_…9c1e",
  }];

  await page.addInitScript(() => {
    localStorage.setItem("lpc_user", JSON.stringify({
      id: "64b000000000000000000200",
      role: "admin",
      status: "approved",
      firstName: "Phase",
      lastName: "Admin",
    }));
    sessionStorage.setItem("adminActiveSection", "finance");
  });

  await page.route("http://phase4b.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/api/admin/chargebacks" && request.method() === "GET") {
      state.chargebackRequests += 1;
      await route.fulfill({ json: { items: items() } });
      return;
    }
    const actionMatch = pathname.match(/^\/api\/admin\/chargebacks\/([^/]+)\/(acknowledge|clear-hold|reconcile)$/);
    if (actionMatch && request.method() === "POST") {
      state.actionRequests.push({
        operationId: actionMatch[1],
        action: actionMatch[2],
        csrf: request.headers()["x-csrf-token"] || "",
      });
      if (actionMatch[2] === "acknowledge") state.acknowledged = true;
      await route.fulfill({ json: { ok: true, changed: true } });
      return;
    }
    if (pathname === "/api/csrf") {
      await route.fulfill({ json: { csrfToken: "phase4b-csrf" } });
      return;
    }
    if (pathname === "/api/auth/me") {
      await route.fulfill({ json: { user: { id: "64b000000000000000000200", role: "admin", status: "approved" } } });
      return;
    }
    if (pathname === "/api/health") {
      await route.fulfill({ json: { ok: true, db: "connected" } });
      return;
    }
    if (pathname === "/api/admin/payouts" || pathname === "/api/admin/income") {
      await route.fulfill({ json: { items: [], totalAmount: 0, count: 0 } });
      return;
    }
    if (pathname.startsWith("/api/")) {
      await route.fulfill({ json: { items: [], users: [], cases: [], disputes: [], notifications: [], count: 0, total: 0 } });
      return;
    }

    const relative = pathname === "/" ? "admin-dashboard.html" : pathname.replace(/^\//, "");
    const filePath = path.resolve(frontendRoot, relative);
    if (!filePath.startsWith(`${frontendRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: contentType(filePath),
      body: fs.readFileSync(filePath),
    });
  });

  try {
    await page.goto("http://phase4b.test/admin-dashboard.html#finance", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#chargebacksBody tr").length === 2);

    assert.ok(state.chargebackRequests >= 1);
    assert.equal(await page.locator("#section-disputes #chargebackPanel").count(), 1);
    assert.equal(await page.locator("#section-overview #chargebackPanel").count(), 0);
    assert.equal(await page.locator("#chargebackPanel").isVisible(), true);
    assert.equal(await page.locator("#chargebackPanel h2").innerText(), "Stripe Chargebacks");
    assert.match(await page.locator("#chargebackPanel .settings-help").innerText(), /separate from Matter work-quality disputes/i);

    const projectionText = await page.locator("#chargebackPanel").innerText();
    assert.match(projectionText, /Discovery response Matter/);
    assert.match(projectionText, /\$500\.00/);
    assert.match(projectionText, /\$15\.00/);
    assert.match(projectionText, /Held for admin review/);
    assert.match(projectionText, /test/);
    assert.match(projectionText, /Completed filing Matter/);
    assert.match(projectionText, /Already released/);
    assert.match(projectionText, /live/);
    assert.match(projectionText, /needs_reconciliation/);
    assert.doesNotMatch(projectionText, /cus_|pm_|card_|dp_[A-Za-z0-9]{8,}/);

    const workDisputeText = await page.locator("#disputesBody").innerText();
    assert.doesNotMatch(workDisputeText, /Discovery response Matter|Completed filing Matter/);

    await page.getByRole("button", { name: "Acknowledge" }).first().click();
    await page.waitForFunction(() => document.querySelector("#chargebacksBody")?.textContent.includes("acknowledged"));
    assert.deepEqual(state.actionRequests[0], {
      operationId: "64b000000000000000000201",
      action: "acknowledge",
      csrf: "phase4b-csrf",
    });
    assert.match(await page.locator("#chargebackPanel").innerText(), /Clear eligible hold/);

    process.stdout.write("Phase 4B admin chargeback browser contract passed.\n");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
