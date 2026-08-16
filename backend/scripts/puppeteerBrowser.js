"use strict";

const {
  launchPuppeteer,
  resolvePuppeteerExecutablePath,
} = require("../utils/puppeteerBrowser");

async function clickVisible(page, selector) {
  await page.waitForSelector(selector, { visible: true });
  const disabled = await page.$eval(
    selector,
    (element) => Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true"
  );
  if (disabled) {
    throw new Error(`Cannot click disabled control: ${selector}`);
  }
  await page.click(selector);
}

module.exports = {
  clickVisible,
  launchPuppeteer,
  resolvePuppeteerExecutablePath,
};
