const path = require('node:path');
const {test,expect} = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const start = require(path.resolve(__dirname,'../../../../docs/audits/completion-2026-09-09/closure/paralegal/backend-browser-server.cjs'));
test.use({ baseURL: 'http://localhost:5305', storageState: { cookies: [], origins: [] } });
let server, owner;
test.beforeAll(async()=>{test.setTimeout(120000);server=await start({port:5305});});
test.afterAll(async()=>{await server?.close();});
test.beforeEach(async({context})=>{owner=await server.createUser();await context.addCookies([owner.cookie]);});
test.afterEach(()=>server?.release(owner?.id));
async function visitWorkspace(page, url, role = 'paralegal') {
  // Firefox can leave goto pending after this fixture's document has rendered.
  // Navigate natively and require the actual destination and ready route before
  // the test creates its history entry or starts an account-closure action.
  const target = new URL(url, server.origin);
  await page.evaluate(destination => { setTimeout(() => location.assign(destination), 0); }, target.href);
  await expect.poll(() => { const current = new URL(page.url()); return current.origin + current.pathname; }).toBe(target.origin + target.pathname);
  const outlet = page.locator(role === 'paralegal' ? '[data-v2-route-outlet]' : '[data-av2-outlet]');
  await expect(outlet).toBeVisible();
  await expect(outlet).not.toHaveAttribute('aria-busy', 'true');
}
async function open(page){await visitWorkspace(page,'/paralegal-v2.html#/settings?section=closure');await expect(page.locator('#v2-settings-closure')).toBeVisible();await expect(page.locator('[data-closure-review]')).toHaveAttribute('aria-busy','false');}
async function confirm(page){await page.getByRole('button',{name:'Deactivate account',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Deactivate account',exact:true}).click();}
const receipts=()=>server.receipts().filter(item=>item.ownerId===owner.id);
const stored=page=>page.evaluate(()=>sessionStorage.getItem('lpc_account_closure_result'));
test('a lost actual committed response uses the bounded status read after authentication ends',async({page})=>{await open(page);server.dropNextResponse(owner.id);await confirm(page);await expect(page.getByRole('heading',{name:'Account deactivated',exact:true})).toBeVisible();expect(receipts()).toHaveLength(1);expect((await server.inspectUser(owner.id)).disabled).toBe(true);});
test('failed actual outcome confirmation retains proof through refresh until deliberate check',async({page})=>{await open(page);let unavailable=true;await page.route('**/api/account/deactivate-result',route=>unavailable?route.fulfill({status:503,contentType:'application/json',body:'{}'}):route.continue());server.dropNextResponse(owner.id);await confirm(page);await expect(page.getByRole('heading',{name:'Account status could not be checked',exact:true})).toBeVisible();expect(receipts()).toHaveLength(1);expect(await stored(page)).toBeTruthy();await page.reload();await expect(page.getByRole('button',{name:'Check again',exact:true})).toBeVisible();unavailable=false;await page.getByRole('button',{name:'Check again',exact:true}).click();await expect(page.getByRole('heading',{name:'Account deactivated',exact:true})).toBeVisible();expect(receipts()).toHaveLength(1);expect(await stored(page)).toBeNull();});
test('actual cookie replacement after preflight cannot deactivate either account or erase new credentials',async({page,context})=>{await open(page);const replacement=await server.createUser();await page.route('**/api/csrf',async route=>{await context.addCookies([replacement.cookie]);await route.continue();});await confirm(page);await expect(page.getByRole('heading',{name:'Session changed',exact:true})).toBeVisible();expect((await server.inspectUser(owner.id)).disabled).toBe(false);expect((await server.inspectUser(replacement.id)).disabled).toBe(false);expect((await context.cookies(server.origin)).find(cookie=>cookie.name==='token').value).toBe(replacement.cookie.value);expect(await stored(page)).toBeNull();expect(receipts()).toHaveLength(0);});
test('actual delayed closure response cannot erase a newly signed-in account cookie',async({page,context})=>{await open(page);const replacement=await server.createUser();await page.route('**/api/account/deactivate',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);expect(response.headers()['set-cookie']).toBeUndefined();await context.addCookies([replacement.cookie]);await route.fulfill({response});});await confirm(page);await expect(page.getByRole('heading',{name:'Session changed',exact:true})).toBeVisible();expect((await context.cookies(server.origin)).find(cookie=>cookie.name==='token').value).toBe(replacement.cookie.value);expect((await server.inspectUser(owner.id)).disabled).toBe(true);expect((await server.inspectUser(replacement.id)).disabled).toBe(false);});
test('actual in-flight request can remain active on reload and later confirms without another DELETE', async ({ page }) => {
  const deletes = [];
  page.on('request', request => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/account/deactivate') deletes.push(request.url());
  });
  const [vitals] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/assets/vendor/web-vitals-6.1.1.js'),
    open(page),
  ]);
  expect(vitals.status()).toBe(200);
  expect(vitals.headers()['content-type']).toContain('application/javascript');
  server.holdNext(owner.id); await confirm(page);
  await expect.poll(() => server.held(owner.id)).toBe(true);
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(() => { window.setTimeout(() => location.reload(), 0); });
  await expect(page).toHaveURL(/account-closure.html$/);
  await expect(page.getByRole('heading', { name: 'Your account is currently active', exact: true })).toBeVisible();
  expect(await stored(page)).toBeTruthy();
  server.release(owner.id);
  await expect.poll(async () => (await server.inspectUser(owner.id)).disabled).toBe(true);
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account deactivated', exact: true })).toBeVisible();
  // Reload can abandon the HTTP response after the durable closure commits.
  // Verify the single request and commit, independently of response delivery.
  expect(deletes).toHaveLength(1);
  expect(await server.audits(owner.id)).toHaveLength(1);
});
test('same-owner route interruption immediately hands off a pending closure without exposing another protected pane',async({page})=>{await open(page);server.holdNext(owner.id);await confirm(page);await expect.poll(()=>server.held(owner.id)).toBe(true);await page.evaluate(()=>{location.hash='#/home';});await expect(page).toHaveURL(/account-closure.html$/);await expect(page.getByRole('heading',{name:'Your account is currently active',exact:true})).toBeVisible();await expect(page.locator('[data-v2-route-outlet]')).toHaveCount(0);server.release(owner.id);await expect.poll(async()=>(await server.inspectUser(owner.id)).disabled).toBe(true);await page.getByRole('button',{name:'Check again',exact:true}).click();await expect(page.getByRole('heading',{name:'Account deactivated',exact:true})).toBeVisible();expect(receipts()).toHaveLength(1);});
for(const phase of ['auth','csrf'])test(`actual ${phase} preflight failure sends no closure request and keeps explicit retry`,async({page})=>{await open(page);await page.getByRole('button',{name:'Deactivate account',exact:true}).click();await page.route(phase==='auth'?'**/api/auth/me':'**/api/csrf',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));await page.getByRole('dialog').getByRole('button',{name:'Deactivate account',exact:true}).click();await expect(page).toHaveURL(/paralegal-v2.html/);await expect(page.getByText('Account closure could not start. Refresh the review and try again.',{exact:true})).toBeVisible();expect((await server.inspectUser(owner.id)).disabled).toBe(false);expect(receipts()).toHaveLength(0);expect(await stored(page)).toBeNull();});
test('actual pending closure survives an unverified storage signal without re-enabling protected UI',async({page})=>{await open(page);server.holdNext(owner.id);await confirm(page);await expect.poll(()=>server.held(owner.id)).toBe(true);await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'lpc_user',newValue:null})));await expect(page.getByRole('heading',{name:'Your account is currently active',exact:true})).toBeVisible();expect(await stored(page)).toBeTruthy();await expect(page.locator('[data-v2-route-outlet]')).toHaveCount(0);server.release(owner.id);await expect.poll(async()=>(await server.inspectUser(owner.id)).disabled).toBe(true);await page.getByRole('button',{name:'Check again',exact:true}).click();await expect(page.getByRole('heading',{name:'Account deactivated',exact:true})).toBeVisible();expect(receipts()).toHaveLength(1);});
test('Back after a settled state cannot resurrect cleared continuation or a protected account',async({page})=>{
 await visitWorkspace(page,'/paralegal-v2.html#/home');await page.evaluate(()=>{location.hash='#/settings?section=closure';});await expect(page.getByRole('button',{name:'Deactivate account',exact:true})).toBeEnabled();await confirm(page);await expect(page.getByRole('heading',{name:'Account deactivated',exact:true})).toBeVisible();expect(await stored(page)).toBeNull();
 await page.evaluate(()=>{setTimeout(()=>history.back(),0);});await expect(page).toHaveURL(/login.html/);expect(await stored(page)).toBeNull();await expect(page.locator('[data-v2-route-outlet]')).toHaveCount(0);expect(receipts()).toHaveLength(1);
});
test('a new same-owner credential requires a new review and retains the new session',async({page,context})=>{await open(page);const replacement=await server.cookieFor(owner.id);await page.route('**/api/csrf',async route=>{await context.addCookies([replacement]);await route.continue();});await confirm(page);await expect(page.getByRole('heading',{name:'Session changed',exact:true})).toBeVisible();expect((await server.inspectUser(owner.id)).disabled).toBe(false);expect((await context.cookies(server.origin)).find(cookie=>cookie.name==='token').value).toBe(replacement.value);expect(await stored(page)).toBeNull();expect(receipts()).toHaveLength(0);});

