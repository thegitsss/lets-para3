const { test, expect } = require("playwright/test");

function resolveHarnessHeaders() {
  const secret = String(process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET || "").trim();
  return secret ? { "x-ai-control-room-e2e-secret": secret } : {};
}

async function seedHarness(page, data = {}) {
  const requestData = {
    ...data,
    decisionCounts: {
      cmo: 3,
      ...(data.decisionCounts || {}),
    },
  };
  const response = await page.request.post("/api/admin/ai-control-room/dev/e2e/seed", {
    headers: resolveHarnessHeaders(),
    data: requestData,
  });
  if (!response.ok()) {
    throw new Error(`Unable to seed Control Room e2e fixtures: ${response.status()} ${await response.text()}`);
  }
  return response.json();
}

async function openControlRoom(page) {
  await page.goto("/admin-dashboard.html", { waitUntil: "domcontentloaded" });
  await page.locator('a[data-section="ai-control-room"]').click();
  await expect(page.locator("#section-ai-control-room.visible")).toBeVisible();
  await expect(page.locator("#aiRoomCardGrid .ai-room-card").first()).toBeVisible();
  await expect(page.locator("#aiRoomFocusBody")).toBeVisible();
  await expect(page.locator("#aiRoomFounderConsole")).toBeVisible();
}

async function openSecondaryDecisionQueue(page) {
  const consoleRoot = page.locator("#aiRoomFounderConsole");
  await expect(consoleRoot).toBeVisible();
  const isOpen = await consoleRoot.evaluate((node) => node.open);
  if (!isOpen) {
    await consoleRoot.locator(".ai-room-secondary-console-summary").click();
  }
  await expect(page.locator("#aiRoomFounderConsole .ai-room-founder-section--priority")).toBeVisible();
}

