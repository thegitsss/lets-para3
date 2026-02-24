const { join } = require("path");

/**
 * Puppeteer config for Render: keep Chromium cache inside the project so it
 * persists from build to runtime.
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
