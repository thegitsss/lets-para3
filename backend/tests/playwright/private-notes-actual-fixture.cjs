'use strict';
// Existing Matter/weekly-note scenarios on the actual local app. This fixture
// adds observation and record exports; it does not alter their actions or API.
const { test: base, expect } = require('./support-session-fixture');
const path = require('node:path');
const fs = require('node:fs/promises');
const start = require('../helpers/financialLifecycleBrowserServer');
const { writeStorageStateOwnerOnly, removeStorageState } = require('./auth-state');

function observeContexts(browser) {
  const originalCreate = browser.newContext;
  const records = [];
  let active = null;
  browser.newContext = async function (...args) {
    const context = await originalCreate.apply(this, args);
    const record = { id: records.length + 1, title: active?.title || null, engine: active?.engine || null,
      pagesCreated: 0, pageErrors: [], closeInvocations: 0, closeAwaitedComplete: false };
    records.push(record);
    const seen = new Set();
    const observe = page => {
      if (seen.has(page)) return;
      seen.add(page); record.pagesCreated += 1;
      page.on('pageerror', error => record.pageErrors.push({ message: error.message, stack: error.stack, url: page.url() }));
    };
    context.pages().forEach(observe);
    context.on('page', observe);
    const originalClose = context.close;
    context.close = async function (...closeArgs) {
      record.closeInvocations += 1;
      await originalClose.apply(this, closeArgs);
      record.closeAwaitedComplete = true;
    };
    Object.defineProperty(context, '__lpcPrivateNoteObservation', { value: record });
    return context;
  };
  return {
    begin(info) { active = { title: info.title, engine: info.project.name }; return active; },
    assign(context, info) {
      const record = context.__lpcPrivateNoteObservation;
      if (!record) throw new Error('Actual test context was not observed from creation.');
      record.title = info.title; record.engine = info.engine;
    },
    end(info) { active = null; return records.filter(record => record.title === info.title && record.engine === info.engine); },
    records,
    restore() { browser.newContext = originalCreate; },
  };
}

async function savedRecords(actorId) {
  const Case = require('../../models/Case');
  const WeeklyNote = require('../../models/WeeklyNote');
  const User = require('../../models/User');
  const AuthSession = require('../../models/AuthSession');
  const AuditLog = require('../../models/AuditLog');
  const owner = new User.base.Types.ObjectId(actorId);
  const [cases, weeks, user, sessions, audits] = await Promise.all([
    Case.collection.find({ $or: [{ attorney: owner }, { attorneyId: owner }] }).sort({ _id: 1 }).toArray(),
    WeeklyNote.collection.find({ userId: owner }).sort({ _id: 1 }).toArray(),
    User.findById(owner).select('_id role status disabled deletedAt authVersion __v').lean(),
    AuthSession.find({ userId: owner }).select('_id userId revokedAt expiresAt createdAt updatedAt __v').sort({ _id: 1 }).lean(),
    AuditLog.collection.find({}).sort({ _id: 1 }).toArray(),
  ]);
  return { cases, weeks, user, sessions, audits };
}