async function readSummaryCount(page, tileId) {
  const raw = await page.locator(`${tileId} .ai-room-summary-value`).innerText();
  const numeric = Number.parseInt(String(raw || "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(numeric) ? numeric : 0;
}

async function readDecisionQueueRemaining(page) {
  const raw = await page.locator(".ai-room-founder-queue-progress").first().innerText();
  const numeric = Number.parseInt(String(raw || "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(numeric) ? numeric : 0;
}

function founderDecisionCard(page, title) {
  return page.locator(".ai-room-founder-decision-card").filter({ hasText: title });
}

function founderFeedItem(page, title) {
  return page.locator(".ai-room-founder-feed-item").filter({ hasText: title });
}

function buildDecisionActionSelector({ kind = "", decision = "", groupKey = "", workKey = "", incidentId = "", approvalId = "", userId = "" } = {}) {
  const attrs = [`[data-ai-room-decision-kind="${kind}"]`, `[data-ai-room-decision="${decision}"]`];
  if (groupKey) attrs.push(`[data-ai-room-group-key="${groupKey}"]`);
  if (workKey) attrs.push(`[data-ai-room-work-key="${workKey}"]`);
  if (incidentId) attrs.push(`[data-ai-room-incident-id="${incidentId}"]`);
  if (approvalId) attrs.push(`[data-ai-room-approval-id="${approvalId}"]`);
  if (userId) attrs.push(`[data-ai-room-user-id="${userId}"]`);
  return attrs.join("");
}

function extractLeadingCount(value = "", fallback = 1) {
  const match = String(value || "").match(/(\d+)/);
  const parsed = match ? Number.parseInt(match[1], 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function verifyDecisionFlow({
  page,
  actionSelector,
  decisionTitle,
  expectedResponseUrl,
  requestAssertion = null,
  expectedRequestCount = 1,
}) {
  const button = page.locator(actionSelector).first();
  await expect(button).toBeVisible();
  const decisionCard = page.locator(".ai-room-founder-decision-card").filter({ has: button });
  if (decisionTitle) {
    await expect(decisionCard).toContainText(decisionTitle);
  }
  const beforeDecisionCardCount = await page.locator(".ai-room-founder-decision-card").count();
  const successMessage =
    (await button.getAttribute("data-ai-room-success-message")) ||
    ((await button.getAttribute("data-ai-room-decision")) === "approve" ? "Decision recorded." : "Rejection recorded.");
  const resolvedExpectedRequestCount =
    expectedRequestCount === "group_count"
      ? extractLeadingCount(await decisionCard.locator("h3").innerText().catch(() => decisionCard.innerText()), 1)
      : expectedRequestCount;
  const matchingRequests = [];
  const matchingResponses = [];
  const requestListener = (request) => {
    if (request.method() !== "POST") return;
    if (!expectedResponseUrl.test(request.url())) return;
    if (typeof requestAssertion === "function" && !requestAssertion(request)) return;
    matchingRequests.push(request);
  };
  const responseListener = (response) => {
    if (response.request().method() !== "POST") return;
    if (!expectedResponseUrl.test(response.url())) return;
    if (typeof requestAssertion === "function" && !requestAssertion(response.request())) return;
    matchingResponses.push(response);
  };
  page.on("request", requestListener);
  page.on("response", responseListener);

  try {
    await button.click();
    await expect.poll(() => matchingRequests.length).toBe(resolvedExpectedRequestCount);
    await expect.poll(() => matchingResponses.length).toBe(resolvedExpectedRequestCount);
  } finally {
    page.off("request", requestListener);
    page.off("response", responseListener);
  }

  const failedResponse = matchingResponses.find((response) => !response.ok());
  if (failedResponse) {
    throw new Error(
      `Unexpected ${failedResponse.status()} response for ${decisionTitle || actionSelector}: ${await failedResponse.text()}`
    );
  }
  await expect(page.locator("#toastBanner")).toContainText(successMessage);
  await expect(page.locator(actionSelector)).toHaveCount(0);
  await expect
    .poll(() => page.locator(".ai-room-founder-decision-card").count())
    .toBeLessThan(beforeDecisionCardCount);
}

test("summary and core founder-operating rendering are wired end-to-end", async ({ page }) => {
  const seeded = await seedHarness(page);
  await openControlRoom(page);

  await expect(page.locator("#aiSummaryUrgent")).toContainText("Needs Your Decision");
  await expect(page.locator("#aiSummaryReview")).toContainText("Auto-Handled Today");
  await expect(page.locator("#aiSummaryBlocked")).toContainText("Blocked Waiting on You");
  await expect(page.locator("#aiSummaryRisk")).toContainText("High Risk");
  await expect(page.locator("#aiSummaryHealth")).toContainText("System Health");
  await expect(page.locator("#aiRoomFocusTitle")).not.toHaveText("Founder Copilot");
  await expect(page.locator("#aiRoomFounderConsole .ai-room-secondary-console-summary")).toContainText("Decision Queue & Audit");

  const cmoCard = page.locator('[data-ai-room-card-key="cmo"]');
  await expect(cmoCard).toContainText("Most Important Next Item");
  await expect(cmoCard).toContainText(/decisions/i);
  await expect(cmoCard).toContainText(/posts ready to publish/i);
});

test("top founder decisions update optimistically before the real route responds", async ({ page }) => {
  const seeded = await seedHarness(page);
  await openControlRoom(page);
  await openSecondaryDecisionQueue(page);

  const beforeUrgentCount = await readSummaryCount(page, "#aiSummaryUrgent");
  const beforeRemaining = await readDecisionQueueRemaining(page);
  await page.route(/\/api\/admin\/incidents\/.+\/approvals\/.+\/decision$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });

  const topDecisionBefore = page.locator(".ai-room-founder-decision-card").first();
  await expect(topDecisionBefore).toContainText(seeded.expectedUi.decisionTitles.cto);

  const responsePromise = page.waitForResponse((response) => {
    return (
      response.request().method() === "POST" &&
      /\/api\/admin\/incidents\/.+\/approvals\/.+\/decision$/.test(response.url())
    );
  });

  await topDecisionBefore.getByRole("button", { name: /^Yes/i }).click();

  await expect(founderDecisionCard(page, seeded.expectedUi.decisionTitles.cto)).toHaveCount(0);
  await expect(page.locator(".ai-room-founder-decision-card").first()).toContainText(seeded.expectedUi.decisionTitles.cco);
  await expect
    .poll(() => readSummaryCount(page, "#aiSummaryUrgent"), { timeout: 1000 })
    .toBe(Math.max(0, beforeUrgentCount - 1));
  await expect
    .poll(() => readDecisionQueueRemaining(page), { timeout: 1000 })
    .toBe(Math.max(0, beforeRemaining - 1));
  await expect(page.locator('[data-ai-room-card-key="cto"]')).not.toContainText("Yes, move fix forward");

  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  await expect(page.locator("#toastBanner")).toContainText(/engineering approval recorded/i);
});

test("duplicate marketing decisions collapse into one grouped card and approve all through existing routes", async ({ page }) => {
  const seeded = await seedHarness(page, {
    decisionCounts: { cmo: 3 },
  });
  await openControlRoom(page);
  await openSecondaryDecisionQueue(page);

  const groupedButtonSelector = buildDecisionActionSelector({
    kind: "decision_group",
    decision: "approve",
    groupKey: "CMO:marketing_draft_packet:marketing_draft",
  });
  const groupedButton = page.locator(groupedButtonSelector).first();
  await expect(groupedButton).toBeVisible();
  const groupedCard = page.locator(".ai-room-founder-decision-card").filter({ has: groupedButton });
  await expect(groupedCard).toHaveCount(1);
  await expect(groupedCard).toContainText(/posts ready to publish/i);
  await expect(groupedCard).toContainText("Yes, publish all");
  await expect(page.locator(".ai-room-founder-decision-card").filter({ hasText: "Publish LinkedIn post" })).toHaveCount(0);

  const titleText = await groupedCard.locator("h3").innerText();
  const groupedCount = extractLeadingCount(titleText, 1);
  const beforeRemaining = await readDecisionQueueRemaining(page);
  await expect(groupedCard).toContainText(new RegExp(`Publish all ${groupedCount} LinkedIn company posts`, "i"));

  const approveRequests = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/admin\/approvals\/items\/.+\/approve$/.test(request.url())) {
      approveRequests.push(request.url());
    }
  });
  await groupedButton.click();

  await expect(page.locator("#toastBanner")).toContainText(new RegExp(`${groupedCount} LinkedIn posts approved`, "i"));
  await expect(groupedCard).toHaveCount(0);
  await expect.poll(() => approveRequests.length).toBe(groupedCount);
  await expect.poll(() => readDecisionQueueRemaining(page)).toBe(Math.max(0, beforeRemaining - 1));
  await expect(page.locator('[data-ai-room-card-key="cmo"]')).not.toContainText(/posts ready to publish/i);
});

test("duplicate marketing decisions collapse into one grouped card and reject all through existing routes", async ({ page }) => {
  await seedHarness(page, {
    decisionCounts: { cmo: 3 },
  });
  await openControlRoom(page);
  await openSecondaryDecisionQueue(page);

  const groupedButtonSelector = buildDecisionActionSelector({
    kind: "decision_group",
    decision: "reject",
    groupKey: "CMO:marketing_draft_packet:marketing_draft",
  });
  const groupedButton = page.locator(groupedButtonSelector).first();
  await expect(groupedButton).toBeVisible();
  const groupedCard = page.locator(".ai-room-founder-decision-card").filter({ has: groupedButton });
  await expect(groupedCard).toHaveCount(1);
  await expect(groupedCard).toContainText(/posts ready to publish/i);
  await expect(groupedCard).toContainText("No, keep all out");

  const titleText = await groupedCard.locator("h3").innerText();
  const groupedCount = extractLeadingCount(titleText, 1);
  const beforeRemaining = await readDecisionQueueRemaining(page);
  const rejectRequests = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/admin\/approvals\/items\/.+\/reject$/.test(request.url())) {
      rejectRequests.push(request.url());
    }
  });

  await groupedButton.click();

  await expect(page.locator("#toastBanner")).toContainText(new RegExp(`${groupedCount} LinkedIn posts held back`, "i"));
  await expect(groupedCard).toHaveCount(0);
  await expect.poll(() => rejectRequests.length).toBe(groupedCount);
  await expect.poll(() => readDecisionQueueRemaining(page)).toBe(Math.max(0, beforeRemaining - 1));
  await expect(page.locator('[data-ai-room-card-key="cmo"]')).not.toContainText(/posts ready to publish/i);
});

