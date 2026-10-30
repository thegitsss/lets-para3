const { test, expect } = require('playwright/test');
const { randomUUID } = require('node:crypto');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server, pdf;
const password = 'A private signup gateway passphrase';
test.beforeAll(async () => {
  test.setTimeout(180000);
  server = await start({ port: 0, includeAdminSupport: true, includeAdminWorkspaces: true, includeSyntheticDownloads: true, includeSyntheticPersonalDownloads: true });
  pdf = require('node:fs').readFileSync(require('node:path').join(__dirname, '../paralegal-support/fixtures/paralegal-valid.pdf'));
});
test.beforeEach(async ({ context, page }) => {
  await server.reset();
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  page.on('pageerror', error => { throw error; });
});
test.afterAll(async () => server?.close());
async function basics(page, role = 'paralegal', email = `gateway-${randomUUID()}@example.com`) {
  await page.goto(`${server.origin}/signup.html?role=${role}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#fullName').fill('Morgan Applicant'); await page.locator('#email').fill(email);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.querySelector('#signupPolicyStatus').textContent.includes('Loading'));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const actionTop = () => page.locator('#nextStepBtn').evaluate(el => el.getBoundingClientRect().top + scrollY + document.querySelector('.signup-stage').scrollTop);
  const buttonBefore = await actionTop();
  await page.locator('#password').fill(password);
  expect(await actionTop()).toBe(buttonBefore);
  await page.locator('#nextStepBtn').click(); return email;
}
async function documents(page, certificate = false) {
  await page.locator('#resumeUpload').setInputFiles({ name: 'Resume.pdf', mimeType: 'application/pdf', buffer: pdf });
  if (certificate) await page.locator('#certUpload').setInputFiles({ name: 'Certificate.pdf', mimeType: 'application/pdf', buffer: pdf });
}
async function consent(page) {
  await page.waitForFunction(() => window.LPCSignupPolicy?.read());
  await expect(page.locator('#signupTerms, #signupPrivacy')).toHaveCount(0);
  await page.evaluate(() => { const token = document.createElement('input'); token.type = 'hidden'; token.name = 'cf-turnstile-response'; token.value = 'synthetic-local-challenge'; document.getElementById('signupForm').append(token); });
}
async function login(page, email) {
  await page.goto(`${server.origin}/login.html`); await page.locator('#email').fill(email); await page.locator('#password').fill(password); await page.locator('#loginForm button[type=submit]').click();
}
async function adminReview(browser, id) {
  const admin = await server.createUser('admin'); const context = await browser.newContext(); await context.addCookies([admin.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage(); await page.goto(`${server.origin}/admin-dashboard.html`);
  await page.waitForFunction(() => typeof window.reviewAdminApplicant === 'function');
  await page.evaluate(id => window.reviewAdminApplicant(id), id);
  await expect(page.locator('#adminAccountContext .admin-facts')).toBeVisible();
  return { page, context };
}


test('regressions: common and contextual passwords are rejected before step two', async ({page}) => {
  await page.goto(`${server.origin}/signup.html`);
  await page.locator('#fullName').fill('Morgan Applicant');
  await page.locator('#email').fill('morgan@example.com');
  for (const value of ['password123!', 'morganapplicant']) {
    await page.locator('#password').fill(value); await page.locator('#nextStepBtn').click();
    await expect(page.locator('#passwordError')).toBeVisible();
    await expect(page.locator('#stepOnePanel')).toBeVisible();
  }
  await page.locator('#password').fill(password); await page.locator('#nextStepBtn').click();
  await expect(page.locator('#stepTwoPanel')).toBeVisible();
});

test('regressions: single-letter name and a real PDF with empty MIME can register', async ({page}) => {
  const email = await basics(page);
  await page.locator('#editSignupBasics').click(); await page.locator('#fullName').fill('J Applicant');
  await page.locator('#nextStepBtn').click(); await page.locator('#signupState').selectOption('NY');
  await page.locator('#resumeUpload').setInputFiles({name:'Not-a-PDF.pdf',mimeType:'application/pdf',buffer:Buffer.from('This is not a PDF document.')});
  await consent(page);await page.locator('#submitBtn').click();
  await expect(page.locator('#signupConfirmation')).toBeHidden();
  await expect(page.locator('#resumeUploadError')).toBeVisible();
  expect(await require('../../../models/User').countDocuments({email})).toBe(0);
  // DataTransfer preserves the empty MIME that OS/browser uploads can supply.
  await page.locator('#resumeUpload').evaluate((input, bytes) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], 'Resume.pdf', {type:''}));
    input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  }, Array.from(pdf));
  expect(await page.locator('#resumeUpload').evaluate(input=>input.files[0].type)).toBe('');
  await consent(page); await page.locator('#submitBtn').click();
  await expect(page.locator('#signupConfirmation')).toBeVisible();
  expect(await require('../../../models/User').findOne({email}).lean()).toMatchObject({firstName:'J',state:'NY'});
});

test('regressions: invalid experience edits cannot become accepted different numbers', async ({page}) => {
  await basics(page); await page.locator('#signupState').selectOption('NY'); await documents(page); await consent(page);
  let requests=0;await page.route('**/api/auth/register', route=>{requests++;return route.fulfill({status:503,json:{msg:'Synthetic stop'}});});
  for (const value of ['-1','1.5','100','99']) {
    await page.locator('#paralegalExperience').fill(''); await page.locator('#paralegalExperience').pressSequentially(value);
    await page.locator('#submitBtn').click(); await expect(page.locator('#paralegalExperienceError')).toBeVisible();
    expect(requests).toBe(0);
  }
  await page.locator('#paralegalExperience').fill('');
  await page.locator('#paralegalExperience').evaluate(input=>{
    const clipboardData=new DataTransfer();clipboardData.setData('text','100');
    input.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
  });
  await page.locator('#submitBtn').click();expect(requests).toBe(0);
  for(const value of ['0','80','']) {
    await page.locator('#paralegalExperience').fill(value);
    await page.locator('#submitBtn').click(); await expect.poll(()=>requests).toBe(value==='0'?1:value==='80'?2:3);
  }
});

test('regressions: long certificate name leaves Replace and Remove reachable', async ({page},info) => {
  await basics(page);
  await page.locator('#certUpload').setInputFiles({name:'Professional-certificate-with-a-very-long-name-that-must-never-overlap-the-actions.pdf',mimeType:'application/pdf',buffer:pdf});
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:844});await page.waitForTimeout(150);
    const row=page.locator('.lpc-certificate-upload');
    await row.scrollIntoViewIfNeeded();
    const geometry=await row.evaluate(el=>{const name=el.querySelector('[data-cert-name]').getBoundingClientRect(),actions=el.querySelector('.certificate-actions').getBoundingClientRect();return {nameRight:name.right,actionsLeft:actions.left};});
    expect(geometry.nameRight).toBeLessThanOrEqual(geometry.actionsLeft);
    await page.screenshot({path:info.outputPath(`long-certificate-${width}.png`)});
  }
});

test('regressions: admin can review and deliberately retry uncertain signup mail', async ({page,context},info) => {
  const admin=await server.createUser('admin');await context.addCookies([admin.cookie]);
  const Notice=require('../../../models/SignupReviewNotification');
  const record=await Notice.create({userId:admin.id,emailHash:'a'.repeat(64),status:'unknown',attempts:1,failure:'Delivery could not be confirmed. Check the mail provider’s delivery record.'});
  await page.goto(`${server.origin}/admin-dashboard.html`);
  await page.waitForFunction(()=>typeof window.activateAdminSection==='function');
  await page.locator('button.admin-primary-system').click();
  await page.locator('.admin-support-tools > summary').click();
  await page.locator('.admin-communications > summary').click();
  const attention=page.locator('[data-delivery-attention="signup-review"]');
  await attention.locator('summary').click();
  await expect(attention).toContainText('Email verified');
  await expect(attention).toContainText(`lpc-signup-review.${record._id}`);
  await attention.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('signup-email-recovery-admin.png')});
  await attention.locator('[data-delivery-retry]').click();
  await page.getByRole('button',{name:'I checked — queue attempt',exact:true}).click();
  await expect(page.locator('[data-communications-result]')).toHaveText('Another attempt is queued.');
  expect((await Notice.findById(record._id).lean()).status).toBe('pending');
});

test('regressions: mobile agreement stays visible and focused errors remain above it', async({page},info)=>{
  for(const role of ['attorney','paralegal'])for(const viewport of [{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
    await page.setViewportSize(viewport);await basics(page,role);await consent(page);
    await page.locator(role==='paralegal'?'#paralegalLinkedIn':'#attorneyLinkedIn').fill('invalid');
    if(role==='paralegal')await page.locator('#paralegalExperience').fill('99');
    await page.locator('#submitBtn').click();await page.waitForTimeout(100);
    // Landscape errors put actions in normal flow; check real content rather than the enclosing form box.
    await expect.poll(()=>page.evaluate(()=>{
      const content=[...document.querySelectorAll('#stepTwoPanel > :not(#signupSubmitActions)')].map(e=>e.getBoundingClientRect()).filter(r=>r.width&&r.height);
      return content.every(r=>r.bottom<=document.querySelector('#signupSubmitActions').getBoundingClientRect().top+1);
    })).toBe(true);
    const state=await page.evaluate(()=>{
      const policy=document.querySelector('#signupPolicyReview').getBoundingClientRect(),stage=document.querySelector('.signup-stage').getBoundingClientRect(),active=document.activeElement.getBoundingClientRect();
      return{policy:{top:policy.top,bottom:policy.bottom},stageBottom:stage.bottom,active:{top:active.top,bottom:active.bottom},height:innerHeight};
    });
    expect(state.policy.bottom).toBeLessThanOrEqual(state.height+.1);expect(state.stageBottom).toBeLessThanOrEqual(state.policy.top+.1);
    expect(state.active.top).toBeGreaterThanOrEqual(0);expect(state.active.bottom).toBeLessThanOrEqual(state.stageBottom);
    await page.locator('#editSignupBasics').scrollIntoViewIfNeeded();
    expect(await page.locator('#editSignupBasics').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('#signupPolicyReview').getBoundingClientRect().top)).toBe(true);
    await page.screenshot({path:info.outputPath(`${role}-${viewport.width}-footer-and-errors.png`)});
  }
});

// Sign-in recovery must preserve the approved UI while failing safely.
test('login recovery: unavailable browser storage does not interrupt sign-in or expose credentials', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Storage unavailable', 'SecurityError'); } });
  });
  let calls = 0;
  await page.route('**/api/auth/login', route => {
    calls++;
    return route.fulfill({ status: 401, json: { msg: 'Synthetic invalid credentials' } });
  });
  await page.goto(`${server.origin}/login.html`);
  await page.locator('#email').fill('recovery@example.com');
  await page.locator('#password').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#toastBanner')).toContainText('Synthetic invalid credentials');
  await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled();
  expect(calls).toBe(1);
  expect(page.url()).toBe(`${server.origin}/login.html`);
  await expect(page.locator('#password')).toHaveValue(password);
});

test('login recovery: a missing login module cannot place credentials in a GET URL', async ({page}) => {
  await page.route('**/assets/scripts/login.js', route => route.abort('failed'));
  let submitted;
  await page.route('**/api/auth/login', route => {
    submitted = { method: route.request().method(), url: route.request().url(), body: route.request().postData() };
    return route.fulfill({ status: 403, contentType: 'text/plain', body: 'Synthetic safe stop' });
  });
  await page.goto(`${server.origin}/login.html`);
  await page.locator('#email').fill('recovery@example.com');
  await page.locator('#password').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect.poll(() => submitted?.method).toBe('POST');
  expect(new URL(submitted.url).search).toBe('');
  expect(new URLSearchParams(submitted.body).get('password')).toBe(password);
  expect(page.url()).not.toContain('password=');
});

test('login recovery: overlapping code and backup submissions run once and permit a deliberate retry', async ({page}) => {
  await page.route('**/api/auth/login', route => route.fulfill({ json: { twoFactorRequired: true, challengeToken: 'synthetic-recovery', method: 'email' } }));
  let release, calls = [];
  await page.route(/\/api\/auth\/2fa-(verify|backup)$/, async route => {
    calls.push(new URL(route.request().url()).pathname);
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: 400, json: { error: 'Synthetic incorrect code' } });
  });
  await page.goto(`${server.origin}/login.html`);
  await page.locator('#email').fill('recovery@example.com');
  await page.locator('#password').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  for (const [index, endpoint, code] of [[0, '/api/auth/2fa-verify', '123456'], [1, '/api/auth/2fa-backup', 'AB12CD34']]) {
    if (index) await page.locator('#twoFactorBackupToggle').click();
    await page.locator('#twoFactorCode').fill(code);
    await page.locator('#twoFactorVerifyBtn').dblclick();
    await expect.poll(() => calls.length).toBe(index + 1);
    await page.locator('#twoFactorForm').evaluate(form => form.requestSubmit());
    expect(calls).toHaveLength(index + 1);
    await expect(page.locator('#twoFactorVerifyBtn')).toBeDisabled();
    await expect(page.locator('#twoFactorBackupToggle')).toBeDisabled();
    await expect(page.locator('#twoFactorBackBtn')).toBeDisabled();
    expect(calls[index]).toBe(endpoint);
    release();
    await expect(page.locator('#twoFactorVerifyBtn')).toBeEnabled();
    await expect(page.locator('#twoFactorBackupToggle')).toBeEnabled();
    await expect(page.locator('#twoFactorBackBtn')).toBeEnabled();
    await expect(page.locator('#twoFactorCode')).toHaveValue(code);
  }
});

for (const phase of ['csrf', 'credentials']) test(`login recovery: stalled ${phase} times out, cannot resume late and permits retry`, async ({page}) => {
  let release, holding = true, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/csrf', async route => {
    if (phase === 'csrf' && holding) await gate;
    await route.fulfill({ json: { csrfToken: 'synthetic-recovery-token' } }).catch(() => {});
  });
  await page.route('**/api/auth/login', async route => {
    calls++;
    if (phase === 'credentials' && holding) await gate;
    await route.fulfill({ status: 401, json: { msg: 'Synthetic invalid credentials' } }).catch(() => {});
  });
  await page.goto(`${server.origin}/login.html`);
  await page.locator('#email').fill('recovery@example.com');
  await page.locator('#password').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#toastBanner')).toContainText('Sign-in timed out', {timeout: 15000});
  await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled();
  holding = false; release();
  // Flush the late response and its continuations before checking for replay.
  await page.waitForTimeout(200);
  expect(calls).toBe(phase === 'csrf' ? 0 : 1);
  await expect(page.locator('#password')).toHaveValue(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.locator('#toastBanner')).toContainText('Synthetic invalid credentials');
  expect(calls).toBe(phase === 'csrf' ? 1 : 2);
  await expect(page.locator('#loginForm button[type=submit]')).toBeEnabled();
});

test('admission recovery: only unresolved decision emails offer deliberate retry in the existing communications panel', async ({page,context},info) => {
  const admin = await server.createUser('admin'); await context.addCookies([admin.cookie]);
  const Notice = require('../../../models/AdmissionDecisionNotification');
  const record = await Notice.create({ userId: admin.id, auditIndex: 1, decision: 'approved', emailHash: 'a'.repeat(64), status: 'unknown', attempts: 1,
    failure: 'Delivery could not be confirmed. Check the mail provider delivery record.' });
  await Notice.create({ userId: admin.id, auditIndex: 2, decision: 'denied', emailHash: 'a'.repeat(64), status: 'failed', attempts: 1, failure: 'Temporary failure; retry scheduled.' });
  await page.goto(`${server.origin}/admin-dashboard.html`);
  await page.waitForFunction(() => typeof window.activateAdminSection === 'function');
  await page.locator('button.admin-primary-system').click();
  await page.locator('.admin-support-tools > summary').click();
  await page.locator('.admin-communications > summary').click();
  const attention = page.locator('[data-delivery-attention="admission-decisions"]');
  await attention.locator('summary').click();
  await expect(attention).toContainText('approved');
  await expect(attention).toContainText(`lpc-admission-decision.${record._id}`);
  await expect(attention).not.toContainText('Temporary failure');
  await attention.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('admission-delivery-recovery.png') });
  await attention.locator('[data-delivery-retry]').click();
  await page.getByRole('button', { name: 'I checked — queue attempt', exact: true }).click();
  await expect(page.locator('[data-communications-result]')).toHaveText('Another attempt is queued.');
  expect((await Notice.findById(record._id)).status).toBe('pending');
});

test('landscape recovery: invalid fields and focused actions stay inside the visible card and above the agreement', async ({page},info) => {
  await page.setViewportSize({ width: 844, height: 390 });
  for (const role of ['attorney', 'paralegal']) {
    await basics(page, role); await consent(page);
    await page.locator(role === 'attorney' ? '#attorneyLinkedIn' : '#paralegalLinkedIn').fill('invalid');
    await page.locator('#submitBtn').click();
    const selectors = role === 'attorney' ? ['#bar', '#barState', '#attorneyLinkedIn', '#lawFirm', '#attorneyGoodStanding', '#submitBtn', '#editSignupBasics']
      : ['#signupState', '#paralegalExperience', '#paralegalLinkedIn', '#submitBtn', '#editSignupBasics'];
    for (const selector of selectors) {
      await page.locator(selector).focus();
      await expect.poll(() => page.locator(selector).evaluate(el => {
        const r = el.getBoundingClientRect(), shell = el.closest('.overlay').getBoundingClientRect(), stage = document.querySelector('.signup-stage').getBoundingClientRect();
        const brand = el.closest('.left-panel').querySelector('.brand-fixed').getBoundingClientRect();
        const coveredByBrand = r.left < brand.right && r.right > brand.left && r.top < brand.bottom && r.bottom > brand.top;
        return !coveredByBrand && r.top >= Math.max(0, stage.top, shell.top) && r.bottom <= Math.min(innerHeight, stage.bottom, shell.bottom);
      })).toBe(true);
    }
    await page.locator(selectors[0]).focus();
    await page.screenshot({ path: info.outputPath(`${role}-landscape-error-recovery.png`) });
    if (role === 'attorney') {
      await page.locator('#barState').selectOption('NY');
      await page.locator('#attorneyLinkedIn').fill('');
      await page.locator('#attorneyGoodStanding').check();
      await page.locator('#bar').fill('NY12345');
      await expect(page.locator('.signup-field-error')).toHaveCount(0);
      await expect(page.locator('body')).toHaveClass(/signup-landscape-recovery/);
      expect(await page.locator('#bar').evaluate(el => {
        const r = el.getBoundingClientRect(), brand = document.querySelector('.brand-fixed').getBoundingClientRect();
        return r.top >= 0 && r.bottom <= document.querySelector('.signup-stage').getBoundingClientRect().bottom && !(r.top < brand.bottom && r.bottom > brand.top);
      })).toBe(true);
      await page.locator('#editSignupBasics').click();
      await expect(page.locator('body')).not.toHaveClass(/signup-landscape-recovery/);
    }
  }
});
