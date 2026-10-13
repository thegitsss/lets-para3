"use strict";

const { test: base, expect } = require("playwright/test");
const { ensureSavedSupportSession } = require("./saved-support-session");

const test = base.extend({
  _savedSupportSession: [async ({ browser, baseURL, storageState }, use, testInfo) => {
    // Automatic fixtures run before the page/context fixtures and test hooks.
    // Reauthenticate only between tests when the saved cookie approaches expiry;
    // production session limits and each test's account-loss behavior stay real.
    // Existing cases can declare a four-minute deadline inside their body, after
    // this fixture runs, so include that maximum plus a one-minute margin.
    const renewed = await ensureSavedSupportSession({
      browser, baseURL, storageState, minimumRemainingMs: Math.max(testInfo.timeout, 240_000) + 60_000,
    });
    if (renewed) console.log("Saved synthetic support session signed in again before the next test.");
    await use();
  }, { auto: true }],
});

module.exports = { test, expect };
