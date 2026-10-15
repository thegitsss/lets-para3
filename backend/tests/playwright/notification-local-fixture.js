"use strict";

const { test: base, expect } = require("playwright/test");
const start = require("../helpers/financialLifecycleBrowserServer");

// Isolated focused runs use the real local application and current-session
// middleware. The notification cases retain their own explicit feed fixtures.
const test = base.extend({
  notificationLocalApp: [async ({}, use) => {
    const server = await start({ port: 0 });
    try { await use(server); }
    finally { await server.close(); }
  }, { scope: "worker", timeout: 240000 }],
  baseURL: async ({ notificationLocalApp }, use) => {
    await use(notificationLocalApp.origin);
  },
  storageState: async ({ notificationLocalApp }, use) => {
    await notificationLocalApp.reset();
    const user = await notificationLocalApp.createUser("attorney", {}, true);
    await use({ cookies: [user.cookie], origins: [] });
  },
  context: async ({ browser, baseURL, storageState }, use) => {
    const context = await browser.newContext({ baseURL, storageState });
    await context.route("**/*", route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort());
    try { await use(context); }
    finally { await context.close(); }
  },
});

module.exports = { test, expect };
