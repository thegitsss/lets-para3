const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const frontendRoot = path.resolve(__dirname, "../../frontend");
const activeMatter = Object.freeze({
  id: "64b000000000000000000031",
  _id: "64b000000000000000000031",
  caseId: "64b000000000000000000031",
  title: "Phase 3 browser workspace",
  jobTitle: "Phase 3 browser workspace",
  status: "in progress",
  archived: false,
  paymentReleased: false,
  escrowStatus: "funded",
  escrowIntentId: "pi_phase3_browser",
  paralegalId: "64b000000000000000000032",
  deadlineDate: "2026-10-15",
  practiceArea: "Immigration",
});

const user = Object.freeze({
  id: "64b000000000000000000032",
  _id: "64b000000000000000000032",
  role: "paralegal",
  status: "approved",
  firstName: "Phase Three",
  lastName: "Paralegal",
  state: "CA",
  stateExperience: ["CA"],
  practiceAreas: ["Immigration"],
  yearsExperience: 8,
  stripeAccountId: "acct_phase3_browser",
  stripeOnboarded: true,
  stripePayoutsEnabled: true,
});

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

function dashboardPayload(active) {
  const activeCases = active ? [activeMatter] : [];
  return {
    metrics: {
      activeCases: activeCases.length,
      pendingApplications: 0,
      earnings: 0,
      earningsTotal: 0,
      earningsLast30Days: 0,
      expectedPayouts: active ? 40000 : 0,
      nextPayoutDate: null,
    },
    activeCases,
    myApplications: [],
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const state = {
    active: true,
    holdNextDashboard: false,
    heldStarted: null,
    releaseHeld: null,
    dashboardRequests: 0,
    revokedSecondarySession: false,
    secondarySessionDenials: 0,
    workspaceAllowed: true,
    holdWorkspaceDenial: false,
    heldWorkspaceStarted: null,
    releaseWorkspaceDenial: null,
    workspaceRequests: [],
  };

  const installRoutes = async (context) => {
    await context.addInitScript((sessionUser) => {
      localStorage.setItem("lpc_user", JSON.stringify(sessionUser));
      let phase3Visibility = "visible";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => phase3Visibility });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => phase3Visibility !== "visible" });
      window.__phase3SetVisibility = (value) => {
        phase3Visibility = value === "hidden" ? "hidden" : "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      };
      class TestEventSource extends EventTarget {
        constructor(url) {
          super();
          this.url = url;
          this.readyState = 1;
          window.__phase3EventSources = window.__phase3EventSources || [];
          window.__phase3EventSources.push(this);
          queueMicrotask(() => this.dispatchEvent(new Event("open")));
        }
        close() { this.readyState = 2; }
      }
      window.EventSource = TestEventSource;
      window.__phase3EmitNotificationSse = () => {
        (window.__phase3EventSources || [])
          .filter((source) => String(source.url).includes("/api/notifications/stream"))
          .forEach((source) => source.dispatchEvent(new MessageEvent("notifications", { data: "{}" })));
      };
    }, user);

    await context.route("http://lpc.test/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === `/api/cases/${activeMatter.id}/withdraw`) {
        const body = request.postDataJSON?.() || {};
        state.active = body.active === true;
        if (typeof body.workspaceAllowed === "boolean") state.workspaceAllowed = body.workspaceAllowed;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, active: state.active }) });
        return;
      }
      if (pathname === "/api/account/sessions/revoke-others") {
        state.revokedSecondarySession = true;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, revokedCount: 1 }) });
        return;
      }
      if (pathname === "/api/auth/me") {
        if (request.headers()["x-phase3-client"] === "secondary" && state.revokedSecondarySession) {
          state.secondarySessionDenials += 1;
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ msg: "Session expired" }) });
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user }) });
        return;
      }
      if (pathname === "/api/csrf") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ csrfToken: "phase3-csrf" }) });
        return;
      }
      if (pathname === "/api/users/me") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) });
        return;
      }
      if (pathname === "/api/paralegal/dashboard") {
        state.dashboardRequests += 1;
        const snapshot = dashboardPayload(state.active);
        if (state.holdNextDashboard) {
          state.holdNextDashboard = false;
          let release;
          const wait = new Promise((resolve) => { release = resolve; });
          state.releaseHeld = release;
          state.heldStarted?.();
          await wait;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
        return;
      }
      if (pathname === `/api/cases/${activeMatter.id}` && request.method() === "GET") {
        state.workspaceRequests.push(`${request.method()} ${pathname}`);
        if (!state.workspaceAllowed) {
          if (state.holdWorkspaceDenial) {
            state.holdWorkspaceDenial = false;
            let release;
            const wait = new Promise((resolve) => { release = resolve; });
            state.releaseWorkspaceDenial = release;
            state.heldWorkspaceStarted?.();
            await wait;
          }
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Access denied" }) });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...activeMatter,
            details: "Confidential browser matter details",
            attorney: { id: "64b000000000000000000033", firstName: "Phase", lastName: "Attorney", role: "attorney" },
            paralegal: user,
            tasks: [{ title: "Confidential browser task", completed: false }],
            tasksLocked: true,
            files: [],
            readOnly: false,
            matterExperience: {
              header: {
                title: activeMatter.title,
                status: { code: "in_progress", label: "In Progress" },
                relationship: "Assigned paralegal",
                primaryAction: { label: "Open messages", tab: "messages" },
              },
              sections: ["overview", "work", "files", "messages", "activity", "financials"].map((id) => ({ id })),
              overview: { summary: "Confidential browser matter details", taskProgress: { completed: 0, total: 1 } },
              work: { tasks: [{ title: "Confidential browser task", completed: false }], readOnly: false },
              activity: [],
              financials: {},
            },
          }),
        });
        return;
      }
      if (pathname === `/api/messages/${activeMatter.id}` && request.method() === "GET") {
        state.workspaceRequests.push(`${request.method()} ${pathname}`);
        await route.fulfill({
          status: state.workspaceAllowed ? 200 : 403,
          contentType: "application/json",
          body: JSON.stringify(state.workspaceAllowed ? {
            messages: [{
              _id: "64b000000000000000000034",
              caseId: activeMatter.id,
              senderId: { _id: "64b000000000000000000033", firstName: "Phase", lastName: "Attorney", role: "attorney" },
              senderRole: "attorney",
              text: "Confidential browser message",
              createdAt: "2026-09-01T15:00:00.000Z",
            }],
          } : { error: "Access denied" }),
        });
        return;
      }
      if (pathname === `/api/uploads/case/${activeMatter.id}` && request.method() === "GET") {
        state.workspaceRequests.push(`${request.method()} ${pathname}`);
        await route.fulfill({
          status: state.workspaceAllowed ? 200 : 403,
          contentType: "application/json",
          body: JSON.stringify(state.workspaceAllowed ? {
            files: [{ id: "64b000000000000000000035", originalName: "Confidential-browser-file.pdf", status: "approved", securityStatus: "clean" }],
          } : { error: "Access denied" }),
        });
        return;
      }
      if (pathname.startsWith("/api/cases/my")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.workspaceAllowed ? [activeMatter] : []) });
        return;
      }
      const emptyResponses = {
        "/api/payments/connect/status": { connected: true, detailsSubmitted: true, payoutsEnabled: true },
        "/api/stripe/connect/status": { connected: true, detailsSubmitted: true, payoutsEnabled: true },
        "/api/cases/invited-to": { items: [] },
        "/api/events": { items: [] },
        "/api/messages/threads": { threads: [] },
        "/api/messages/unread-count": { count: 0 },
        "/api/applications/my": [],
        "/api/applications/recommendation-exclusions": { matterIds: [] },
        "/api/jobs/open": [],
        "/api/notifications": { notifications: [], unreadCount: 0 },
        "/api/account/preferences": {},
      };
      const responseKey = Object.keys(emptyResponses).find((key) => pathname === key);
      if (responseKey) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyResponses[responseKey]) });
        return;
      }
      if (pathname.startsWith("/api/")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      const relative = pathname === "/" ? "dashboard-paralegal.html" : pathname.replace(/^\//, "");
      const filePath = path.resolve(frontendRoot, relative);
      if (!filePath.startsWith(`${frontendRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        await route.fulfill({ status: 404, body: "Not found" });
        return;
      }
      await route.fulfill({ status: 200, contentType: contentType(filePath), body: fs.readFileSync(filePath) });
    });
  };

  const context = await browser.newContext();
  const separateContext = await browser.newContext();
  await installRoutes(context);
  await installRoutes(separateContext);
  const [primary, sameUserTab, separateDevice] = await Promise.all([
    context.newPage(),
    context.newPage(),
    separateContext.newPage(),
  ]);
  await sameUserTab.setExtraHTTPHeaders({ "x-phase3-client": "secondary" });
  const pages = [primary, sameUserTab, separateDevice];
  await Promise.all(pages.map((page) => page.goto("http://lpc.test/dashboard-paralegal.html")));
  await Promise.all(pages.map((page) => page.waitForFunction(() =>
    document.querySelector('[data-field="homeActiveMatters"]')?.textContent?.trim() === "1"
  )));

  let heldStartedResolve;
  const heldStarted = new Promise((resolve) => { heldStartedResolve = resolve; });
  state.heldStarted = heldStartedResolve;
  state.holdNextDashboard = true;
  await sameUserTab.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:lifecycle-refresh", { detail: { id: "phase3-held", url: "/api/cases/64b000000000000000000031" } })));
  await heldStarted;

  await primary.evaluate(async () => {
    const { secureFetch } = await import("/assets/scripts/auth.js");
    const response = await secureFetch("/api/cases/64b000000000000000000031/withdraw", { method: "POST", body: { active: false } });
    if (!response.ok) throw new Error(`transition failed: ${response.status}`);
  });
  state.releaseHeld();

  await Promise.all([primary, sameUserTab].map((page) => page.waitForFunction(() =>
    document.querySelector('[data-field="homeActiveMatters"]')?.textContent?.trim() === "0"
  )));
  assert.equal(await separateDevice.locator('[data-field="homeActiveMatters"]').textContent(), "1");

  await separateDevice.evaluate(() => window.__phase3EmitNotificationSse());
  await separateDevice.waitForFunction(() =>
    document.querySelector('[data-field="homeActiveMatters"]')?.textContent?.trim() === "0"
  );

  state.active = true;
  await separateDevice.evaluate(() => window.__phase3SetVisibility("visible"));
  await separateDevice.waitForFunction(() =>
    document.querySelector('[data-field="homeActiveMatters"]')?.textContent?.trim() === "1"
  );
  await separateDevice.evaluate(() => window.__phase3SetVisibility("hidden"));
  state.active = false;
  await separateDevice.evaluate(() => window.__phase3EmitNotificationSse());
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await separateDevice.locator('[data-field="homeActiveMatters"]').textContent(), "1");
  await separateDevice.evaluate(() => window.__phase3SetVisibility("visible"));
  await separateDevice.waitForFunction(() =>
    document.querySelector('[data-field="homeActiveMatters"]')?.textContent?.trim() === "0"
  );

  state.active = true;
  await separateDevice.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await separateDevice.waitForFunction(() =>
    document.querySelector('[data-field="homeActiveMatters"]')?.textContent?.trim() === "1"
  );
  state.active = false;
  await separateDevice.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await separateDevice.waitForFunction(() =>
    document.querySelector('[data-field="homeActiveMatters"]')?.textContent?.trim() === "0"
  );

  state.active = true;
  await primary.reload();
  await primary.waitForFunction(() => document.querySelector('[data-field="homeActiveMatters"]')?.textContent?.trim() === "1");
  await primary.evaluate(async () => {
    const { secureFetch } = await import("/assets/scripts/auth.js");
    await secureFetch("/api/cases/64b000000000000000000031/withdraw", { method: "POST", body: { active: true } });
    await secureFetch("/api/cases/64b000000000000000000031/withdraw", { method: "POST", body: { active: false } });
  });
  await primary.waitForFunction(() => document.querySelector('[data-field="homeActiveMatters"]')?.textContent?.trim() === "0");

  await primary.evaluate(async () => {
    const { secureFetch } = await import("/assets/scripts/auth.js");
    await secureFetch("/api/account/sessions/revoke-others", { method: "POST" });
  });
  try {
  await sameUserTab.waitForURL(/login\.html$/, { timeout: 5000 });
  } catch {
    const diagnostics = await sameUserTab.evaluate(() => ({
      href: location.href,
      visibility: document.visibilityState,
      storedUser: localStorage.getItem("lpc_user"),
    }));
    throw new Error(`revoked session did not redirect: ${JSON.stringify({ ...diagnostics, denials: state.secondarySessionDenials })}`);
  }

  const workspaceContext = await browser.newContext();
  await installRoutes(workspaceContext);
  const workspacePage = await workspaceContext.newPage();
  const workspaceErrors = [];
  workspacePage.on("pageerror", (error) => workspaceErrors.push(error.message));
  workspacePage.on("console", (message) => {
    if (message.type() === "error") workspaceErrors.push(message.text());
  });
  state.workspaceAllowed = true;
  await workspacePage.goto(`http://lpc.test/case-detail.html?caseId=${activeMatter.id}&tab=messages`);
  try {
    await workspacePage.waitForFunction(() => document.body.textContent.includes("Confidential browser message"), null, { timeout: 5000 });
  } catch {
    throw new Error(`workspace fixture did not render: ${JSON.stringify({ href: workspacePage.url(), body: (await workspacePage.locator("body").textContent()).slice(0, 800), errors: workspaceErrors, requests: state.workspaceRequests })}`);
  }
  assert.match(await workspacePage.locator("body").textContent(), /Confidential-browser-file\.pdf/);

  let workspaceHeldResolve;
  const workspaceHeld = new Promise((resolve) => { workspaceHeldResolve = resolve; });
  state.heldWorkspaceStarted = workspaceHeldResolve;
  state.holdWorkspaceDenial = true;
  await workspacePage.evaluate(async () => {
    const { secureFetch } = await import("/assets/scripts/auth.js");
    await secureFetch("/api/cases/64b000000000000000000031/withdraw", {
      method: "POST",
      body: { active: false, workspaceAllowed: false },
    });
  });
  await workspaceHeld;
  await workspacePage.waitForFunction(() => document.body.textContent.includes("Refreshing workspace access"));
  const purgedWorkspaceText = await workspacePage.locator("body").textContent();
  assert.doesNotMatch(purgedWorkspaceText, /Confidential browser message/);
  assert.doesNotMatch(purgedWorkspaceText, /Confidential-browser-file\.pdf/);
  state.releaseWorkspaceDenial();
  await workspacePage.waitForURL(/dashboard-paralegal\.html(?:\?[^#]*)?#cases(?:-completed)?$/);

  assert.ok(state.dashboardRequests >= 10, `expected refresh coverage, observed ${state.dashboardRequests} dashboard requests`);
  await browser.close();
  console.log("Phase 3 stale UI browser contract passed: same-tab, cross-tab, separate-context SSE, visibility/pageshow fallback, delayed stale response, reload, rapid transitions, revoked-session redirect, and pre-denial workspace purge.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
