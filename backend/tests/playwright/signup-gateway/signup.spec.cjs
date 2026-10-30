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

test('single password field, original hint, eight-character minimum and Enter to Continue', async ({ page }) => {
  await page.goto(`${server.origin}/signup.html`); await page.evaluate(() => document.fonts.ready);
  await page.locator('#fullName').fill('Morgan Applicant'); await page.locator('#email').fill('morgan.applicant@example.com');
  const before = await page.locator('#nextStepBtn').boundingBox();
  await expect(page.locator('#confirmPassword')).toHaveCount(0);
  await page.locator('#password').fill('abc');
  await expect(page.locator('.password-hint')).toHaveText('8+ characters');
  expect((await page.locator('#nextStepBtn').boundingBox()).y).toBe(before.y);
  await page.locator('#password').fill('1234567'); await page.locator('#nextStepBtn').click();
  await expect(page.locator('#passwordError')).toContainText('at least 8');
  await page.locator('#password').fill('eight123'); await page.locator('#password').press('Enter');
  await expect(page.locator('#stepTwoPanel')).toBeVisible();
});

test('role switching preserves both drafts, optional fields and selected document bytes', async ({ page }) => {
  const email = await basics(page); await page.locator('#signupState').selectOption('NY');
  await page.locator('#paralegalExperience').fill('0');
  await page.locator('#paralegalLinkedIn').fill('https://www.linkedin.com/in/synthetic-applicant'); await documents(page, true);
  await page.locator('#editSignupBasics').click(); await page.locator('#btnA').click(); await page.locator('#nextStepBtn').click();
  await page.locator('#bar').fill('NY12345'); await page.locator('#barState').selectOption('NY'); await page.locator('#lawFirm').fill('Synthetic Law'); await page.locator('#attorneyGoodStanding').check();
  await page.locator('#editSignupBasics').click(); await page.locator('#btnP').click();
  await expect(page.locator('#email')).toHaveValue(email); await expect(page.locator('#password')).toHaveValue(password);
  await page.locator('#nextStepBtn').click(); await expect(page.locator('#signupState')).toHaveValue('NY'); await expect(page.locator('#paralegalExperience')).toHaveValue('0');
  expect(await page.locator('#resumeUpload').evaluate(async input => Array.from(new Uint8Array(await input.files[0].arrayBuffer())))).toEqual(Array.from(pdf));
  await consent(page); await page.locator('#submitBtn').click(); await expect(page.locator('#signupConfirmation')).toBeVisible();
  const user = await require('../../../models/User').findOne({ email }).lean();
  expect(user).toMatchObject({ role: 'paralegal', state: 'NY', yearsExperience: 0, paralegalQualification: '', linkedInURL: 'https://www.linkedin.com/in/synthetic-applicant' });
  expect(user.resumeURL).toBeTruthy(); expect(user.certificateURL).toBeTruthy(); expect(user.barNumber).toBe('');
});

test('minimal paralegal signup accepts zero or omitted experience and no optional credentials', async ({ page }) => {
  for (const years of ['0', '']) {
    const email = await basics(page); await consent(page); await page.locator('#submitBtn').click();
    await expect(page.locator('#signupState')).toBeFocused(); await expect(page.locator('#resumeUploadError')).toBeVisible();
    await page.waitForTimeout(5100); await expect(page.locator('#signupStateError')).toBeVisible();
    await page.locator('#signupState').selectOption('CA'); await documents(page); if (years) await page.locator('#paralegalExperience').fill(years);
    await page.locator('#submitBtn').click(); await expect(page.locator('#signupConfirmation')).toBeVisible();
    expect(await require('../../../models/User').findOne({ email }).lean()).toMatchObject({ state: 'CA', yearsExperience: years ? 0 : null, paralegalQualification: '', linkedInURL: '' });
  }
});