const approveFlows = [
  {
    lane: "CCO",
    titleKey: "cco",
    expectedResponseUrl: /\/api\/admin\/approvals\/items\/.+\/approve$/,
    buildActionSelector: (seeded) =>
      buildDecisionActionSelector({
        kind: "approval_item",
        decision: "approve",
        workKey: seeded.ccoDecision.workKey,
      }),
  },
  {
    lane: "CMO",
    titleKey: "cmo",
    expectedResponseUrl: /\/api\/admin\/approvals\/items\/.+\/approve$/,
    decisionTitle: /posts ready to publish/i,
    expectedRequestCount: "group_count",
    buildActionSelector: (seeded) =>
      buildDecisionActionSelector({
        kind: "decision_group",
        decision: "approve",
        groupKey: "CMO:marketing_draft_packet:marketing_draft",
      }),
  },
  {
    lane: "CSO",
    titleKey: "cso",
    expectedResponseUrl: /\/api\/admin\/approvals\/items\/.+\/approve$/,
    buildActionSelector: (seeded) =>
      buildDecisionActionSelector({
        kind: "approval_item",
        decision: "approve",
        workKey: seeded.csoDecision.workKey,
      }),
  },
  {
    lane: "CTO",
    titleKey: "cto",
    expectedResponseUrl: /\/api\/admin\/incidents\/.+\/approvals\/.+\/decision$/,
    requestAssertion: (request) => request.postDataJSON()?.decision === "approve",
    buildActionSelector: (seeded) =>
      buildDecisionActionSelector({
        kind: "incident_approval",
        decision: "approve",
        incidentId: seeded.ctoDecision.incidentPublicId,
        approvalId: seeded.ctoDecision.approvalId,
      }),
  },
  {
    lane: "CAO",
    titleKey: "cao",
    expectedResponseUrl: /\/api\/admin\/users\/.+\/approve$/,
    buildActionSelector: (seeded) =>
      buildDecisionActionSelector({
        kind: "user_review",
        decision: "approve",
        userId: seeded.caoDecision.userId,
      }),
  },
];

