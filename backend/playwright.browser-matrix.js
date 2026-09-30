const { devices } = require("playwright/test");

const CURRENT_BROWSER_PROJECTS = Object.freeze([
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  // CDP-only fixtures have an explicit filename so broader suite configs keep
  // the same capability boundary as their dedicated component config.
  { name: "firefox", testIgnore: "**/*.chromium.spec.js", use: { ...devices["Desktop Firefox"] } },
  { name: "webkit", testIgnore: "**/*.chromium.spec.js", use: { ...devices["Desktop Safari"] } },
]);

const SUPPORTED_VIEWPORTS = Object.freeze([
  { name: "compact-mobile", width: 360, height: 800 },
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "compact-desktop", width: 1024, height: 768 },
  { name: "desktop", width: 1280, height: 800 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "audit-desktop", width: 1440, height: 900 },
  { name: "wide-desktop", width: 1920, height: 1080 },
]);

module.exports = {
  CURRENT_BROWSER_PROJECTS,
  SUPPORTED_VIEWPORTS,
};
