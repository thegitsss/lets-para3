const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');

let server;
test.beforeAll(async () => {
  test.setTimeout(240000);
  server = await start({ port: 0, includeAdminSupport: true });
});
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());

test('the registered Assistant Post a Matter action opens the native creation workspace on desktop and mobile without posting a Matter', async ({ browser }, info) => {
  const errors = [], observed = [], contexts = [];
  try {
    for (const width of [1440, 390]) {
      const user = await server.createUser('attorney', {}, true);
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      contexts.push(context);
      await context.addCookies([user.cookie]);
      await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => observed.push({ method: request.method(), path: new URL(request.url()).pathname, width }));
      // Only the paid AI response is replaced. Authentication, initial support
      // conversation, registry, drawer, navigation and creation UI are real.
      await page.route(/\/api\/support\/conversation\/[^/]+\/messages$/, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const conversationId = new URL(route.request().url()).pathname.split('/')[4];
        const { requestId, text } = route.request().postDataJSON();
        const createdAt = new Date().toISOString();
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
          ok: true,
          request: { id: requestId, action: 'send', state: 'succeeded' },
          conversation: { id: conversationId, status: 'open' },
          userMessage: { id: '64f000000000000000000101', conversationId, sender: 'user', text, createdAt, metadata: { kind: 'user_message' } },
          assistantMessage: {
            id: '64f000000000000000000102', conversationId, sender: 'assistant', text: 'Post a Matter.', createdAt,
            metadata: {
              kind: 'assistant_reply', provider: 'synthetic_local_navigation_fixture', grounded: true,
              primaryAsk: 'matter_creation_navigation', responseMode: 'DIRECT_ANSWER',
              actions: [{ commandCode: 'attorney.post_matter', type: 'navigate', label: 'Post a Matter', href: '/create-case.html' }],
              suggestedReplies: [], needsEscalation: false, escalation: null,
            },
          },
        }) });
      });
      await page.goto(`${server.origin}/attorney-v2.html#/home`);
      await expect(page.locator('html')).toHaveAttribute('data-attorney-state', 'ready');
      await page.getByRole('button', { name: /^Open (?:LPC )?Assistant$/ }).click();
      const drawer = page.locator('#supportDrawer');
      await expect(drawer.locator('[data-support-textarea]')).toBeEditable();
      await drawer.locator('[data-support-textarea]').fill('Where do I post a Matter?');
      await drawer.locator('[data-support-submit]').click();
      const action = drawer.locator('.support-message--assistant').last().getByRole('button', { name: 'Post a Matter', exact: true });
      await expect(action).toBeVisible();
      await page.screenshot({ path: info.outputPath(`assistant-post-matter-${width}.png`) });
      await action.click();
      // Native creation is a modal workspace. The router deliberately retains
      // the underlying route so closing creation returns to the same screen.
      const creation = page.getByRole('dialog', { name: 'New Matter', exact: true });
      await expect(creation).toBeVisible();
      await expect(creation.getByRole('region', { name: 'Create a Matter', exact: true })).toBeVisible();
      await expect(creation.getByRole('textbox', { name: 'Describe the work in your own words', exact: true })).toBeEditable();
      await expect(page).toHaveURL(`${server.origin}/attorney-v2.html#/home`);
      await expect(page.locator('html')).toHaveAttribute('data-attorney-state', 'ready');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`native-post-matter-${width}.png`) });
      await creation.getByRole('button', { name: 'Close Matter creation', exact: true }).click();
      await expect(creation).toBeHidden();
      await expect(page).toHaveURL(`${server.origin}/attorney-v2.html#/home`);
      await expect(page.getByRole('region', { name: 'Today', exact: true })).toBeVisible();
      const identityResponse = await context.request.get(`${server.origin}/api/auth/me`);
      expect(identityResponse.ok()).toBe(true);
      const identity = await identityResponse.json();
      expect(String(identity.user.id || identity.user._id)).toBe(String(user.id));
    }
    expect(errors).toEqual([]);
    expect(observed.filter(request => request.method === 'POST' && (/^\/api\/cases(?:\/|$)/.test(request.path) || /^\/api\/case-drafts\/[^/]+\/publish$/.test(request.path)))).toEqual([]);
  } finally {
    await fs.writeFile(info.outputPath('assistant-navigation-evidence.json'), JSON.stringify({
      errors, observed, serverRequests: server?.evidence().requests,
      scope: 'Actual local application navigation with only the AI answer substituted; this does not verify the AI provider or release.',
    }, null, 2));
    for (const context of contexts) await context.close();
  }
});