for (const flow of approveFlows) {
  test(`decision approve flow hits the real ${flow.lane} path and refreshes the queue`, async ({ page }) => {
    const seeded = await seedHarness(page);
    await openControlRoom(page);
    await openSecondaryDecisionQueue(page);
    await verifyDecisionFlow({
      page,
      actionSelector: flow.buildActionSelector(seeded.seeded),
      decisionTitle: flow.decisionTitle || seeded.expectedUi.decisionTitles[flow.titleKey],
      expectedResponseUrl: flow.expectedResponseUrl,
      requestAssertion: flow.requestAssertion || null,
      expectedRequestCount: flow.expectedRequestCount || 1,
    });
  });
}

const rejectFlows = [
  {
    lane: "CCO",
    titleKey: "cco",
    expectedResponseUrl: /\/api\/admin\/approvals\/items\/.+\/reject$/,
    buildActionSelector: (seeded) =>
      buildDecisionActionSelector({
        kind: "approval_item",
        decision: "reject",
        workKey: seeded.ccoDecision.workKey,
      }),
  },
  {
    lane: "CMO",
    titleKey: "cmo",
    expectedResponseUrl: /\/api\/admin\/approvals\/items\/.+\/reject$/,
    decisionTitle: /posts ready to publish/i,
    expectedRequestCount: "group_count",
    buildActionSelector: (seeded) =>
      buildDecisionActionSelector({
        kind: "decision_group",
        decision: "reject",
        groupKey: "CMO:marketing_draft_packet:marketing_draft",
      }),
  },
  {
    lane: "CSO",
    titleKey: "cso",
    expectedResponseUrl: /\/api\/admin\/approvals\/items\/.+\/reject$/,
    buildActionSelector: (seeded) =>
      buildDecisionActionSelector({
        kind: "approval_item",
        decision: "reject",
        workKey: seeded.csoDecision.workKey,
      }),
  },
  {
    lane: "CTO",
    titleKey: "cto",
    expectedResponseUrl: /\/api\/admin\/incidents\/.+\/approvals\/.+\/decision$/,
    requestAssertion: (request) => request.postDataJSON()?.decision === "reject",
    buildActionSelector: (seeded) =>
      buildDecisionActionSelector({
        kind: "incident_approval",
        decision: "reject",
        incidentId: seeded.ctoDecision.incidentPublicId,
        approvalId: seeded.ctoDecision.approvalId,
      }),
  },
  {
    lane: "CAO",
    titleKey: "cao",
    expectedResponseUrl: /\/api\/admin\/users\/.+\/deny$/,
    buildActionSelector: (seeded) =>
      buildDecisionActionSelector({
        kind: "user_review",
        decision: "deny",
        userId: seeded.caoDecision.userId,
      }),
  },
];

