"use strict";

const fs = require("fs");
const path = require("path");

let puppeteerPromise = null;

async function loadPuppeteer() {
  if (!puppeteerPromise) {
    puppeteerPromise = import("puppeteer")
      .then((module) => module.default || module)
      .catch((error) => {
        puppeteerPromise = null;
        throw error;
      });
  }
  return puppeteerPromise;
}

function requireBrowserExecutable(candidate, source) {
  const executablePath = path.resolve(String(candidate || ""));
  let stat;
  try {
    stat = fs.statSync(executablePath);
  } catch {
    throw new Error(`${source} browser executable is unavailable: ${executablePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${source} browser executable is not a file: ${executablePath}`);
  }
  return executablePath;
}

async function resolvePuppeteerExecutablePath() {
  const configuredPath = String(process.env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  if (configuredPath) return requireBrowserExecutable(configuredPath, "Configured Puppeteer");

  let puppeteerResolutionError = null;
  try {
    const puppeteer = await loadPuppeteer();
    const puppeteerPath = await puppeteer.executablePath();
    if (puppeteerPath && fs.existsSync(puppeteerPath)) {
      return requireBrowserExecutable(puppeteerPath, "Puppeteer-managed");
    }
    puppeteerResolutionError = new Error("Puppeteer's managed browser is not installed.");
  } catch (error) {
    puppeteerResolutionError = error;
  }

  try {
    const playwrightPath = require("playwright").chromium.executablePath();
    return requireBrowserExecutable(playwrightPath, "Playwright-managed Chromium");
  } catch (error) {
    const puppeteerMessage = puppeteerResolutionError?.message || "unknown Puppeteer resolution failure";
    throw new Error(
      `No browser is available for Puppeteer. Puppeteer: ${puppeteerMessage}; Playwright: ${error.message}`
    );
  }
}

async function launchPuppeteer(options = {}) {
  const puppeteer = await loadPuppeteer();
  const executablePath = options.executablePath
    ? requireBrowserExecutable(options.executablePath, "Requested Puppeteer")
    : await resolvePuppeteerExecutablePath();
  const ciArgs = process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [];
  return puppeteer.launch({ ...options, args: [...ciArgs, ...(options.args || [])], executablePath });
}

module.exports = {
  launchPuppeteer,
  resolvePuppeteerExecutablePath,
};