const test = base.extend({
  privateNoteObservation: [async ({ foundationServer }, use, info) => {
    const identity = foundationServer.observer.begin(info);
    const before = await savedRecords(foundationServer.actorId);
    try { await use(identity); } finally {
      const contexts = foundationServer.observer.end(identity);
      const observation = { ...identity, contexts, contextsCreated: contexts.length,
        contextsClosed: contexts.filter(record => record.closeAwaitedComplete).length,
        capturedThroughNormalClose: contexts.length > 0 && contexts.every(record => record.closeAwaitedComplete),
        pageErrors: contexts.flatMap(record => record.pageErrors) };
      await fs.writeFile(info.outputPath('private-note-ui-observation.json'), JSON.stringify(observation, null, 2));
      const after = await savedRecords(foundationServer.actorId);
      await fs.writeFile(info.outputPath('private-note-actual-records.json'), JSON.stringify({ ...identity,
        actorId: foundationServer.actorId, before, after, scope: 'Actual selected owner Case/WeeklyNote, sanitized User/AuthSession and full local AuditLog; fixture observations, original assertions remain authoritative.' }, null, 2));
      expect(observation.capturedThroughNormalClose).toBe(true);
      expect(observation.pageErrors).toEqual([]);
    }
  }, { auto: true }],
  // Close the real inherited context before the enclosing observation writes.
  // Original secondary pages use this same context and are included above.
  context: async ({ context, privateNoteObservation, foundationServer }, use) => {
    foundationServer.observer.assign(context, privateNoteObservation);
    await context.route('**/*', route => new URL(route.request().url()).origin === foundationServer.origin ? route.continue() : route.abort('blockedbyclient'));
    try { await use(context); } finally {
      try {
        const page = context.pages()[0];
        if (page && !page.isClosed()) {
          if (page.url().includes('/dashboard-attorney.html')) await expect(page.locator('#attorneyTourModal')).toBeHidden();
          await page.screenshot({ path: test.info().outputPath('private-notes-rendered.png') });
        }
      } finally { await context.close(); }
    }
  },
  foundationServer: [async ({ browser }, use, info) => {
    const observer = observeContexts(browser);
    const server = await start({ includeAdminSupport: true });
    info.project.use.baseURL = server.origin;
    const actor = await server.createUser('attorney');
    const User = require('../../models/User');
    await User.updateOne({ _id: actor.id }, { $set: { profileImage: '', 'onboarding.attorneyTourCompleted': true } });
    const returningActor = await User.findById(actor.id).select('onboarding').lean();
    expect(returningActor.onboarding.attorneyTourCompleted).toBe(true);
    const storageState = path.join(__dirname, '.auth/support-attorney.json');
    const context = await browser.newContext({ baseURL: server.origin });
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
    try {
      const page = await context.newPage();
      await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
      const user = await User.findById(actor.id).lean();
      await page.locator('#email').fill(user.email);
      await page.locator('#password').fill('Private synthetic lifecycle password!');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard-attorney\.html(?:[?#].*)?$/);
      const me = await context.request.get('/api/auth/me');
      expect(me.status()).toBe(200);
      const verified = (await me.json()).user;
      expect(String(verified.id || verified._id)).toBe(actor.id);
      await writeStorageStateOwnerOnly(context, storageState);
      await context.close();
      process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_EMAIL = user.email;
      process.env.CONTROL_ROOM_E2E_SUPPORT_ATTORNEY_PASSWORD = 'Private synthetic lifecycle password!';
      await use({ origin: server.origin, storageState, actorId: actor.id, observer });
    } finally {
      try {
        await context.close();
        await fs.writeFile(path.join(process.env.LPC_PRIVATE_NOTES_BROWSER_OUTPUT, `actual-app-${info.project.name}-worker${info.workerIndex}.json`),
          JSON.stringify({ actorId: actor.id, role: 'attorney', managedSignIn: true, ...server.evidence(), contexts: observer.records,
            contextsCreated: observer.records.length, contextsClosed: observer.records.filter(record => record.closeAwaitedComplete).length,
            capturedThroughNormalClose: observer.records.every(record => record.closeAwaitedComplete),
            pageErrors: observer.records.flatMap(record => record.pageErrors) }, null, 2));
        expect(observer.records.every(record => record.closeAwaitedComplete)).toBe(true);
        expect(observer.records.flatMap(record => record.pageErrors)).toEqual([]);
      } finally {
        observer.restore();
        removeStorageState(storageState);
        await server.close();
      }
    }
  }, { scope: 'worker', timeout: 180000 }],
  baseURL: async ({ foundationServer }, use) => use(foundationServer.origin),
  storageState: async ({ foundationServer }, use) => use(foundationServer.storageState),
});
module.exports = { test, expect };
