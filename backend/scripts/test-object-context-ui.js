const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const { chromium } = require("playwright");

const repositoryRoot = path.resolve(__dirname, "../..");
const htmlSource = fs.readFileSync(path.join(repositoryRoot, "frontend/case-detail.html"), "utf8")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
const caseScript = fs.readFileSync(path.join(repositoryRoot, "frontend/assets/scripts/case-detail.js"), "utf8")
  .replace(
    /^import[^\n]+\n/,
    `const secureFetch = (url, options = {}) => fetch(url, { ...options, credentials: "include", headers: { ...(options.headers || {}), "Content-Type": options.body && !(options.body instanceof FormData) ? "application/json" : undefined }, body: options.body && !(options.body instanceof FormData) && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body });
const fetchCSRF = async () => "test-csrf";
const showMsg = (node, message) => { if (node) node.textContent = message || ""; };
const loadUserHeaderInfo = async () => {};
const applyRoleVisibility = (role) => document.querySelectorAll("[data-visible]").forEach((node) => { node.hidden = node.dataset.visible !== role; });
`
  );
const contextScript = fs.readFileSync(path.join(repositoryRoot, "frontend/assets/scripts/context-panel.js"), "utf8");
const contextStyles = fs.readFileSync(path.join(repositoryRoot, "frontend/assets/styles/context-panel.css"), "utf8");
const notificationStyles = fs.readFileSync(path.join(repositoryRoot, "frontend/assets/styles/notifications-dashboard.css"), "utf8");
const notificationSource = fs.readFileSync(path.join(repositoryRoot, "frontend/assets/scripts/utils/notifications.js"), "utf8")
  .replace(/^import[^\n]+\n/gm, "")
  .replace(/^export\s+/gm, "");
const notificationScript = `const secureFetch = (url, options = {}) => fetch(url, { ...options, credentials: "include" });
const closeSupportDrawer = () => {};
const scanSupportLaunchers = () => {};
const confirmAction = async () => true;
${notificationSource}`;

const matterId = "64b000000000000000000201";
const candidateId = "64b000000000000000000202";
const staleCandidateId = "64b000000000000000000203";
const temporaryCandidateId = "64b000000000000000000210";
const fileId = "64b000000000000000000204";
const messageId = "64b000000000000000000205";
const unrelatedMessageId = "64b000000000000000000206";

function experience(role = "attorney") {
  const attorney = role === "attorney";
  return {
    version: 1,
    header: {
      title: "Discovery production Matter",
      status: { code: "in_progress", label: "In progress" },
      practiceArea: "Civil Litigation",
      relationship: attorney ? "Matter owner" : "Assigned paralegal",
      attention: "One task remains",
      primaryAction: { code: "continue_work", label: "Continue work", tab: "work" },
    },
    sections: (attorney
      ? ["overview", "applications", "work", "files", "messages", "activity", "financials"]
      : ["overview", "work", "files", "messages", "activity", "financials"])
      .map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
    overview: {
      summary: "Prepare document production and privilege log.",
      practiceArea: "Civil Litigation",
      attorney: "Avery Counsel",
      paralegal: "Parker Assigned",
      taskProgress: { completed: 0, total: 1 },
    },
    applications: attorney ? {
      items: [{ id: candidateId, name: "Taylor Candidate", status: "pending", appliedAt: "2026-08-01T00:00:00.000Z" }],
      reviewHref: `/dashboard-attorney.html?caseId=${matterId}&openApplicants=1#cases:inquiries`,
    } : null,
    work: { tasks: [{ title: "Prepare production", completed: false }], readOnly: false, completed: 0, total: 1 },
    activity: [{ code: "posted", label: "Matter posted", at: "2026-07-25T00:00:00.000Z" }],
    financials: { currency: "usd", status: "Funded", amounts: [], receiptHref: null, note: "Saved Matter record." },
  };
}

function matterPayload(role = "attorney") {
  return {
    id: matterId,
    _id: matterId,
    title: "Discovery production Matter",
    status: "in progress",
    practiceArea: "Civil Litigation",
    details: "Prepare document production and privilege log.",
    escrowStatus: "funded",
    totalAmount: 100000,
    lockedTotalAmount: 100000,
    currency: "usd",
    attorney: { _id: "64b000000000000000000207", firstName: "Avery", lastName: "Counsel", role: "attorney" },
    paralegal: { _id: "64b000000000000000000208", firstName: "Parker", lastName: "Assigned", role: "paralegal" },
    applicants: [{ paralegalId: candidateId, status: "pending" }],
    tasks: [{ title: "Prepare production", completed: false }],
    files: [],
    readOnly: false,
    paymentReleased: false,
    matterExperience: experience(role),
  };
}