test('policy loading and failed registration retain entries and allow deliberate retry', async ({ page }) => {
  let legalCalls = 0;
  await page.route('**/api/auth/legal/current', route => ++legalCalls === 1 ? route.fulfill({ status: 503, json: {} }) : route.continue());
  const email = await basics(page); await page.locator('#signupState').selectOption('NY'); await documents(page);
  await page.locator('#submitBtn').click(); await expect(page.locator('#signupPolicyStatus')).toContainText('could not be loaded');
  expect(await page.locator('#resumeUpload').evaluate(input => input.files[0].name)).toBe('Resume.pdf');
  await page.locator('#signupPolicyReload').click();
  let calls = 0;
  await page.route('**/api/auth/register', route => { calls++; return calls === 1 ? route.abort('failed') : route.continue(); });
  await consent(page); await expect(page.locator('#signupPolicyReloadError')).toHaveCount(0); await page.locator('#submitBtn').click(); await expect(page.locator('#msg')).toBeVisible(); await expect(page.locator('#submitBtn')).toBeEnabled();
  await expect(page.locator('#signupState')).toHaveValue('NY'); expect(await page.locator('#resumeUpload').evaluate(input => input.files[0].name)).toBe('Resume.pdf');
  await page.locator('#submitBtn').click(); await expect(page.locator('#signupConfirmation')).toBeVisible();
  expect(calls).toBe(2); expect(await require('../../../models/User').countDocuments({ email })).toBe(1);
});