for (const flow of rejectFlows) {
  test(`decision reject flow hits the real ${flow.lane} path and refreshes the queue`, async ({ page }) => {
    const seeded = await seedHarness(page);
    await openControlRoom(page);
    await openSecondaryDecisionQueue(page);
    await verifyDecisionFlow({
      page,
      actionSelector: flow.buildActionSelector(seeded.seeded),
      decisionTitle: flow.decisionTitle || seeded.expectedUi.decisionTitles[flow.titleKey],
      expectedResponseUrl: flow.expectedResponseUrl,
      requestAssertion: flow.requestAssertion || null,
      expectedRequestCount: flow.expectedRequestCount || 1,
    });
  });
}

test("blocked items explain why they are blocked and how the founder can unblock them", async ({ page }) => {
  const seeded = await seedHarness(page);
  await openControlRoom(page);
  await openSecondaryDecisionQueue(page);

  const blockedItem = founderFeedItem(page, seeded.expectedUi.blockedTitles.cmo);
  await expect(blockedItem.first()).toBeVisible();
  await expect(blockedItem.first()).toContainText("Why blocked:");
  await expect(blockedItem.first()).toContainText("To unblock:");
  await expect(blockedItem.first()).toContainText("Needs attention today");
  await expect(blockedItem.locator("[data-ai-room-decision-kind]")).toHaveCount(0);
});

test("autonomous items render what happened and why it was safe without decision buttons", async ({ page }) => {
  const seeded = await seedHarness(page);
  await openControlRoom(page);
  await openSecondaryDecisionQueue(page);

  const autoItem = founderFeedItem(page, seeded.expectedUi.autonomousTitle);
  await expect(autoItem.first()).toBeVisible();
  await expect(autoItem.first()).toContainText("Safe because:");
  await expect(autoItem.first()).toContainText(/confidence/i);
  await expect(autoItem.locator("[data-ai-room-decision-kind]")).toHaveCount(0);
});

test("informational-only items render without quick action buttons", async ({ page }) => {
  const seeded = await seedHarness(page);
  await openControlRoom(page);
  await openSecondaryDecisionQueue(page);

  const infoItem = page
    .locator(".ai-room-founder-feed-item")
    .filter({ hasText: "Informational only" })
    .filter({ hasText: seeded.runKey });
  await expect(infoItem.first()).toBeVisible();
  await expect(infoItem.first()).toContainText(/informational only/i);
  await expect(infoItem.locator("[data-ai-room-decision-kind]")).toHaveCount(0);
});

test("policy integrity holds in the UI for manual-only finance lanes", async ({ page }) => {
  await seedHarness(page);
  await openControlRoom(page);

  const cfoCard = page.locator('[data-ai-room-card-key="cfo"]');
  await expect(cfoCard).toBeVisible();
  await expect(cfoCard).toContainText("No founder quick decision available");
  await expect(cfoCard.locator("[data-ai-room-decision-kind]")).toHaveCount(0);
});