for(const role of ['paralegal','attorney'])test(`${role} browser Back during an actual held closure conceals the workspace before status checking`,async({page,context})=>{
 if(role==='attorney'){owner=await server.createUser({role});await context.addCookies([owner.cookie]);}
 await visitWorkspace(page,`/${role}-v2.html#/home`,role);await page.evaluate(({role})=>{location.hash=role==='paralegal'?'#/settings?section=closure':'#/settings?tab=closure';},{role});await expect(page.getByRole('button',{name:'Deactivate account',exact:true})).toBeEnabled();
 server.holdNext(owner.id);await confirm(page);await expect.poll(()=>server.held(owner.id)).toBe(true);await page.evaluate(()=>{setTimeout(()=>history.back(),0);});
 await expect(page).toHaveURL(/account-closure.html$/);await expect(page.getByRole('heading',{name:'Your account is currently active',exact:true})).toBeVisible();await expect(page.locator('[data-v2-route-outlet], [data-av2-shell]')).toHaveCount(0);expect(await stored(page)).toBeTruthy();
 server.release(owner.id);await expect.poll(async()=>(await server.inspectUser(owner.id)).disabled).toBe(true);await page.getByRole('button',{name:'Check again',exact:true}).click();await expect(page.getByRole('heading',{name:'Account deactivated',exact:true})).toBeVisible();expect(receipts()).toHaveLength(1);
});
for(const role of ['paralegal','attorney'])test(`${role} actual committed closure with unavailable handoff storage exposes Check and never resends DELETE`,async({page,context})=>{
 if(role==='attorney'){owner=await server.createUser({role});await context.addCookies([owner.cookie]);}
 await visitWorkspace(page,`/${role}-v2.html#/${role==='paralegal'?'settings?section=closure':'settings?tab=closure'}`,role);await expect(page.getByRole('button',{name:'Deactivate account',exact:true})).toBeEnabled();
 server.holdNext(owner.id);server.dropNextResponse(owner.id);await confirm(page);await expect.poll(()=>server.held(owner.id)).toBe(true);
 await page.evaluate(()=>{window.__closureSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error('Synthetic late unavailable storage');};});server.release(owner.id);
 await expect(page.getByText('The account check could not be opened. Keep this page open and try again.',{exact:true})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);const check=page.getByRole('button',{name:'Check account status',exact:true});await expect(check).toBeFocused();await expect(check).toBeInViewport();expect(receipts()).toHaveLength(1);
 await page.evaluate(()=>{Storage.prototype.setItem=window.__closureSetItem;});await check.click();await expect(page.getByRole('heading',{name:'Account deactivated',exact:true})).toBeVisible();expect(receipts()).toHaveLength(1);expect(await stored(page)).toBeNull();
});
test('actual light closure review is clear at desktop and mobile with usable keyboard confirmation',async({page},info)=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));await open(page);const card=page.locator('.pv2-closure');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});await card.scrollIntoViewIfNeeded();await expect(page.getByRole('button',{name:'Deactivate account',exact:true})).toBeEnabled();expect(await card.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);expect((await new AxeBuilder({page}).include('.pv2-closure').analyze()).violations).toEqual([]);await page.screenshot({path:info.outputPath(`closure-light-${width}.png`)});
  await page.getByRole('button',{name:'Deactivate account',exact:true}).click();await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();expect((await new AxeBuilder({page}).include('dialog').analyze()).violations).toEqual([]);await page.screenshot({path:info.outputPath(`closure-confirm-light-${width}.png`)});await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Deactivate account',exact:true})).toBeFocused();await expect(page.getByRole('button',{name:'Deactivate account',exact:true})).toBeInViewport();
 }
 expect(receipts()).toHaveLength(0);expect((await server.inspectUser(owner.id)).disabled).toBe(false);expect(errors).toEqual([]);
});
