const { devices } = require("playwright/test");

const CURRENT_BROWSER_PROJECTS = Object.freeze([
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  { name: "webkit", use: { ...devices["Desktop Safari"] } },
]);

const SUPPORTED_VIEWPORTS = Object.freeze([
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "wide-desktop", width: 1920, height: 1080 },
]);

module.exports = {
  CURRENT_BROWSER_PROJECTS,
  SUPPORTED_VIEWPORTS,
};
