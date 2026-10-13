const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { prepareMatterModule, fulfillFrontendAsset } = require("./ui-module-fixture");

const repositoryRoot = path.resolve(__dirname, "../..");
const htmlPath = path.join(repositoryRoot, "frontend/case-detail.html");
const scriptPath = path.join(repositoryRoot, "frontend/assets/scripts/case-detail.js");
const matterId = "64b000000000000000000101";

function stripScripts(source) {
  return String(source).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}


const htmlSource = stripScripts(fs.readFileSync(htmlPath, "utf8"));
const scriptSource = prepareMatterModule(fs.readFileSync(scriptPath, "utf8"));
const baselineHtmlSource = stripScripts(execFileSync("git", ["show", "HEAD:frontend/case-detail.html"], { cwd: repositoryRoot, encoding: "utf8" }));
const baselineScriptSource = prepareMatterModule(execFileSync("git", ["show", "HEAD:frontend/assets/scripts/case-detail.js"], { cwd: repositoryRoot, encoding: "utf8" }));

function experience(role) {
  const attorney = role === "attorney";
  const sections = attorney
    ? ["overview", "applications", "work", "files", "messages", "activity", "financials"]
    : ["overview", "work", "files", "messages", "activity", "financials"];
  return {
    version: 1,
    header: {
      title: "Discovery response Matter",
      status: { code: "in_progress", label: "In progress" },
      practiceArea: "Civil Litigation",
      deadline: "2026-09-01T00:00:00.000Z",
      relationship: attorney ? "Matter owner" : "Assigned paralegal",
      attention: "One task remains",
      primaryAction: { code: "continue_work", label: "Continue work", tab: "work" },
    },
    sections: sections.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
    overview: {
      summary: "Prepare discovery responses and supporting exhibits.",
      practiceArea: "Civil Litigation",
      jurisdiction: "New York",
      deadline: "2026-09-01T00:00:00.000Z",
      hiredAt: "2026-08-01T00:00:00.000Z",
      attorney: "Avery Counsel",
      paralegal: "Parker Assigned",
      taskProgress: { completed: 1, total: 2 },
    },
    applications: attorney
      ? {
          items: [{ id: "64b000000000000000000102", name: "Taylor Candidate", status: "pending", appliedAt: "2026-07-30T00:00:00.000Z", preEngagementStatus: null }],
          preEngagement: null,
          reviewHref: `/dashboard-attorney.html?openApplicants=1&caseId=${matterId}#cases:inquiries`,
        }
      : null,
    work: { tasks: [{ title: "Draft responses", completed: true }, { title: "Prepare exhibits", completed: false }], readOnly: false, completed: 1, total: 2 },
    activity: [
      { code: "started", label: "Work started", at: "2026-08-01T00:00:00.000Z" },
      { code: "posted", label: "Matter posted", at: "2026-07-25T00:00:00.000Z" },
    ],
    financials: {
      version: 2, caseId: matterId, ownerId: attorney ? "64b000000000000000000103" : "64b000000000000000000104", role,
      revision: "a".repeat(64), state: "active", stripeMode: "test", receipts: [], receiptsAreEarlier: false,
      currency: "USD",
      status: "Funded",
      amounts: attorney
        ? [{ code: "compensation", label: "Matter compensation", cents: 100000 }, { code: "attorney_fee", label: "Attorney platform fee", cents: 22000 }]
        : [{ code: "compensation", label: "Matter compensation", cents: 100000 }, { code: "paralegal_fee", label: "Platform fee", cents: 12000 }],
      receiptHref: null,
      note: "Amounts reflect the Matter's saved financial record.",
    },
  };
}

function matterPayload(role) {
  return {
    id: matterId,
    _id: matterId,
    title: "Discovery response Matter",
    status: "in progress",
    practiceArea: "Civil Litigation",
    details: "Prepare discovery responses and supporting exhibits.",
    locationState: "NY",
    deadline: "2026-09-01T00:00:00.000Z",
    escrowStatus: "funded",
    escrowIntentId: "pi_test_matter_experience",
    totalAmount: 100000,
    lockedTotalAmount: 100000,
    remainingAmount: 100000,
    currency: "usd",
    attorney: { _id: "64b000000000000000000103", firstName: "Avery", lastName: "Counsel", role: "attorney" },
    paralegal: { _id: "64b000000000000000000104", firstName: "Parker", lastName: "Assigned", role: "paralegal" },
    applicants: role === "attorney" ? [{ paralegalId: "64b000000000000000000102", status: "pending" }] : [],
    tasks: [{ title: "Draft responses", completed: true }, { title: "Prepare exhibits", completed: false }],
    files: [],
    readOnly: false,
    paymentReleased: false,
    matterContext: { practiceArea: "Civil Litigation", relationship: { label: role === "attorney" ? "Your matter" : "Assigned to you" }, attention: null, nextAction: { label: "Open matter", href: `/case-detail.html?caseId=${matterId}` } },
    matterExperience: experience(role),
  };
}