function pageHtml() {
  return htmlSource
    .replace("</head>", `<style>${contextStyles}</style></head>`)
    .replace("</body>", `<script>${contextScript}</script><script>${caseScript}</script></body>`);
}

function notificationPageHtml() {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${notificationStyles}</style></head>
  <body><main><h1>Attorney dashboard</h1><div data-notification-center>
    <button type="button" data-notification-toggle>Notifications <span data-notification-badge></span></button>
    <section class="notifications-panel hidden" data-notification-panel><div class="notif-header">Notifications</div><div data-notification-list></div><p data-notification-empty>Loading</p><button data-notification-mark>Mark All Read</button></section>
  </div></main><script>${notificationScript}</script></body></html>`;
}

async function installRoutes(page, counters, role = "attorney") {
  await page.addInitScript((viewerRole) => {
    const id = viewerRole === "attorney" ? "64b000000000000000000207" : "64b000000000000000000208";
    localStorage.setItem("lpc_user", JSON.stringify({ id, role: viewerRole, status: "approved" }));
    window.EventSource = class MockEventSource { addEventListener() {} close() {} };
  }, role);
  await page.route("http://context.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/case-detail.html") {
      await route.fulfill({ contentType: "text/html", body: pageHtml() });
      return;
    }
    if (url.pathname === "/notification-dashboard.html") {
      await route.fulfill({ contentType: "text/html", body: notificationPageHtml() });
      return;
    }
    if (url.pathname === "/api/notifications" && route.request().method() === "GET") {
      const action = role === "attorney"
        ? {
            type: "application_submitted",
            message: "Taylor Candidate applied to Discovery production Matter",
            label: "Review application",
            href: `/case-detail.html?caseId=${matterId}&tab=applications&applicantId=${candidateId}`,
          }
        : {
            type: "message",
            message: "Avery Counsel sent a message about Discovery production Matter",
            label: "View message",
            href: `/case-detail.html?caseId=${matterId}&tab=messages&messageId=${messageId}`,
          };
      await route.fulfill({ json: [{
        id: "64b000000000000000000209",
        type: action.type,
        message: action.message,
        action: {
          label: action.label,
          href: action.href,
        },
        context: { caseId: matterId, applicantId: candidateId },
        available: true,
        read: false,
        isRead: false,
        actorFirstName: "Taylor",
        actorProfileImage: "",
        createdAt: "2026-08-02T10:00:00.000Z",
      }] });
      return;
    }
    if (url.pathname === "/api/notifications/64b000000000000000000209/read") {
      counters.notificationReadRequests += 1;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname === "/api/notifications/vapid-key") {
      await route.fulfill({ json: { key: "" } });
      return;
    }
    if (url.pathname === `/api/cases/${matterId}`) {
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
    if (url.pathname === `/api/messages/${matterId}` && route.request().method() === "GET") {
      await route.fulfill({ json: { messages: [
        { _id: unrelatedMessageId, text: "Earlier unread message", createdAt: "2026-08-02T09:00:00.000Z", senderId: matterPayload(role).paralegal, senderRole: "paralegal" },
        { _id: messageId, text: "The revised production draft is ready.", createdAt: "2026-08-02T10:00:00.000Z", senderId: matterPayload(role).attorney, senderRole: "attorney" },
      ] } });
      return;
    }
    if (url.pathname === `/api/messages/${matterId}/read`) {
      counters.readRequests += 1;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (url.pathname === `/api/uploads/case/${matterId}`) {
      await route.fulfill({ json: { files: [{
        id: fileId,
        originalName: "production-draft.pdf",
        mimeType: "application/pdf",
        size: 24576,
        uploadedByRole: "paralegal",
        status: "pending_review",
        version: 2,
        createdAt: "2026-08-02T00:00:00.000Z",
      }] } });
      return;
    }
    if (url.pathname === `/api/cases/${matterId}/applications/${candidateId}/preview`) {
      await route.fulfill({ json: { application: {
        candidateId,
        candidateName: "Taylor Candidate",
        matterTitle: "Discovery production Matter",
        source: "application",
        status: "pending",
        submittedAt: "2026-08-01T00:00:00.000Z",
        coverLetter: "I can support this production schedule.",
        preEngagement: null,
        profile: { location: "New York, NY", bio: "Litigation paralegal.", practiceAreas: ["Civil Litigation"], specialties: ["Discovery"], skills: ["Privilege logs"] },
        fullReviewHref: `/dashboard-attorney.html?caseId=${matterId}&applicantId=${candidateId}&openApplicant=1#cases:inquiries`,
      } } });
      return;
    }
    if (url.pathname === `/api/cases/${matterId}/applications/${staleCandidateId}/preview`) {
      await route.fulfill({ status: 404, json: { error: "Application not found" } });
      return;
    }
    if (url.pathname === `/api/cases/${matterId}/applications/${temporaryCandidateId}/preview`) {
      counters.tempPreviewAttempts += 1;
      if (counters.tempPreviewAttempts === 1) {
        await route.fulfill({ status: 503, json: { error: "Temporary failure" } });
        return;
      }
      await route.fulfill({ json: { application: {
        candidateId: temporaryCandidateId,
        candidateName: "Retry Candidate",
        matterTitle: "Discovery production Matter",
        source: "application",
        status: "pending",
        profile: { location: "Albany, NY", practiceAreas: ["Civil Litigation"], specialties: [], skills: [] },
        fullReviewHref: `/dashboard-attorney.html?caseId=${matterId}&applicantId=${temporaryCandidateId}&openApplicant=1#cases:inquiries`,
      } } });
      return;
    }
    if (url.pathname === `/api/users/profile-preview/${candidateId}`) {
      await route.fulfill({ json: { profile: {
        id: candidateId,
        name: "Taylor Candidate",
        bio: "Litigation paralegal.",
        location: "New York, NY",
        practiceAreas: ["Civil Litigation"],
        specialties: ["Discovery"],
        skills: ["Privilege logs"],
        experience: "Five years supporting document productions.",
        yearsExperience: 5,
        availability: "Available",
        fullHref: `/profile-paralegal.html?paralegalId=${candidateId}`,
      } } });
      return;
    }
    if (url.pathname.endsWith("/stream")) {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "text/plain", body: "" });
  });
}

