// Focused local regression for the reported Home remount/interaction glitches.
// Runs synthetic records through real frontend files; no backend or provider calls.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const { expect } = require('playwright/test');
const root = path.resolve(__dirname, '../../../..');
require.cache[require.resolve('../assistant-completion/shell-fixture')] = { exports: { test: null } };
const { install, fixtures, objectId } = require('./home-summaries-fixture');
const mime = { '.html':'text/html', '.js':'application/javascript', '.mjs':'application/javascript', '.css':'text/css', '.woff2':'font/woff2', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };

async function run(name, engine) {
  const browser = await engine.launch({ headless:true });
  try {
    const context = await browser.newContext({ baseURL:'http://127.0.0.1:59621', viewport:{ width:1440,height:960 } });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()), file = path.resolve(root, 'frontend', '.' + decodeURIComponent(url.pathname));
      if (url.origin !== 'http://127.0.0.1:59621' || !file.startsWith(root + '/frontend/')) return route.abort();
      try { await route.fulfill({ body:await fs.readFile(file), contentType:mime[path.extname(file)] || 'application/octet-stream' }); }
      catch { await route.fulfill({ status:404, body:'' }); }
    });
    const page = await context.newPage(), data = fixtures();
    const items = Array.from({ length:5 }, (_, i) => ({ id:objectId(i + 11), title:`Matter ${i + 1}`, label:'In Progress', practiceArea:'Litigation', actions:['files','payment','withdrawal'] }));
    data.home.counts = { active:5, applications:0, draft:0, archived:0 }; data.home.postedCount = 5;
    data.home.attention = { total:5,page:1,pages:1,pageSize:5,items };
    data.home.recent = { total:5,items };
    data.threads = { total:1,threads:[{ id:items[0].id,title:'Matter 1',unread:1,lastMessageSnippet:'Updated file index.' }] };
    data.unread = { count:1 }; data.summary = { items:[{ caseId:items[0].id,unread:1 }] };
    const result = await install(page,data);
    let user = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user);
    let authCalls = 0;
    await page.route('**/api/auth/me', async route => { authCalls++; await route.fulfill({ json:{ user } }); });
    await page.evaluate(() => {
      window.originalHome = document.querySelector('.av2-home');
      window.originalMessage = document.querySelector('[data-av2-region="messages"] .av2-summary-row');
      window.gateStates = [];
      new MutationObserver(() => window.gateStates.push(document.documentElement.dataset.attorneyState)).observe(document.documentElement, { attributes:true, attributeFilter:['data-attorney-state'] });
    });
    for (let i = 0; i < 3; i++) {
      const before = authCalls;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => authCalls).toBeGreaterThan(before);
      await page.waitForTimeout(100);
      await page.locator('.av2-nav[aria-label="Primary"] a[data-av2-route="home"]').click();
    }
    const before = authCalls;
    await page.evaluate(user => window.dispatchEvent(new StorageEvent('storage', { key:'lpc_user',newValue:JSON.stringify(user) })), user);
    await expect.poll(() => authCalls).toBeGreaterThan(before);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.originalHome === document.querySelector('.av2-home')), true, 'same-owner checks and repeated Home clicks must not remount');
    assert.equal(await page.evaluate(() => window.gateStates.includes('checking')), false, 'same-owner updates must not blank the shell');
    await page.evaluate(() => document.querySelector('[data-av2-region="messages"]').refreshFromNotice());
    assert.equal(await page.evaluate(() => window.originalMessage === document.querySelector('[data-av2-region="messages"] .av2-summary-row')), true, 'unchanged conversations preserve their DOM');
    data.threads.threads[0].lastMessageSnippet = 'A new reply arrived.';
    await page.evaluate(() => document.querySelector('[data-av2-region="messages"]').refreshFromNotice());
    await expect(page.locator('[data-av2-region="messages"]')).toContainText('A new reply arrived.');
    assert.equal(await page.locator('[data-av2-region="attention"] .av2-review-row').count(), 5, 'three actions on each of five Matters stay five rows');
    await expect(page.locator('.av2-home > header .av2-button')).toHaveCount(0);
    await expect(page.locator('.av2-create-trigger')).toHaveAttribute('href','attorney-v2.html#/matters/new');

    const geometry = () => page.evaluate(() => ['.av2-sidebar','.av2-header','.av2-home','.av2-home-grid','.av2-home-review','.av2-home-supporting'].map(selector => {
      const e = document.querySelector(selector), r = e.getBoundingClientRect(), s = getComputedStyle(e);
      return [selector,r.x,r.y,r.width,r.height,s.fontFamily,s.fontSize];
    }));
    await page.evaluate(() => document.fonts.ready);
    const light = await geometry();
    await page.evaluate(() => document.documentElement.classList.add('theme-dark'));
    assert.deepEqual(await geometry(), light, 'theme switches only colors');
    await page.evaluate(() => document.documentElement.classList.remove('theme-dark'));
    const plusBefore = await page.locator('.av2-create-trigger').boundingBox();
    await page.locator('[data-av2-open="search"]').hover();
    await page.waitForTimeout(200);
    assert.deepEqual(await page.locator('.av2-create-trigger').boundingBox(), plusBefore, 'search hover must not shift Create');
    await page.locator('[data-av2-open="search"]').click();
    await expect(page.locator('#av2-query')).toBeFocused();
    await expect(page.locator('[data-av2-open="search"]')).toBeVisible();
    await expect(page.locator('[data-av2-panel="search"]')).not.toContainText('Quick links');
    await page.locator('#av2-query').fill('Litigation');
    await expect(page.locator('[data-av2-search-results]')).toContainText('Litigation review');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-av2-panel="search"]')).toBeHidden();
    await page.locator('.av2-brand-menu > summary').click();
    await expect(page.locator('.av2-brand-menu')).toHaveAttribute('open','');
    await page.keyboard.press('Escape');
    await expect(page.locator('.av2-brand-menu')).not.toHaveAttribute('open','');
    for (const width of [390,320]) {
      await page.setViewportSize({ width,height:844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile header must fit');
      await page.locator('[data-av2-nav-toggle]').click();
      await expect(page.locator('#av2-navigation-dialog')).toBeVisible();
      await page.locator('[data-av2-navigation-close]').click();
    }
    for (const dark of [false,true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('theme-dark', value), dark);
      for (const width of [1440,390,320]) {
        await page.setViewportSize({width,height:960});
        const trigger = page.locator('[data-av2-open="search"]');
        await trigger.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#av2-query')).toBeFocused();
        await expect(trigger).toBeVisible();
        const panel = await page.locator('[data-av2-panel="search"]').boundingBox();
        assert.ok(panel.x >= 0 && panel.x + panel.width <= width, 'search fits viewport');
        await trigger.click();
        await expect(page.locator('[data-av2-panel="search"]')).toBeHidden();
        await trigger.click();
        await page.mouse.click(10,400);
        await expect(page.locator('[data-av2-panel="search"]')).toBeHidden();
        await trigger.click();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
        const toolbar = await page.locator('.av2-header-tools').evaluate(el => {
          const selectors = ['[data-av2-open="search"]','.av2-create-trigger','[data-av2-open="notifications"]','.av2-assistant-trigger'];
          return selectors.map(selector => { const r=el.querySelector(selector).getBoundingClientRect(); return {x:r.x,right:r.right}; });
        });
        for(let i=1;i<toolbar.length;i++) assert.ok(toolbar[i].x-toolbar[i-1].right < 17, 'toolbar controls stay adjacent');
      }
    }
    await page.setViewportSize({ width:1440,height:960 });
    user = { ...user,status:'pending' };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page).toHaveURL(/dashboard-attorney\.html/);
    assert.deepEqual(result.errors, [], 'no browser script errors');
    assert.deepEqual(result.writes, [], 'read-only checks must not submit work');
    console.log(`${name}: session stability, same-page navigation, live messages, bounded reviews, theme parity, search, menus, mobile, and access revocation passed`);
  } finally { await browser.close(); }
}
(async () => { await run('chromium',chromium); await run('webkit',webkit); })().catch(error => { console.error(error); process.exitCode = 1; });