for (const role of ['attorney', 'paralegal']) test(`${role}: actual signup, separate-browser verification, Admin review, approval and first sign-in`, async ({ page, browser }, info) => {
  const email = await basics(page, role);
  if (role === 'attorney') {
    await consent(page); await page.locator('#submitBtn').click();
    await expect(page.locator('#barError')).toBeVisible(); await expect(page.locator('#barStateError')).toBeVisible(); await expect(page.locator('#attorneyGoodStandingError')).toBeVisible();
    await page.locator('#bar').fill('CA12345'); await page.locator('#barState').selectOption('CA'); await page.locator('#lawFirm').fill('Synthetic Law'); await page.locator('#attorneyLinkedIn').fill('https://linkedin.com/in/synthetic-attorney');
    await page.locator('#submitBtn').click(); await expect(page.locator('#attorneyGoodStanding')).toBeFocused(); await page.locator('#attorneyGoodStanding').check();
  } else {
    await page.locator('#signupState').selectOption('CA'); await page.locator('#paralegalExperience').fill('1');
    await page.locator('#paralegalLinkedIn').fill('https://linkedin.com/in/synthetic-paralegal'); await documents(page, true); await consent(page);
  }
  // Delay the original browser request without reconstructing WebKit's binary multipart body.
  let submissions = 0, releaseSubmission;
  const submissionGate = new Promise(resolve => { releaseSubmission = resolve; });
  await page.route('**/api/auth/register', async route => { submissions++; await submissionGate; await route.continue(); });
  await page.locator('#submitBtn').click(); await expect(page.locator('#submitBtn')).toBeDisabled();
  await page.locator('#signupForm').evaluate(form => form.requestSubmit()); releaseSubmission();
  await expect(page.locator('#signupConfirmation')).toBeVisible(); expect(submissions).toBe(1);
  await expect(page.locator('#signupConfirmationTitle')).toHaveText(role === 'attorney' ? 'Registration received.' : 'Application submitted.');
  await expect(page.locator('#signupConfirmationEmail')).toContainText(email);
  await expect(page.locator('#resendSignupVerification')).toBeVisible();
  await page.screenshot({path:info.outputPath(`${role}-check-email.png`),fullPage:true});
  const User = require('../../../models/User'), user = await User.findOne({ email }).lean(); expect(user.status).toBe('pending'); expect(await User.countDocuments({ email })).toBe(1);
  const mail = server.evidence().external.mail.find(call => call[0] === email && call[1] === 'Verify your email'); expect(mail).toBeTruthy();
  const token = decodeURIComponent(mail[2].match(/token=([^&\s"'<>]+)/i)[1]);
  const verification = await browser.newContext(), verify = await verification.newPage();
  await verification.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  await verify.goto(`${server.origin}/verify-email.html?token=${encodeURIComponent(token)}`);
  await expect(verify.locator('#verificationPanel')).toHaveAttribute('data-state', 'ready');
  expect((await User.findById(user._id)).emailVerified).toBe(false);
  await verify.getByRole('button', {name:'Verify email',exact:true}).click();
  await expect(verify.locator('#verificationPanel')).toHaveAttribute('data-state', 'success');
  await expect(verify.locator('#verificationStatus')).toHaveText('We’ll review your application and email you when your account is ready.');
  await verify.screenshot({path:info.outputPath(`${role}-verified-pending.png`),fullPage:true});
  await verification.close(); await login(page, email); await expect(page.locator('body')).toContainText('We’re reviewing your application.');
  const admin = await adminReview(browser, String(user._id));
  await admin.page.locator('[data-account-tab=profile]').click();
  await expect(admin.page.locator('#pendingUserDetails')).toContainText(role === 'attorney' ? 'Synthetic Law' : '1');
  await expect(admin.page.locator('#pendingUserDetails')).toContainText('LinkedIn');
  await expect(admin.page.locator('#pendingUserDetails')).not.toContainText('good standing');
  if (role === 'paralegal') { await expect(admin.page.locator('#pendingUserDetails')).toContainText('Certification'); await expect(admin.page.locator('#pendingUserDetails')).toContainText('Resume'); }
  await admin.page.locator('[data-account-tab=review]').click();
  const decision=admin.page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/admin/users/${user._id}/approve`);
  await admin.page.locator('#approveUserBtn').click();expect((await decision).status()).toBe(200);
  await expect.poll(async () => (await User.findById(user._id).lean()).status).toBe('approved');
  const approvalMail=server.evidence().external.mail.find(call=>call[0]===email&&call[1]==='Welcome to Let’s-ParaConnect');
  expect(approvalMail).toBeTruthy();expect(approvalMail[2]).toContain('>Sign in</a>');
  await admin.context.close(); await login(page, email);
  if (role === 'paralegal') await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
  else await expect(page.locator('[data-attorney-state]')).toHaveAttribute('data-attorney-state', 'ready');
  await expect(page).toHaveURL(new RegExp(`${role}-v2.html`));
});

test('verification waits for an explicit click, prevents double submission and handles reused links by account status', async ({page},info) => {
  const User = require('../../../models/User');
  const user = await User.create({firstName:'Morgan',lastName:'Verification',email:'scanner-proof@example.com',password,role:'attorney',status:'pending',emailVerified:false,state:'CA'});
  await require('../../../utils/emailVerification').sendVerificationEmail({user,email:user.email});
  const token=decodeURIComponent(server.evidence().external.mail.at(-1)[2].match(/token=([^&\s"'<>]+)/i)[1]);
  const url=`${server.origin}/verify-email.html?token=${encodeURIComponent(token)}`;
  await page.goto(url);await expect(page.locator('#verificationPanel')).toHaveAttribute('data-state','ready');
  await page.waitForTimeout(150);
  expect(server.evidence().requests.filter(r=>r.method==='POST'&&r.path==='/api/auth/verify-email')).toHaveLength(0);
  expect((await User.findById(user._id)).emailVerified).toBe(false);
  expect(page.url()).not.toContain('token=');
  const untrusted=await page.request.post(`${server.origin}/api/auth/verify-email`,{data:{token}});
  expect(untrusted.status()).toBe(403);
  expect((await User.findById(user._id)).emailVerified).toBe(false);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:info.outputPath(`verify-ready-${width}.png`),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  const AxeBuilder=require('@axe-core/playwright').default;
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze()).violations).toEqual([]);
  let release,calls=0;const pending=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/auth/verify-email',async route=>{calls++;await pending;return route.continue();});
  const button=page.getByRole('button',{name:'Verify email',exact:true});
  await button.focus();await page.keyboard.press('Enter');
  await expect(page.locator('#verificationConfirmForm button')).toBeDisabled();
  await page.locator('#verificationConfirmForm').evaluate(form=>form.requestSubmit());
  release();await expect(page.locator('#verificationPanel')).toHaveAttribute('data-state','success');expect(calls).toBe(1);
  await page.unroute('**/api/auth/verify-email');
  await page.goto(url);await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await expect(page.locator('#verificationTitle')).toHaveText('Your email is already verified.');
  await expect(page.locator('#verificationStatus')).toHaveText('We’ll review your application and email you when your account is ready.');
  expect(await require('../../../models/AuditLog').countDocuments({action:'auth.verify.success',targetId:user._id})).toBe(1);
  await User.updateOne({_id:user._id},{$set:{status:'approved'}});
  await page.goto(url);await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await expect(page.locator('#verificationStatus')).toHaveText('Your account is ready. You can sign in.');
  await expect(page.locator('#verificationAction')).toHaveText('Sign in');
  await expect(page.locator('#verificationAction')).toHaveAttribute('href','login.html');
  await page.screenshot({path:info.outputPath('verified-approved-mobile.png'),fullPage:true});
});

test('verification recovers from a temporary failure and an expired link without losing the account', async ({page},info) => {
  const User=require('../../../models/User');
  const user=await User.create({firstName:'Morgan',lastName:'Recovery',email:'verification-retry@example.com',password,role:'paralegal',status:'pending',emailVerified:false,state:'CA',resumeURL:'retained/resume.pdf'});
  const helper=require('../../../utils/emailVerification');await helper.sendVerificationEmail({user,email:user.email});
  const token=decodeURIComponent(server.evidence().external.mail.at(-1)[2].match(/token=([^&\s"'<>]+)/i)[1]);
  let calls=0;await page.route('**/api/auth/verify-email',route=>++calls===1?route.fulfill({status:503,json:{msg:'We couldn’t confirm verification yet. Please try again.'}}):route.continue());
  await page.goto(`${server.origin}/verify-email.html?token=${encodeURIComponent(token)}`);
  await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await expect(page.locator('#verificationPanel')).toHaveAttribute('data-state','error');
  expect((await User.findById(user._id)).emailVerified).toBe(false);
  await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await expect(page.locator('#verificationPanel')).toHaveAttribute('data-state','success');
  const expired=helper.buildEmailVerificationToken({userId:user._id,email:user.email,expiresIn:-1});
  await page.goto(`${server.origin}/verify-email.html?token=${encodeURIComponent(expired)}`);
  await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await expect(page.locator('#verificationRecovery')).toBeVisible();
  await expect(page.locator('#verificationStatus')).toContainText('invalid or expired');
  await page.screenshot({path:info.outputPath('verification-expired-recovery.png'),fullPage:true});
  expect((await User.findById(user._id)).resumeURL).toBe('retained/resume.pdf');
  expect(await User.countDocuments({email:user.email})).toBe(1);
});

test('uncertain mail delivery keeps the saved application and offers recovery without claiming a failed send', async ({page}) => {
  server.setMailOutcome('unknown');await basics(page,'attorney');
  await page.locator('#bar').fill('CA12345');await page.locator('#barState').selectOption('CA');await page.locator('#attorneyGoodStanding').check();await consent(page);
  await page.locator('#submitBtn').click();
  await expect(page.locator('#signupConfirmationLead')).toContainText('Your registration is saved.');
  await expect(page.locator('#signupConfirmationLead')).toContainText('hasn’t arrived');
  await expect(page.locator('#signupConfirmationLead')).not.toContainText('couldn’t send');
  await expect(page.locator('#resendSignupVerification')).toBeVisible();
});

test('saved signup survives mail failure, failed resend and retry without a second application', async ({ page }) => {
  server.setMailOutcome('rejected'); const email = await basics(page); await page.locator('#signupState').selectOption('NY'); await documents(page); await consent(page);
  await page.locator('#submitBtn').click(); await expect(page.locator('#signupConfirmationLead')).toContainText('Your application is saved.'); await expect(page.locator('#signupConfirmationLead')).toContainText('couldn’t send');
  await page.clock.install();
  let calls = 0; await page.route('**/api/auth/resend-verification', route => { calls++; return calls === 1 ? route.fulfill({ status: 503, json: {} }) : route.continue(); });
  const resend = page.locator('#resendSignupVerification'); await resend.click(); await expect(page.locator('#signupVerificationStatus')).toContainText('Please try again.'); await expect(resend).toBeEnabled();
  server.setMailOutcome('accepted'); await resend.click(); await expect(page.locator('#signupVerificationStatus')).toContainText('Request received.'); await expect(resend).toBeDisabled();
  await page.clock.fastForward(60001); await expect(resend).toBeEnabled(); await expect(page.locator('#signupVerificationStatus')).toHaveText('You can request another verification email now.');
  expect(await require('../../../models/User').countDocuments({ email })).toBe(1);
});

test('invalid verification and sign-in both offer generic resend recovery with cooldown and retry', async ({ page }) => {
  await page.goto(`${server.origin}/verify-email.html?token=invalid-local-test`); await page.getByRole('button',{name:'Verify email',exact:true}).click(); await expect(page.locator('#verificationRecovery')).toBeVisible();
  await page.locator('#verificationRecoveryEmail').fill('unknown@example.com'); await page.locator('[data-verification-resend] button').click();
  await expect(page.locator('[data-verification-resend] [role=status]')).toContainText('Request received.'); await expect(page.locator('[data-verification-resend] button')).toBeDisabled();
  await page.route('**/api/auth/login', route => route.fulfill({ status: 403, json: { error: 'Please verify your email before logging in.', emailVerificationRequired: true } }));
  await login(page, 'unknown@example.com');
  await expect(page.locator('#loginVerificationDialog')).toBeVisible();
  await expect(page.locator('#loginVerificationEmail')).toHaveValue('unknown@example.com');
  let calls = 0; await page.route('**/api/auth/resend-verification', route => { calls++; return route.fulfill({ status: calls === 1 ? 503 : calls === 2 ? 429 : 200, headers: { 'Retry-After': '1' }, json: { ok: true } }); });
  const button = page.locator('[data-verification-resend] button[type=submit]'); await button.click(); await expect(page.locator('[data-verification-resend] [role=status]')).toContainText('Please try again.'); await expect(button).toBeEnabled();
  await button.click(); await expect(page.locator('[data-verification-resend] [role=status]')).toContainText('Please wait'); await expect(button).toBeDisabled(); await expect(button).toBeEnabled();
  await expect(page.locator('[data-verification-resend] [role=status]')).toHaveText('You can request another verification email now.');
  await button.click(); await expect(page.locator('[data-verification-resend] [role=status]')).toContainText('Request received.');
});

for (const width of [1440, 390, 320]) test(`rendered signup and recovery at ${width}px with keyboard accessibility`, async ({ page }, info) => {
  const AxeBuilder = require('@axe-core/playwright').default;
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await basics(page, 'attorney'); await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: info.outputPath(`attorney-${width}.png`), fullPage: true });
  let violations = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze(); expect(violations.violations).toEqual([]);
  await basics(page, 'paralegal'); await page.screenshot({ path: info.outputPath(`paralegal-${width}.png`), fullPage: true });
  violations = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.violations).toEqual([]);
  await page.locator('#signupState').focus(); await page.keyboard.press('Tab'); await expect(page.locator('#paralegalExperience')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`${server.origin}/verify-email.html`); await expect(page.locator('#verificationRecovery')).toBeVisible(); await page.screenshot({ path: info.outputPath(`verification-${width}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('both refined forms keep controls reachable through window resizing', async ({ page }, info) => {
  for (const role of ['attorney', 'paralegal']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await basics(page, role);
    await expect(page.locator('#paralegalQualification, #signupTerms, #signupPrivacy')).toHaveCount(0);
    for (const viewport of [{width:1440,height:900},{width:1024,height:768},{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
      await page.setViewportSize(viewport); await page.waitForTimeout(150);
      if (role === 'attorney') expect((await page.locator('#attorneyGoodStanding').boundingBox()).height).toBeCloseTo(16, 2);
      if (role === 'attorney') expect(await page.locator('.attorney-standing').evaluate(el => {const r=el.getBoundingClientRect(),s=document.querySelector('.signup-form-scroll').getBoundingClientRect();return r.top>=s.top && r.bottom<=s.bottom;})).toBe(true);
      const ids = role === 'attorney' ? ['bar','barState','attorneyLinkedIn','lawFirm','attorneyGoodStanding'] : ['signupState','paralegalExperience','paralegalLinkedIn'];
      for (const id of ids) {
        await page.locator('#'+id).focus();
        await expect.poll(() => page.locator('#'+id).evaluate(el => {
          const r=el.getBoundingClientRect(), s=document.querySelector('.signup-form-scroll').getBoundingClientRect();
          return r.width>0 && r.left>=s.left-1 && r.right<=s.right+1 && r.top>=s.top-1 && r.bottom<=s.bottom+1;
        })).toBe(true);
      }
      for (const selector of ['#submitBtn','#editSignupBasics']) {
        const r=await page.locator(selector).boundingBox(); expect(r.width).toBeGreaterThan(0);
        expect(await page.locator(selector).evaluate(el => { const r=el.getBoundingClientRect(),p=document.querySelector('.left-panel').getBoundingClientRect();return r.top>=p.top-1 && r.bottom<=p.bottom+1 && r.left>=p.left-1 && r.right<=p.right+1; })).toBe(true);
      }
      await page.locator('#editSignupBasics').scrollIntoViewIfNeeded();
      const collision=await page.evaluate(() => {const a=document.getElementById('submitBtn').getBoundingClientRect(),b=document.getElementById('editSignupBasics').getBoundingClientRect(),c=document.getElementById('signupPolicyReview').getBoundingClientRect();return a.bottom>b.top+1 || b.bottom>c.top+1;});
      expect(collision).toBe(false);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`${role}-${viewport.width}x${viewport.height}-resized.png`),fullPage:true});
    }
  }
});

test('retired preview routes are not published for either role', async ({ page }) => {
  for (const role of ['attorney','paralegal']) {
    const response = await page.goto(`${server.origin}/lpc-signup-preview/index.html?role=${role}`);
    expect(response.status()).toBe(404);
    await expect(page.locator('#signupForm')).toHaveCount(0);
  }
});


test('a server error on basic details preserves editable document controls on retry', async ({ page }) => {
  const email = await basics(page); await page.locator('#signupState').selectOption('NY'); await documents(page, true); await consent(page);
  let calls = 0;
  await page.route('**/api/auth/register', route => ++calls === 1 ? route.fulfill({status:400,json:{msg:'Choose a less common password.',field:'password'}}) : route.continue());
  await page.locator('#submitBtn').click(); await expect(page.locator('#passwordError')).toContainText('less common');
  await page.locator('#password').fill(password+' corrected'); await page.locator('#nextStepBtn').click();
  await expect(page.locator('#resumeUpload')).toBeEnabled();
  expect(await page.locator('#resumeUpload').evaluate(input=>input.files[0].name)).toBe('Resume.pdf');
  const chooser = page.waitForEvent('filechooser'); await page.locator('[data-replace]').click();
  await (await chooser).setFiles({name:'Corrected-resume.pdf',mimeType:'application/pdf',buffer:pdf});
  await consent(page); await page.locator('#submitBtn').click(); await expect(page.locator('#signupConfirmation')).toBeVisible();
  expect(calls).toBe(2); expect(await require('../../../models/User').countDocuments({email})).toBe(1);
});

test('policy loading completion releases temporary height and preserves the final frame', async ({ page }) => {
  for (const role of ['attorney', 'paralegal']) {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await page.route('**/api/auth/legal/current', async route => { await pending; return route.continue(); });
    await page.goto(`${server.origin}/signup.html?role=${role}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('#signupPolicyStatus')).toHaveText('Loading the policy documents…');
    await page.waitForTimeout(650);
    await page.locator('#fullName').fill('Morgan Applicant');
    await page.locator('#email').fill('morgan.policy-sizing@example.com');
    await page.locator('#password').fill(password);
    const card = await page.locator('.overlay').boundingBox();
    release();
    await page.waitForFunction(() => window.LPCSignupPolicy?.read());
    await page.waitForTimeout(100);
    const loadedCard = await page.locator('.overlay').boundingBox();
    const loadedAction = await page.locator('#nextStepBtn').boundingBox();
    expect(loadedCard.height).toBeLessThanOrEqual(card.height);
    expect(loadedCard.width).toBe(card.width);
    await page.locator('#nextStepBtn').click();
    expect(await page.locator('.overlay').boundingBox()).toEqual(loadedCard);
    expect(await page.locator('#submitBtn').boundingBox()).toEqual(loadedAction);
    await page.unroute('**/api/auth/legal/current');
  }
});

test('both signup steps share card, heading, primary action and right-panel geometry', async ({ page }, info) => {
  const snapshot = () => page.evaluate(() => {
    const two=document.body.classList.contains('signup-application-step');
    const selectors={shell:'.overlay',panel:'.left-panel',heading:two?'.signup-step-two-title':'#signupHeading',action:two?'#submitBtn':'#nextStepBtn',right:'.signup-aside-copy',story:'.auth-story',illustration:'.lpc-entry-preview'};
    return Object.fromEntries(Object.entries(selectors).map(([key,selector])=>{const e=document.querySelector(selector),r=e.getBoundingClientRect(),s=getComputedStyle(e);return[key,{x:r.width?r.x+scrollX:0,y:r.height?r.y+scrollY+(document.querySelector(".signup-stage")?.scrollTop||0):0,width:r.width,height:r.height,fontSize:s.fontSize,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing}];}));
  });
  const compare = (one,two) => {
    for(const name of Object.keys(one)) for(const key of Object.keys(one[name])) {
      if(typeof one[name][key]==='number') expect(Math.abs(two[name][key]-one[name][key]),`${name}.${key}`).toBeLessThan(.1);
      else expect(two[name][key],`${name}.${key}`).toBe(one[name][key]);
    }
  };
  for(const role of ['attorney','paralegal']) for(const viewport of [{width:1440,height:900},{width:1024,height:768},{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
    await page.setViewportSize(viewport);await page.goto(`${server.origin}/signup.html?role=${role}`);
    await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>window.LPCSignupPolicy?.read());await page.waitForTimeout(650);
    await page.locator('#fullName').fill('Morgan Sizing');await page.locator('#email').fill('morgan.sizing@example.com');await page.locator('#password').fill(password);
    // Full-page captures can resize Chromium's document and trigger the responsive controller.
    const one=await snapshot();
    if (viewport.width === 1440) { expect(one.shell.height, 'compact desktop card').toBeLessThanOrEqual(700); expect(one.shell.width).toBeLessThanOrEqual(1200); expect(Math.abs(one.action.y - one.shell.y - 504.89), 'original desktop action position').toBeLessThan(2); }
    if (viewport.width > 768) {
      expect(one.illustration.y).toBeGreaterThanOrEqual(one.story.y + one.story.height);
      expect(one.illustration.y + one.illustration.height).toBeLessThanOrEqual(one.right.y + one.right.height);
    } else expect(one.right.height).toBe(0);
    await page.screenshot({path:info.outputPath(`${role}-${viewport.width}-step1.png`)});
    await page.locator('#nextStepBtn').click();await expect(page.locator('#stepTwoPanel')).toBeVisible();await page.waitForTimeout(100);
    const two=await snapshot();
    await info.attach(`${role}-${viewport.width}-geometry`,{body:JSON.stringify({one,two},null,2),contentType:'application/json'});
    compare(one,two);await page.screenshot({path:info.outputPath(`${role}-${viewport.width}-step2.png`)});
    await page.locator('#editSignupBasics').click();compare(one,await snapshot());
  }
});


test('all four signup views retain one card size and identical basic-details geometry across roles', async ({ page }, info) => {
  for (const viewport of [{width:1440,height:900},{width:1024,height:768},{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
    await page.setViewportSize(viewport);
    for (const initialRole of ['attorney','paralegal']) {
      await page.goto(`${server.origin}/signup.html?role=${initialRole}`);
      await page.evaluate(()=>document.fonts.ready);
      await page.waitForFunction(()=>window.LPCSignupPolicy?.read());
      await page.waitForTimeout(650);
      await page.locator('#fullName').fill('Morgan Sizing');
      await page.locator('#email').fill('morgan.sizing@example.com');
      await page.locator('#password').fill(password);
      await page.locator('#nextStepBtn').click();
      const size=()=>page.locator('.overlay').evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
      const initial=await size();
      let basicGeometry;
      for (const role of [initialRole,initialRole==='attorney'?'paralegal':'attorney',initialRole]) {
        await page.locator('#editSignupBasics').click();
        await page.locator(role==='attorney'?'#btnA':'#btnP').click();
        expect(await size()).toEqual(initial);
        const currentBasics = await page.evaluate(() => Object.fromEntries(
          ['#signupHeading','#googleSignupButton','#fullName','#email','#password','#nextStepBtn','#stepOnePanel > .extra-links'].map(selector=>{
            const r=document.querySelector(selector).getBoundingClientRect();
            return [selector,{x:r.x+scrollX,y:r.y+scrollY+(document.querySelector(".signup-stage")?.scrollTop||0),width:r.width,height:r.height}];
          })));
        if (!basicGeometry) basicGeometry=currentBasics;
        else expect(currentBasics, 'role switch must not move any shared basic-details element').toEqual(basicGeometry);
        await page.screenshot({path:info.outputPath(`basics-${initialRole}-${role}-${viewport.width}.png`)});
        await page.locator('#nextStepBtn').click();
        expect(await size()).toEqual(initial);
        const submitGeometry = await page.locator('#submitBtn').evaluate(el=>{
          const r=el.getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY+(document.querySelector(".signup-stage")?.scrollTop||0),width:r.width,height:r.height};
        });
        for (const key of Object.keys(submitGeometry)) expect(submitGeometry[key], `Continue/Submit ${key}`).toBeCloseTo(currentBasics['#nextStepBtn'][key], 1);
        await page.screenshot({path:info.outputPath(`common-${initialRole}-${role}-${viewport.width}.png`)});
      }
    }
  }
});