async function runJourney(browser) {
  const counters = { readRequests: 0, notificationReadRequests: 0, tempPreviewAttempts: 0 };
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await installRoutes(page, counters);

  await page.goto(`http://context.test/case-detail.html?caseId=${matterId}&tab=applications&applicantId=${candidateId}`);
  await page.waitForFunction(() => document.querySelector(".lpc-context-dialog")?.open);
  assert.match(await page.locator(".lpc-context-sheet").innerText(), /Taylor Candidate/);
  assert.match(await page.locator(".lpc-context-sheet").innerText(), /I can support this production schedule/);
  assert.doesNotMatch(await page.locator(".lpc-context-sheet").innerText(), /email|phone|resume|storage|stripe/i);
  await page.getByRole("button", { name: "Preview Profile" }).click();
  await page.waitForFunction(() => document.querySelector(".lpc-context-title")?.textContent === "Taylor Candidate");
  assert.equal(new URL(page.url()).searchParams.get("panel"), "profile");
  assert.equal(await page.getByRole("link", { name: "View full Profile" }).getAttribute("href"), `/profile-paralegal.html?paralegalId=${candidateId}`);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".lpc-context-dialog")?.open && document.querySelector(".lpc-context-eyebrow")?.textContent === "Matter Application");
  assert.equal(new URL(page.url()).searchParams.get("applicantId"), candidateId);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".lpc-context-dialog")?.open);

  await page.goto(`http://context.test/case-detail.html?caseId=${matterId}&tab=files&fileId=${fileId}`);
  await page.waitForFunction(() => document.querySelector(".lpc-context-dialog")?.open);
  const filePanelText = await page.locator(".lpc-context-sheet").innerText();
  assert.match(filePanelText, /production-draft\.pdf/);
  assert.match(filePanelText, /24 KB/);
  assert.doesNotMatch(filePanelText, /storage|bucket|provider|stripe/i);

  await page.goto(`http://context.test/case-detail.html?caseId=${matterId}&tab=messages&messageId=${messageId}`);
  await page.waitForSelector(`[data-message-id="${messageId}"].is-deep-linked`);
  assert.equal(await page.locator(".message-card.is-deep-linked").count(), 1);
  assert.match(await page.locator(".message-card.is-deep-linked").innerText(), /revised production draft/i);
  assert.equal(counters.readRequests, 0, "an exact-message link must not bulk-mark the thread read");

  await page.goto(`http://context.test/case-detail.html?caseId=${matterId}&tab=messages&messageId=${staleCandidateId}`);
  await page.waitForFunction(() => document.querySelector("#caseMessageStatus")?.textContent.includes("no longer available"));
  assert.equal(await page.locator(".message-card.is-deep-linked").count(), 0);
  assert.equal(counters.readRequests, 0, "an unavailable message link must not mutate thread read state");

  await page.goto(`http://context.test/case-detail.html?caseId=${matterId}&tab=applications&applicantId=${temporaryCandidateId}`);
  await page.waitForFunction(() => document.querySelector(".lpc-context-state")?.textContent.includes("Unable to load"));
  await page.click(".lpc-context-retry");
  await page.waitForFunction(() => document.querySelector(".lpc-context-title")?.textContent === "Retry Candidate");
  assert.equal(counters.tempPreviewAttempts, 2);

  await page.goto(`http://context.test/case-detail.html?caseId=${matterId}&tab=applications&applicantId=${staleCandidateId}`);
  await page.waitForFunction(() => document.querySelector(".lpc-context-state")?.textContent.includes("No longer available"));
  assert.match(await page.locator(".lpc-context-state").innerText(), /may no longer have access/i);

  await page.goto(`http://context.test/case-detail.html?caseId=${matterId}&tab=applications`);
  await page.waitForSelector(".matter-row-preview");
  const unchangedBefore = await page.locator(".case-rail-header").screenshot();
  await page.click(".matter-row-preview");
  await page.waitForFunction(() => document.querySelector(".lpc-context-dialog")?.open);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".lpc-context-dialog")?.open);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("matter-row-preview")), true);
  const unchangedAfter = await page.locator(".case-rail-header").screenshot();
  assert.equal(Buffer.compare(unchangedBefore, unchangedAfter), 0, "the Matter selector changed outside the contextual panel");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.click(".matter-row-preview");
  await page.waitForFunction(() => document.querySelector(".lpc-context-dialog")?.open);
  const metrics = await page.locator(".lpc-context-sheet").evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scrollWidth: node.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(metrics.width <= metrics.viewport);
  assert.ok(metrics.scrollWidth <= metrics.width + 1);
  const closeBox = await page.locator(".lpc-context-close").boundingBox();
  assert.ok(closeBox && closeBox.width >= 44 && closeBox.height >= 44);
  await page.screenshot({ path: "/tmp/lpc-prompt3-context-mobile.png", fullPage: true });
  await page.close();

  const notificationPage = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await installRoutes(notificationPage, counters);
  await notificationPage.goto("http://context.test/notification-dashboard.html");
  await notificationPage.click("[data-notification-toggle]");
  await notificationPage.waitForSelector(".notif-item");
  assert.match(await notificationPage.locator(".notif-item").innerText(), /Taylor Candidate applied/);
  assert.match(await notificationPage.locator(".notif-primary-action").innerText(), /Review application/);
  await notificationPage.click(".notif-item");
  await notificationPage.waitForURL(`**/case-detail.html?caseId=${matterId}&tab=applications&applicantId=${candidateId}`);
  await notificationPage.waitForFunction(() => document.querySelector(".lpc-context-dialog")?.open);
  assert.match(await notificationPage.locator(".lpc-context-sheet").innerText(), /Taylor Candidate/);
  assert.equal(counters.notificationReadRequests, 1);
  await notificationPage.close();
}