function documentHtml({ baseline = false } = {}) {
  const html = baseline ? baselineHtmlSource : htmlSource;
  const script = baseline ? baselineScriptSource : scriptSource;
  return html.replace("</body>", `<script type="module">${script}</script></body>`);
}

async function installRoutes(page, role, counters) {
  page.on("pageerror", (error) => console.error("[Matter contract page error]", error.message));
  counters.messageItems = [{
    _id: "m1",
    text: "Matter update",
    createdAt: "2026-08-02T10:00:00.000Z",
    senderId: matterPayload(role).attorney,
    senderRole: "attorney",
  }];
  counters.sentMessages = [];
  await page.addInitScript((viewerRole) => {
    const id = viewerRole === "attorney" ? "64b000000000000000000103" : "64b000000000000000000104";
    localStorage.setItem("lpc_user", JSON.stringify({ id, role: viewerRole, status: "approved" }));
    window.EventSource = class MockEventSource {
      addEventListener() {}
      close() {}
    };
  }, role);
  await page.route("https://matter.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (await fulfillFrontendAsset(route, repositoryRoot)) return;
    if (url.pathname === "/api/auth/me") {
      const actor = role === "attorney" ? matterPayload(role).attorney : matterPayload(role).paralegal;
      await route.fulfill({ json: { user: { ...actor, id: actor._id, status: "approved" } } });
      return;
    }
    if (["/case-detail.html", "/baseline-case-detail.html"].includes(url.pathname)) {
      await route.fulfill({ contentType: "text/html", body: documentHtml({ baseline: url.pathname.startsWith("/baseline") }) });
      return;
    }
    if (url.pathname === `/api/cases/${matterId}`) {
      counters.detail += 1;
      await route.fulfill({ json: matterPayload(role) });
      return;
    }
    if (url.pathname === "/api/cases/my") {
      await route.fulfill({ json: { cases: [matterPayload(role)] } });
      return;
    }
    if (url.pathname === "/api/messages/summary") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (url.pathname === `/api/messages/${matterId}`) {
      counters.messages += 1;
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        const message = {
          _id: role === "attorney" ? "64b000000000000000000106" : "64b000000000000000000107",
          caseId: matterId,
          clientMessageId: body.clientMessageId,
          text: String(body?.text || ""),
          createdAt: "2026-08-15T12:00:00.000Z",
          senderId: role === "attorney" ? matterPayload(role).attorney : matterPayload(role).paralegal,
          senderRole: role,
        };
        counters.sentMessages.push(message);
        counters.messageItems.push(message);
        await route.fulfill({ status: 201, json: { message } });
        return;
      }
      await route.fulfill({ json: { messages: counters.messageItems } });
      return;
    }
    if (url.pathname === `/api/messages/${matterId}/read`) {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname === `/api/uploads/case/${matterId}`) {
      counters.files += 1;
      if (counters.failFilesOnce) {
        counters.failFilesOnce = false;
        await route.fulfill({ status: 503, json: { error: "Temporary" } });
        return;
      }
      await route.fulfill({ json: { files: [{ id: "64b000000000000000000105", originalName: "responses.pdf", mimeType: "application/pdf", uploadedByRole: "paralegal", status: "pending_review", createdAt: "2026-08-02T00:00:00.000Z" }] } });
      return;
    }
    if (url.pathname.endsWith("/stream")) {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/plain", body: "" });
  });
}

