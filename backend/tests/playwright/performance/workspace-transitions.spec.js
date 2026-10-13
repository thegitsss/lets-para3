const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start(); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

for (const role of ['attorney', 'paralegal']) test(`${role}: repeated real workspace transitions retain one shell and dispose Matter streams`, async ({ browser }, info) => {
  const actors = { attorney: await server.createUser('attorney'), paralegal: await server.createUser('paralegal') };
  const mongoose = require('mongoose'), Case = require('../../../models/Case');
  expect(mongoose.connection.name).toBe('financial_lifecycle_browser');
  // This measurement uses the initials fallback. The common lifecycle fixture's
  // external synthetic avatar has no stored bytes and deliberately returns 404.
  await require('../../../models/User').updateMany({ _id: { $in: Object.values(actors).map(actor => actor.id) } }, { $set: { profileImage: '' } });
  const matters = [];
  for (const title of ['River Street filing', 'Elm Street exhibits']) matters.push(await Case.create({
    title, details: 'Organize the supporting exhibits and prepare a filing index for attorney review.',
    attorney: actors.attorney.id, attorneyId: actors.attorney.id,
    paralegal: actors.paralegal.id, paralegalId: actors.paralegal.id,
    status: 'in progress', archived: false, paymentReleased: false, payoutStatus: 'not_started',
    totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 40000,
    feeParalegalPct: 18, feeAttorneyPct: 22, currency: 'usd', stripeMode: 'test',
    escrowStatus: 'funded', fundingIntegrityStatus: 'verified',
    escrowIntentId: `pi_scale_${matters.length}`, paymentIntentId: `pi_scale_${matters.length}`, hiredAt: new Date(),
  }));
  const before = JSON.stringify(await Case.find({ _id: { $in: matters.map(m => m._id) } }).sort({ _id: 1 }).lean());
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000);
  await context.addCookies([actors[role].cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  await context.addInitScript(() => {
    const native = window.EventSource, active = new Map(); let sequence = 0;
    window.EventSource = class ObservedEventSource extends native {
      constructor(url, options) { super(url, options); this.observationId = ++sequence; active.set(this.observationId, new URL(url, location.href).pathname); }
      close() { active.delete(this.observationId); return super.close(); }
    };
    const timers = new Map();
    const nativeTimeout = window.setTimeout.bind(window), nativeInterval = window.setInterval.bind(window);
    const clearTimeout = window.clearTimeout.bind(window), clearInterval = window.clearInterval.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      if (typeof callback !== 'function') return nativeTimeout(callback, delay, ...args);
      const id = nativeTimeout((...values) => { timers.delete(id); callback.apply(window, values); }, delay, ...args);
      timers.set(id, { kind: 'timeout', delay: Number(delay) || 0 }); return id;
    };
    window.setInterval = (callback, delay, ...args) => {
      const id = nativeInterval(callback, delay, ...args); timers.set(id, { kind: 'interval', delay: Number(delay) || 0 }); return id;
    };
    window.clearTimeout = id => { timers.delete(id); clearTimeout(id); };
    window.clearInterval = id => { timers.delete(id); clearInterval(id); };
    const entries = { lcp: [], shifts: [], longTasks: [], events: [] };
    for (const [type, key] of [['largest-contentful-paint', 'lcp'], ['layout-shift', 'shifts'], ['longtask', 'longTasks'], ['event', 'events']]) {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
      new PerformanceObserver(list => { for (const entry of list.getEntries()) entries[key].push(JSON.parse(JSON.stringify(entry.toJSON()))); }).observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) });
    }
    // Retain only primitive stream metadata; keeping stream objects here would itself leak.
    window.__lpcScaleObservation = { documentId: crypto.randomUUID(), active, entries, timers };
  });
  const page = await context.newPage(), errors = [], responses = [], failed = [], samples = [];
  const activeRequests = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (new URL(req.url()).origin === server.origin && !/\/stream(?:\?|$)/.test(req.url())) activeRequests.add(req); });
  page.on('requestfinished', req => activeRequests.delete(req));
  page.on('requestfailed', req => { activeRequests.delete(req); if (new URL(req.url()).origin === server.origin) failed.push({ path: new URL(req.url()).pathname, error: req.failure()?.errorText }); });
  page.on('response', res => { if (new URL(res.url()).origin === server.origin) responses.push({ path: new URL(res.url()).pathname, status: res.status(), type: res.request().resourceType() }); });
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable'); await cdp.send('Network.enable');
  const attorney = role === 'attorney';
  const outlet = page.locator(attorney ? '[data-av2-outlet]' : '[data-v2-route-outlet]');
  const routeAttribute = attorney ? 'data-attorney-route' : 'data-lpc-v2-committed-route';
  const shellSelector = attorney ? '[data-av2-shell]' : '[data-v2-persistent="sidebar"]';
  const pathFor = (index, tab) => attorney ? `/matters/${matters[index].id}/${tab}` : `/matter/${matters[index].id}?tab=${tab}`;
  async function settled(name) {
    await expect(page.locator('html')).toHaveAttribute(routeAttribute, name);
    if (attorney) await expect(outlet).toHaveAttribute('aria-busy', 'false');
    else await expect(outlet).not.toHaveAttribute('aria-busy', 'true');
    if (!attorney && name === 'home') await expect(outlet.locator('[data-v2-home]')).toHaveAttribute('data-home-loading', 'false');
    await expect.poll(() => activeRequests.size).toBe(0);
  }
  async function measure(label, elapsedMs = null) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const observation = await page.evaluate(selector => {
      const state = window.__lpcScaleObservation;
      const snapshot = {
      documentId: window.__lpcScaleObservation.documentId,
      shellRetained: window.__lpcScaleShell === document.querySelector(selector),
      streams: [...window.__lpcScaleObservation.active.values()],
      timers: [...state.timers.values()],
      entries: Object.fromEntries(Object.entries(state.entries).map(([key, values]) => [key, values.splice(0)])),
      resources: window.performance.getEntriesByType('resource').map(e => ({ path: new URL(e.name).pathname, initiator: e.initiatorType, duration: e.duration, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize })),
      };
      // Measurement buffers must not retain departed DOM or grow browser heap.
      window.performance.clearResourceTimings();
      return snapshot;
    }, shellSelector);
    await cdp.send('HeapProfiler.collectGarbage');
    const dom = await cdp.send('Memory.getDOMCounters');
    const performance = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(row => [row.name, row.value]));
    expect(observation.shellRetained).toBe(true);
    expect(new Set(observation.streams).size).toBe(observation.streams.length);
    samples.push({ label, elapsedMs, dom, performance, responseCount: responses.length, ...observation });
  }
  try {
    await page.goto(`${server.origin}/${role}-v2.html#/home`); await settled('home');
    await page.evaluate(selector => { window.__lpcScaleShell = document.querySelector(selector); }, shellSelector);
    await measure('initial home');
    await page.screenshot({ path: info.outputPath(`${role}-initial-home.png`) });
    for (let cycle = 1; cycle <= 3; cycle++) {
      if (cycle === 3) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 93750 });
      const routes = [
        [attorney ? '/matters' : '/home?view=work', attorney ? 'matters' : 'home'],
        [pathFor(0, attorney ? 'overview' : 'work'), attorney ? 'workspace' : 'matter', matters[0].title],
        ['/home', 'home'],
        [attorney ? '/matters' : '/home?view=work', attorney ? 'matters' : 'home'],
        [pathFor(1, attorney ? 'overview' : 'work'), attorney ? 'workspace' : 'matter', matters[1].title],
        [pathFor(1, 'messages'), attorney ? 'workspace' : 'matter', matters[1].title],
        ['/settings', 'settings'],
        ['/home', 'home'],
      ];
      for (const [hash, name, title] of routes) {
        const begin = Date.now();
        if (title && !hash.includes('messages')) {
          const index = matters.findIndex(matter => matter.title === title);
          if (attorney) await page.locator(`[data-av2-matter="${matters[index].id}"]`).getByRole('link', { name: title, exact: true }).click();
          else {
            await outlet.locator(`button[data-home-matter-id="${matters[index].id}"]:visible`).click();
            await outlet.getByRole('link', { name: 'Open full workspace', exact: true }).click();
          }
        } else if (hash.includes('messages')) {
          await outlet.getByRole('link', { name: 'Messages', exact: true }).click();
          await expect(outlet.getByRole('link', { name: 'Messages', exact: true })).toHaveAttribute('aria-current', 'page');
        } else await page.locator(`a[href="${role}-v2.html#${hash}"]:visible, a[href="#${hash}"]:visible`).first().click();
        await settled(name); if (title) await expect(outlet).toContainText(title);
        await measure(`cycle ${cycle}: ${hash}`, Date.now() - begin);
        if (name === 'home') expect(samples.at(-1).streams.filter(path => /^\/api\/cases\/[a-f\d]{24}\/stream$/.test(path))).toEqual([]);
      }
    }
    expect(new Set(samples.map(s => s.documentId)).size).toBe(1);
    expect(errors).toEqual([]);
    expect(responses.filter(row => row.status >= 400)).toEqual([]);
    expect(JSON.stringify(await Case.find({ _id: { $in: matters.map(m => m._id) } }).sort({ _id: 1 }).lean())).toBe(before);
    await page.screenshot({ path: info.outputPath(`${role}-after-24-transitions.png`) });
  } finally {
    const entries = await page.evaluate(() => window.__lpcScaleObservation?.entries || null).catch(() => null);
    await fs.writeFile(info.outputPath('workspace-performance.json'), JSON.stringify({ role, samples, entries, errors, failed, responses, serverRequests: server.evidence().requests, limits: ['Chromium local lab, synthetic accounts and external providers.', 'Raw timing/heap/listener measurements are not field INP or long-term device acceptance.', 'Cycle 3 uses 150ms latency, 200000B/s down and 93750B/s up; this is a scenario, not a new launch budget.'] }, null, 2));
    await cdp.detach(); await context.close();
  }
});