async function runParalegalJourney(browser) {
  const counters = { readRequests: 0, notificationReadRequests: 0, tempPreviewAttempts: 0 };
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await installRoutes(page, counters, "paralegal");
  await page.goto("http://context.test/notification-dashboard.html");
  await page.click("[data-notification-toggle]");
  await page.waitForSelector(".notif-item");
  assert.match(await page.locator(".notif-primary-action").innerText(), /View message/);
  await page.click(".notif-item");
  await page.waitForURL(`**/case-detail.html?caseId=${matterId}&tab=messages&messageId=${messageId}`);
  await page.waitForSelector(`[data-message-id="${messageId}"].is-deep-linked`);
  assert.equal(counters.readRequests, 0);

  await page.goto(`http://context.test/case-detail.html?caseId=${matterId}&tab=files&fileId=${fileId}`);
  await page.waitForFunction(() => document.querySelector(".lpc-context-dialog")?.open);
  assert.match(await page.locator(".lpc-context-sheet").innerText(), /production-draft\.pdf/);

  await page.goto(`http://context.test/case-detail.html?caseId=${matterId}&tab=applications&applicantId=${candidateId}`);
  await page.waitForSelector('[data-matter-panel="overview"]:not([hidden])');
  assert.equal(await page.locator('[data-matter-tab="applications"]').isHidden(), true);
  assert.equal(await page.evaluate(() => Boolean(document.querySelector(".lpc-context-dialog")?.open)), false);
  assert.equal(new URL(page.url()).searchParams.get("tab"), "overview");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://context.test/case-detail.html?caseId=${matterId}&tab=files&fileId=${fileId}`);
  await page.waitForFunction(() => document.querySelector(".lpc-context-dialog")?.open);
  const metrics = await page.locator(".lpc-context-sheet").evaluate((node) => ({
    width: node.getBoundingClientRect().width,
    scrollWidth: node.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.ok(metrics.width <= metrics.viewport);
  assert.ok(metrics.scrollWidth <= metrics.width + 1);
  await page.screenshot({ path: "/tmp/lpc-prompt3-paralegal-context-mobile.png", fullPage: true });
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await runJourney(browser);
    await runParalegalJourney(browser);
    process.stdout.write("Object context mocked deep-link journey passed.\n");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
