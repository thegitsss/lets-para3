const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const authSource = fs.readFileSync(
  path.resolve(__dirname, "../../frontend/assets/scripts/auth.js"),
  "utf8"
);

async function installHarness(browser, mode) {
  const page = await browser.newPage();
  const state = {
    csrfCalls: 0,
    logoutCalls: 0,
    logoutTokens: [],
    mutationCalls: 0,
    mutationTokens: [],
  };

  await page.route("http://lpc.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/test") {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><body data-public-page=\"true\"><main id=\"main\">Auth request contract</main></body></html>",
      });
      return;
    }
    if (url.pathname === "/assets/scripts/auth.js") {
      await route.fulfill({ contentType: "text/javascript; charset=utf-8", body: authSource });
      return;
    }
    if (url.pathname === "/api/csrf") {
      state.csrfCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ csrfToken: `csrf-${state.csrfCalls}` }),
      });
      return;
    }
    if (url.pathname === "/api/mutation") {
      state.mutationCalls += 1;
      state.mutationTokens.push(request.headers()["x-csrf-token"] || "");
      if (mode === "csrf-retry" && state.mutationCalls === 1) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "Invalid CSRF token", code: "CSRF_INVALID" }),
        });
        return;
      }
      if (mode === "forbidden") {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "Forbidden", code: "FORBIDDEN" }),
        });
        return;
      }
      if (mode === "unauthorized") {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Unauthorized" }),
        });
        return;
      }
      if (mode === "expired-session") {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ msg: "Session expired" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    if (url.pathname === "/api/auth/logout") {
      state.logoutCalls += 1;
      state.logoutTokens.push(request.headers()["x-csrf-token"] || "");
      await route.fulfill({
        status: mode === "logout-failure" ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(mode === "logout-failure" ? { error: "Unavailable" } : { success: true }),
      });
      return;
    }
    if (url.pathname === "/login.html") {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><body><main id=\"main\">Login</main></body></html>",
      });
      return;
    }
    await route.fulfill({ status: 404, body: "Not found" });
  });

  await page.goto("http://lpc.test/test");
  await page.evaluate(() => {
    localStorage.setItem("lpc_user", JSON.stringify({
      id: "user-1",
      role: "attorney",
      status: "approved",
    }));
  });
  await page.evaluate(async () => {
    window.authContract = await import("/assets/scripts/auth.js");
    window.refreshSession = async () => ({ id: "user-1" });
    await window.authContract.fetchCSRF();
  });
  return { page, state };
}

async function verifyProjectedSessionPersistence(page) {
  const result = await page.evaluate(() => {
    const fullUser = {
      id: "user-1",
      _id: "user-1",
      role: "paralegal",
      status: "approved",
      firstName: "Avery",
      lastName: "Morgan",
      email: "private@example.com",
      phoneNumber: "+15555550123",
      bio: "Private profile text",
      state: "CA",
      stateExperience: ["CA"],
      availabilityDetails: { status: "unavailable", nextAvailable: "2026-09-01" },
      preferences: { theme: "dark", fontSize: "lg", hideProfile: true },
      onboarding: { paralegalTourCompleted: true, privateFlag: true },
    };
    window.authContract.persistSession({ user: fullUser });
    return JSON.parse(localStorage.getItem("lpc_user") || "null");
  });
  assert.deepEqual(result, {
    id: "user-1",
    _id: "user-1",
    role: "paralegal",
    status: "approved",
    firstName: "Avery",
    lastName: "Morgan",
    preferences: { theme: "dark", fontSize: "lg" },
    onboarding: { paralegalTourCompleted: true },
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
}

async function postMutation(page) {
  return page.evaluate(async () => {
    const response = await window.authContract.secureFetch("/api/mutation", {
      method: "POST",
      body: { decision: "approve" },
    });
    return {
      status: response.status,
      payload: await response.json(),
    };
  });
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    {
      const { page, state } = await installHarness(browser, "forbidden");
      await verifyProjectedSessionPersistence(page);
      const result = await postMutation(page);
      assert.equal(result.status, 403);
      assert.equal(result.payload.code, "FORBIDDEN");
      assert.equal(state.mutationCalls, 1, "authorization failures must not be retried");
      assert.equal(state.csrfCalls, 1, "authorization failures must not refresh CSRF state");
      assert.ok(await page.evaluate(() => localStorage.getItem("lpc_user")), "403 must preserve the valid session");
      assert.equal(new URL(page.url()).pathname, "/test");
      await page.close();
    }

    {
      const { page, state } = await installHarness(browser, "csrf-retry");
      const result = await postMutation(page);
      assert.deepEqual(result, { status: 200, payload: { ok: true } });
      assert.equal(state.mutationCalls, 2, "an explicit CSRF failure should retry exactly once");
      assert.equal(state.csrfCalls, 2, "the retry should obtain a fresh CSRF token");
      assert.deepEqual(state.mutationTokens, ["csrf-1", "csrf-2"]);
      assert.ok(await page.evaluate(() => localStorage.getItem("lpc_user")));
      await page.close();
    }

    {
      const { page, state } = await installHarness(browser, "unauthorized");
      await postMutation(page).catch(() => null);
      await page.waitForURL("**/login.html");
      assert.equal(state.mutationCalls, 1);
      assert.equal(await page.evaluate(() => localStorage.getItem("lpc_user")), null, "401 must clear the invalid session");
      await page.close();
    }

    {
      const { page, state } = await installHarness(browser, "expired-session");
      await postMutation(page).catch(() => null);
      await page.waitForURL("**/login.html");
      assert.equal(state.mutationCalls, 1);
      assert.equal(await page.evaluate(() => localStorage.getItem("lpc_user")), null, "an explicit revoked-session 403 must clear the stale session");
      await page.close();
    }

    {
      const { page, state } = await installHarness(browser, "logout-failure");
      const loggedOut = await page.evaluate(() => window.authContract.logout(null));
      assert.equal(loggedOut, false, "a failed server revocation must not be presented as logout");
      assert.equal(state.logoutCalls, 1);
      assert.deepEqual(state.logoutTokens, ["csrf-1"], "logout must carry CSRF protection");
      assert.ok(
        await page.evaluate(() => localStorage.getItem("lpc_user")),
        "failed revocation must preserve the local session so the UI cannot lie about logout"
      );
      await page.close();
    }

    {
      const { page, state } = await installHarness(browser, "logout-success");
      const loggedOut = await page.evaluate(() => window.authContract.logout(null));
      assert.equal(loggedOut, true);
      assert.equal(state.logoutCalls, 1);
      assert.deepEqual(state.logoutTokens, ["csrf-1"]);
      assert.equal(await page.evaluate(() => localStorage.getItem("lpc_user")), null);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log("[browser-contract] Auth request status handling passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
