const { expect } = require('playwright/test');

// Initial secondary-window entry only. Firefox can leave goto's protocol wait
// pending even after its document has responded and the workspace has rendered.
// Observe the real response/lifecycle and retain each caller's app-ready checks.
async function enterSecondaryDocument(page, target, { waitUntil = 'domcontentloaded' } = {}) {
  expect(page.url()).toBe('about:blank');
  expect(['commit', 'domcontentloaded', 'load']).toContain(waitUntil);
  const destination = new URL(target);
  const documentUrl = new URL(destination);
  documentUrl.hash = '';
  await page.addInitScript(() => {
    const ready = window.__lpcSecondaryDocumentReady = { domcontentloaded: false, load: false };
    document.addEventListener('DOMContentLoaded', () => { ready.domcontentloaded = true; }, { once: true });
    window.addEventListener('load', () => { ready.load = true; }, { once: true });
  });
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().isNavigationRequest()
      && response.request().frame() === page.mainFrame() && response.url() === documentUrl.href, { timeout: 0 }),
    page.evaluate(url => { setTimeout(() => location.assign(url), 0); }, destination.href),
  ]);
  expect(response.status()).toBe(200);
  await expect.poll(() => page.url().split('#')[0], { timeout: 0 }).toBe(documentUrl.href);
  if (waitUntil !== 'commit') {
    await page.waitForFunction(event => window.__lpcSecondaryDocumentReady?.[event] === true, waitUntil, { timeout: 0 });
  }
}

module.exports = { enterSecondaryDocument };