async function runRoleJourney(browser, role) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const counters = { detail: 0, messages: 0, files: 0, failFilesOnce: role === "attorney" };
  await installRoutes(page, role, counters);
  await page.goto(`https://matter.test/case-detail.html?caseId=${matterId}&tab=overview`);
  await page.waitForSelector('[data-matter-panel="overview"]:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll(".sidebar nav:not([hidden])").length === 1);
  assert.equal(
    await page.locator(".sidebar nav:not([hidden])").getAttribute("aria-label"),
    role === "attorney" ? "Attorney navigation" : "Paralegal navigation"
  );
  await page.screenshot({ path: `/tmp/lpc-prompt2-${role}-matter-current.png`, fullPage: true });

  const visibleTabs = await page.locator('[data-matter-tab]:not([hidden])').allTextContents();
  assert.deepEqual(visibleTabs, role === "attorney"
    ? ["Overview", "Applications", "Work", "Files", "Messages", "Activity", "Payments"]
    : ["Overview", "Work", "Files", "Messages", "Activity", "Payments"]);
  assert.equal(counters.messages, 0);
  assert.equal(counters.files, 0);

  await page.click('[data-matter-tab="files"]');
  await page.waitForFunction(() => new URL(location.href).searchParams.get("tab") === "files");
  if (role === "attorney") {
    await page.waitForSelector('[data-matter-retry="files"]');
    await page.click('[data-matter-retry="files"]');
  }
  await page.waitForSelector(".case-documents-item");
  assert.ok(counters.files >= 1);
  assert.equal(counters.messages, 0);
  if (role === "attorney") {
    const documentActions = await page.locator(".case-documents-actions button").evaluateAll((buttons) =>
      buttons.map((button) => ({
        text: button.textContent.trim(),
        pressed: button.getAttribute("aria-pressed"),
        type: button.type,
      }))
    );
    assert.deepEqual(documentActions, [
      { text: "Approve", pressed: "false", type: "button" },
      { text: "Request revisions", pressed: "false", type: "button" },
    ]);
    assert.equal(await page.locator(".case-documents-actions input").count(), 0);
  }

  await page.goBack();
  await page.waitForSelector('[data-matter-panel="overview"]:not([hidden])');
  await page.goForward();
  await page.waitForSelector('[data-matter-panel="files"]:not([hidden])');
  await page.reload();
  await page.waitForSelector('[data-matter-panel="files"]:not([hidden])');
  assert.equal(new URL(page.url()).searchParams.get("tab"), "files");

  await page.click('[data-matter-tab="messages"]');
  await page.waitForSelector(".message-card");
  assert.ok(counters.messages >= 1);
  const sentText = `${role} browser message`;
  await page.fill("#caseMessageInput", sentText);
  const messageResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith(`/api/messages/${matterId}`) && response.request().method() === "POST"
  );
  await page.click(".composer-send");
  const messageResponse = await messageResponsePromise;
  assert.equal(messageResponse.status(), 201);
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll(".message-card")].some((node) => node.textContent.includes(expected)),
    sentText
  );
  assert.equal(counters.sentMessages.length, 1);
  assert.equal(counters.sentMessages[0].text, sentText);
  assert.equal(await page.inputValue("#caseMessageInput"), "");

  await page.click('[data-matter-tab="overview"]');
  assert.equal(await page.locator("#matterMessagesSkipLink").isVisible(), true);
  await page.focus("#matterMessagesSkipLink");
  await page.click("#matterMessagesSkipLink");
  await page.waitForFunction(() => new URL(location.href).searchParams.get("tab") === "messages");
  await page.waitForFunction(() => document.activeElement?.id === "case-messages");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "case-messages");

  await page.click('[data-matter-tab="overview"]');
  await page.press('[data-matter-tab="overview"]', "ArrowRight");
  const expectedKeyboardTab = role === "attorney" ? "applications" : "work";
  assert.equal(new URL(page.url()).searchParams.get("tab"), expectedKeyboardTab);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.matterTab), expectedKeyboardTab);

  await page.click('[data-matter-tab="work"]');
  assert.equal(new URL(page.url()).searchParams.get("tab"), "work");
  await page.click("#caseDisputeButton");
  const actionOverlay = role === "attorney" ? ".case-dispute-overlay.is-visible" : ".case-flag-overlay.is-visible";
  await page.waitForSelector(actionOverlay);
  assert.equal(
    await page.evaluate(() => document.activeElement?.hasAttribute("data-popup-initial")),
    true
  );
  await page.keyboard.press("a");
  await page.keyboard.press("Escape");
  await page.waitForSelector(role === "attorney" ? ".case-dispute-overlay" : ".case-flag-overlay", { state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "caseDisputeButton");
  await page.click('[data-matter-tab="financials"]');
  assert.match(await page.locator("#matterPaymentDetails").innerText(), /Matter compensation/i);
  assert.doesNotMatch(await page.locator("#matterPaymentDetails").innerText(), role === "attorney" ? /Paralegal|Net payout/ : /Attorney platform fee/);
  assert.equal(await page.getByRole("button", { name: "View receipts", exact: true }).count(), role === "attorney" ? 1 : 0);

  const tabIds = role === "attorney"
    ? ["overview", "applications", "work", "files", "messages", "activity", "financials"]
    : ["overview", "work", "files", "messages", "activity", "financials"];
  for (const tabId of tabIds) {
    await page.click(`[data-matter-tab="${tabId}"]`);
    await page.waitForSelector(`[data-matter-panel="${tabId}"]:not([hidden])`);
    await page.screenshot({ path: `/tmp/lpc-prompt5-${role}-matter-${tabId}.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const metrics = await page.locator(".matter-stage").evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scrollWidth: node.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(metrics.width <= metrics.viewport);
  const pageOverflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  assert.ok(pageOverflow.content <= pageOverflow.viewport + 1, JSON.stringify(pageOverflow));
  assert.ok(documentHtml().includes("prefers-reduced-motion"));
  const tabBox = await page.locator('[data-matter-tab="overview"]').boundingBox();
  assert.ok(tabBox && tabBox.height >= 44);
  const selectedTabVisibility = await page.locator('[data-matter-tab][aria-selected="true"]').evaluate((button) => {
    const tabList = button.closest('[role="tablist"]');
    const buttonBox = button.getBoundingClientRect();
    const listBox = tabList.getBoundingClientRect();
    return {
      left: buttonBox.left,
      right: buttonBox.right,
      listLeft: listBox.left,
      listRight: listBox.right,
    };
  });
  assert.ok(selectedTabVisibility.left >= selectedTabVisibility.listLeft - 1, JSON.stringify(selectedTabVisibility));
  assert.ok(selectedTabVisibility.right <= selectedTabVisibility.listRight + 1, JSON.stringify(selectedTabVisibility));
  await page.click('[data-matter-tab="work"]');
  const taskControlSize = await page.locator('#caseTaskList input[type="checkbox"]').first().evaluate((checkbox) => {
    const box = checkbox.getBoundingClientRect();
    return { width: box.width, height: box.height };
  });
  assert.ok(taskControlSize.width >= 18 && taskControlSize.width <= 24, JSON.stringify(taskControlSize));
  assert.ok(taskControlSize.height >= 18 && taskControlSize.height <= 24, JSON.stringify(taskControlSize));
  await page.screenshot({ path: `/tmp/lpc-prompt2-${role}-matter-mobile.png`, fullPage: true });
  await page.close();

  const baselinePage = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const baselineCounters = { detail: 0, messages: 0, files: 0, failFilesOnce: false };
  const baselineErrors = [];
  baselinePage.on("pageerror", (error) => baselineErrors.push(error.message));
  await installRoutes(baselinePage, role, baselineCounters);
  await baselinePage.goto(`https://matter.test/baseline-case-detail.html?caseId=${matterId}`);
  try {
    await baselinePage.waitForFunction(
      () => [...document.querySelectorAll("#case-select option")]
        .some((option) => option.textContent.includes("Discovery response")),
      null,
      { timeout: 10_000 }
    );
  } catch (error) {
    const baselineState = await baselinePage.evaluate(() => ({
      selectedMatter: document.querySelector("#case-select")?.selectedOptions?.[0]?.textContent || "",
      listStatus: document.querySelector("#caseListStatus")?.textContent || "",
      url: location.href,
    }));
    throw new Error(
      `${error.message}; baseline page errors: ${baselineErrors.join(" | ") || "none"}; detail requests: ${baselineCounters.detail}; state: ${JSON.stringify(baselineState)}`
    );
  }
  await baselinePage.screenshot({ path: `/tmp/lpc-prompt2-${role}-matter-baseline.png`, fullPage: true });
  await baselinePage.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await runRoleJourney(browser, "attorney");
    await runRoleJourney(browser, "paralegal");
    process.stdout.write("Matter experience mocked attorney/paralegal journeys passed.\n");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
