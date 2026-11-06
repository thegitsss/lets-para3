const {
  test,
  expect
} = require('playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const start = require('../../helpers/financialLifecycleBrowserServer');
const selectState = require('../../helpers/signupStateSelection.cjs');
let server;
const password = 'An isolated signup correction passphrase';
const out = process.env.LPC_EMAIL_REVIEW_OUTPUT || path.resolve(__dirname, '../../../../outputs/email-suite-ready-20261105/browser');
test.beforeAll(async () => {
  test.setTimeout(180000);
  server = await start({
    port: 0,
    includeSyntheticMail: true,
    includeSyntheticDownloads: true
  });
});
test.beforeEach(async ({
  context,
  page
}) => {
  await server.reset();
  await context.route('**/*', r => new URL(r.request().url()).origin === server.origin ? r.continue() : r.abort());
  page.on('pageerror', e => {
    throw e;
  });
});
test.afterAll(async () => server?.close());
test.afterEach(async ({}, info) => {
  if (!server) return;
  const evidence = server.evidence();
  const result = {
    status: info.status,
    errors: info.errors.map(error => error.message),
    requests: evidence.requests,
    progress: evidence.requestProgress,
    mailRecipients: evidence.external.mail.map(mail => mail[0])
  };
  fs.writeFileSync(info.outputPath('journey-diagnostics.json'), JSON.stringify(result, null, 2));
});
async function capture(page, info, name) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: path.join(out, `${info.project.name}-${name}.png`),
    fullPage: true
  });
}
async function signup(page, role) {
  const email = `${role}.typo@example.com`;
  await page.goto(server.origin + `/signup.html?role=${role}`);
  await page.locator('#fullName').fill('Morgan Applicant');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#nextStepBtn').click();
  if (role === 'attorney') {
    await page.locator('#bar').fill('CA12345');
    await selectState(page, 'barState', 'CA');
    await page.locator('#attorneyGoodStanding').check();
  } else {
    await selectState(page, 'signupState', 'CA');
    await page.locator('#resumeUpload').setInputFiles({
      name: 'Resume.pdf',
      mimeType: 'application/pdf',
      buffer: fs.readFileSync(path.join(__dirname, '../paralegal-support/fixtures/paralegal-valid.pdf'))
    });
  }
  await page.waitForFunction(() => window.LPCSignupPolicy?.read());
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.type = 'hidden';
    i.name = 'cf-turnstile-response';
    i.value = 'synthetic-challenge';
    document.getElementById('signupForm').append(i);
  });
  const registration = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/auth/register' && response.request().method() === 'POST');
  await page.locator('#submitBtn').click();
  const response = await registration;
  expect(response.status()).toBe(200);
  await expect(page.locator('#signupConfirmation')).toBeVisible();
  return email;
}
function tokenFrom(mail) {
  return decodeURIComponent(mail[2].match(/token=([^&\s"'<>]+)/)[1]);
}
for (const role of ['attorney', 'paralegal']) test(`${role}: signup → correct address → new inbox verification → pending access`, async ({
  page
}, info) => {
  const email = await signup(page, role);
  await capture(page, info, role + '-signup-received');
  const old = tokenFrom(server.evidence().external.mail.find(m => m[1] === 'Verify your email'));
  const User = require('../../../models/User');
  const before = await User.findOne({
    email
  }).lean();
  await page.locator('#changeSignupEmail').click();
  await expect(page.locator('#signupEmailForm')).toBeVisible();
  await page.locator('#signupEmail').fill(email);
  await page.locator('#signupPassword').fill(password);
  await page.locator('#signupNewEmail').fill(`${role}.corrected@example.com`);
  await page.locator('#signupEmailForm button').click();
  await expect(page.locator('#verificationTitle')).toHaveText('Check your new inbox.');
  await capture(page, info, role + '-new-inbox');
  const changed = await User.findById(before._id).lean();
  expect(changed.email).toBe(email);
  expect(changed.pendingEmail).toBe(`${role}.corrected@example.com`);
  expect(changed.status).toBe('pending');
  expect(changed.resumeURL).toBe(before.resumeURL);
  const mail = server.evidence().external.mail.at(-1);
  expect(mail[0]).toBe(changed.pendingEmail);
  expect(mail[2]).toContain('/change-signup-email.html');
  const token = tokenFrom(mail);
  await page.goto(server.origin + '/verify-email.html?token=' + encodeURIComponent(old));
  await page.locator('#verificationConfirmForm button').click();
  await expect(page.locator('#verificationPanel')).toHaveAttribute('data-state', 'error');
  await expect(page.getByRole('link', {
    name: 'Use a different email address'
  })).toBeVisible();
  await capture(page, info, role + '-old-link-rejected');
  await page.goto(server.origin + '/verify-email.html?token=' + encodeURIComponent(token));
  await page.locator('#verificationConfirmForm button').click();
  await expect(page.locator('#verificationPanel')).toHaveAttribute('data-state', 'success');
  await expect(page.getByRole('link', {
    name: 'Use a different email address'
  })).toBeHidden();
  await expect(page.locator('#verificationAction')).toHaveText('Return home');
  await expect(page.locator('#verificationAction')).toHaveAttribute('href', 'index.html');
  const verified = await User.findById(before._id).lean();
  expect(verified.email).toBe(changed.pendingEmail);
  expect(verified.emailVerified).toBe(true);
  expect(verified.status).toBe('pending');
  await page.goto(server.origin + '/login.html');
  await page.locator('#email').fill(verified.email);
  await page.locator('#password').fill(password);
  await page.locator('#loginForm button[type=submit]').click();
  await expect(page.getByRole('dialog')).toContainText('pending approval');
  await page.getByRole('button', {
    name: 'Got it',
    exact: true
  }).click();
  await expect(page.locator('#loginForm')).toBeVisible();
});
test('correction form: responsive, keyboard, errors, enlarged text and uncertain delivery recovery', async ({
  page
}, info) => {
  const User = require('../../../models/User');
  await User.create({
    firstName: 'Morgan',
    lastName: 'Applicant',
    email: 'pending@example.com',
    password,
    role: 'attorney',
    status: 'pending',
    emailVerified: false,
    state: 'CA'
  });
  await page.goto(server.origin + '/change-signup-email.html');
  for (const width of [1440, 768, 540, 390, 320]) {
    await page.setViewportSize({
      width,
      height: 1000
    });
    await capture(page, info, 'form-' + width);
    expect(await page.locator('#signupEmailForm button').evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  await page.locator('#signupEmail').fill('pending@example.com');
  await page.locator('#signupPassword').fill('wrong');
  await page.locator('#signupNewEmail').fill('new@example.com');
  await page.locator('#signupEmailForm button').click();
  await expect(page.locator('#signupEmailStatus')).toContainText('Check your signup email and password');
  await expect(page.locator('#signupNewEmail')).toHaveValue('new@example.com');
  await capture(page, info, 'wrong-password-320');
  await page.locator('#signupPassword').fill(password);
  await page.locator('#signupNewEmail').focus();
  // macOS Safari uses Option-Tab to include buttons in keyboard navigation.
  // https://support.apple.com/guide/safari/cpsh003/mac
  await page.keyboard.press(info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(page.locator('#signupEmailForm button')).toBeFocused();
  await page.evaluate(() => document.documentElement.style.fontSize = '125%');
  await capture(page, info, 'enlarged-keyboard-320');
  server.setMailOutcome('unknown');
  await page.locator('#signupEmailForm button').click();
  await expect(page.locator('#verificationTitle')).toHaveText('New address saved.');
  await capture(page, info, 'unknown-delivery-320');
  server.setMailOutcome('accepted');
  await page.locator('#signupEmailRecovery summary').click();
  await page.locator('#signupEmailRecovery button').click();
  await expect(page.locator('#signupEmailRecovery [role=status]')).toContainText('Request received.');
  expect(server.evidence().external.mail.at(-1)[0]).toBe('new@example.com');
});
test('recent provider signup uses the original browser proof without inventing a password', async ({
  context,
  page
}, info) => {
  const User = require('../../../models/User');
  const user = await User.create({
    firstName: 'Morgan',
    lastName: 'Provider',
    email: 'provider@example.com',
    password: 'A generated provider-only secret',
    role: 'attorney',
    status: 'pending',
    emailVerified: false,
    state: 'CA',
    authProviders: [{
      provider: 'microsoft',
      providerAccountId: 'synthetic-microsoft-browser'
    }]
  });
  let cookie;
  require('../../../routes/signupEmail').rememberSignup({}, {
    cookie: (name, value, options) => {
      cookie = {
        name,
        value,
        url: server.origin + '/api/auth/signup-email',
        httpOnly: options.httpOnly,
        sameSite: 'Strict'
      };
    }
  }, user);
  await context.addCookies([cookie]);
  await page.goto(server.origin + '/change-signup-email.html');
  await expect(page.locator('#signupEmailCredentials')).toBeHidden();
  await expect(page.locator('#correctionLead')).toContainText('provider@example.com');
  await page.locator('#signupNewEmail').fill('provider.updated@example.com');
  await page.locator('#signupEmailForm button').click();
  await expect(page.locator('#verificationTitle')).toHaveText('Check your new inbox.');
  await capture(page, info, 'recent-provider-success');
});
