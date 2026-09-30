const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const frontendRoot = path.resolve(__dirname, "../../frontend");
const sources = {
  auth: fs.readFileSync(path.join(frontendRoot, "assets/scripts/auth.js"), "utf8"),
  homepage: fs.readFileSync(path.join(frontendRoot, "assets/scripts/homepage.js"), "utf8"),
  index: fs.readFileSync(path.join(frontendRoot, "index.html"), "utf8"),
  utility: fs.readFileSync(path.join(frontendRoot, "assets/scripts/utility-header.js"), "utf8"),
};

function approvedUser(role) {
  return {
    id: `${role}-1`,
    firstName: "Avery",
    lastName: "Morgan",
    role,
    status: "approved",
  };
}

async function installRoutes(page, { pageBody, initialUser }) {
  const state = {
    csrfCalls: 0,
    logoutCalls: 0,
    logoutTokens: [],
    user: initialUser,
  };

  await page.route("http://lpc.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/index.html" || url.pathname === "/utility.html") {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: pageBody });
      return;
    }
    if (url.pathname === "/assets/scripts/homepage.js") {
      await route.fulfill({ contentType: "text/javascript; charset=utf-8", body: sources.homepage });
      return;
    }
    if (url.pathname === "/assets/scripts/utility-header.js") {
      await route.fulfill({ contentType: "text/javascript; charset=utf-8", body: sources.utility });
      return;
    }
    if (url.pathname === "/assets/scripts/auth.js") {
      await route.fulfill({ contentType: "text/javascript; charset=utf-8", body: sources.auth });
      return;
    }
    if (["/assets/scripts/utils/help-storage.mjs", "/assets/scripts/utils/document-navigation.mjs"].includes(url.pathname)) {
      await route.fulfill({ contentType: "text/javascript; charset=utf-8", body: fs.readFileSync(path.join(frontendRoot, url.pathname.slice(1)), "utf8") });
      return;
    }
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ user: state.user }),
      });
      return;
    }
    if (url.pathname === "/api/csrf") {
      state.csrfCalls += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ csrfToken: `public-csrf-${state.csrfCalls}` }),
      });
      return;
    }
    if (url.pathname === "/api/auth/logout") {
      state.logoutCalls += 1;
      state.logoutTokens.push(request.headers()["x-csrf-token"] || "");
      state.user = null;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
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

  return state;
}

async function verifyHomepage(browser) {
  const page = await browser.newPage();
  const state = await installRoutes(page, { pageBody: sources.index, initialUser: approvedUser("attorney") });
  await page.goto("http://lpc.test/index.html");
  await page.locator("#authAction").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#authAction")?.textContent === "Dashboard");
  assert.equal(await page.locator("#authAction").getAttribute("href"), "dashboard-attorney.html");
  assert.equal(await page.locator("[data-post-matter-action]").first().getAttribute("href"), "create-case.html");
  await page.locator("#logoutAction").click();
  await page.waitForURL("**/index.html");
  await page.waitForFunction(() => document.querySelector("#authAction")?.textContent === "Sign in");
  assert.equal(state.logoutCalls, 1);
  assert.deepEqual(state.logoutTokens, ["public-csrf-1"]);
  await page.close();
}

async function verifyUtilityHeader(browser) {
  const page = await browser.newPage();
  const utilityBody = `<!doctype html><html><body>
    <a data-utility-auth href="login.html">Sign In</a>
    <a data-utility-signup href="signup.html">Sign Up</a>
    <button data-utility-logout type="button" hidden>Log Out</button>
    <span data-utility-member hidden>Member tools</span>
    <span data-utility-guest>Guest tools</span>
    <a data-utility-dashboard href="login.html">Workspace</a>
    <span data-utility-name></span><span data-utility-role></span>
    <img data-utility-avatar alt="" />
    <main id="main"></main>
    <script src="assets/scripts/utility-header.js" defer></script>
  </body></html>`;
  const state = await installRoutes(page, { pageBody: utilityBody, initialUser: approvedUser("director") });
  await page.goto("http://lpc.test/utility.html");
  await page.waitForFunction(() => document.querySelector("[data-utility-auth]")?.textContent === "Dashboard");
  assert.equal(await page.locator("[data-utility-auth]").getAttribute("href"), "director-portal.html");
  assert.equal(await page.locator("[data-utility-role]").textContent(), "Director Workspace");
  assert.equal(await page.locator("[data-utility-avatar]").getAttribute("src"), "assets/avatar-placeholder.svg");
  await page.locator("[data-utility-logout]").click();
  await page.waitForURL("**/login.html");
  assert.equal(state.logoutCalls, 1);
  assert.deepEqual(state.logoutTokens, ["public-csrf-1"]);
  await page.close();
}

async function verifyPublicDirectory(browser) {
  const page = await browser.newPage();
  const publicProfile = {
    _id: "6a530880c2e01cd42b2d122d",
    name: "Alex Rivera",
    location: "MO",
    practiceAreas: ["Estate Planning & Probate"],
    yearsExperience: 10,
    bio: "Experienced paralegal supporting estate matters.",
    availability: "Available now",
  };
  await page.route("http://lpc.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ contentType: "application/json", body: '{"user":null}' });
      return;
    }
    if (url.pathname === "/api/csrf") {
      await route.fulfill({ contentType: "application/json", body: '{"csrfToken":"directory-test"}' });
      return;
    }
    if (url.pathname === "/public/paralegals") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: [publicProfile], total: 1, pages: 1, page: 1 }),
      });
      return;
    }
    const filePath = path.resolve(frontendRoot, `.${url.pathname}`);
    if (!filePath.startsWith(`${frontendRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    const extension = path.extname(filePath);
    const contentType = extension === ".html" ? "text/html" :
      extension === ".css" ? "text/css" :
        [".js", ".mjs"].includes(extension) ? "text/javascript" :
          extension === ".svg" ? "image/svg+xml" : "application/octet-stream";
    await route.fulfill({ contentType, body: fs.readFileSync(filePath) });
  });
  await page.goto("http://lpc.test/browse-paralegals.html", { waitUntil: "domcontentloaded" });
  await page.locator(".paralegal-card").waitFor();
  assert.equal(await page.locator(".paralegal-card").count(), 1);
  assert.equal(await page.locator(".paralegal-card h3").textContent(), "Alex Rivera");
  assert.equal(
    await page.locator(".paralegal-card h3 a").getAttribute("href"),
    "/profile-paralegal.html?paralegalId=6a530880c2e01cd42b2d122d"
  );
  await page.locator(".paralegal-card h3 a").click();
  assert.equal(await page.locator("#authBlocker").getAttribute("aria-hidden"), "false");
  await page.close();
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.LPC_BROWSER_EXECUTABLE ? { executablePath: process.env.LPC_BROWSER_EXECUTABLE } : {}),
  });
  try {
    await verifyHomepage(browser);
    await verifyUtilityHeader(browser);
    await verifyPublicDirectory(browser);
  } finally {
    await browser.close();
  }
  console.log("[browser-contract] Public session navigation, directory cards, and CSRF-protected logout passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
