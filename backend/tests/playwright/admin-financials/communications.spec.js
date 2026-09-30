const { test, expect } = require("playwright/test");
const { ObjectId } = require("mongoose").mongo;
const AxeBuilder = require("@axe-core/playwright").default;
const { seed, database, ACTIVE } = require("./fixtures");
for (const category of ["work", "payments", "withdrawals", "reviews", "resolution", "overdue", "applications", "application-withdrawal", "invitations", "invitation-response", "pre-engagement", "posting"]) {
const posting = category === 'posting';
const preEngagement = category === "pre-engagement";
const invitationResponse = category === "invitation-response";
const applicationWithdrawal = category === "application-withdrawal", resolution = category === "resolution", overdue = category === "overdue", kind = invitationResponse ? "invitations" : applicationWithdrawal ? "applications" : resolution || overdue ? "reviews" : category;
const invitation = kind === "invitations", application = kind === "applications", review = kind === "reviews", payment = kind === "payments", withdrawal = kind === "withdrawals", collection = posting ? "matterpostingnotifications" : preEngagement ? "matterpreengagementnotifications" : invitation ? "matterinvitationnotifications" : application ? "matterapplicationnotifications" : review ? "matterreviewnotifications" : payment ? "matterpaymentnotifications" : withdrawal ? "matterwithdrawalnotifications" : "matterworknotifications";
const heading = posting ? "Posting emails" : preEngagement ? "Pre-engagement emails" : invitation ? "Invitation emails" : application ? "Application emails" : review ? "Matter review emails" : payment ? "Payment update emails" : withdrawal ? "Withdrawal emails" : "Work ready emails";
const ids = ["650000000000000000009101", "650000000000000000009102", "650000000000000000009103", ...(posting ? ["650000000000000000009104", "650000000000000000009105"] : [])].map(id => payment ? id.replace("910", "920") : withdrawal ? id.replace("910", "930") : id);
async function records() {
  return database(db => db.collection(collection).find({ _id: { $in: ids.map(id => new ObjectId(id)) } }).sort({ _id: 1 }).toArray());
}
test(`admin reviews current ${category}-email outcomes and explicitly recovers one without duplicate retry`, async ({ page }, info) => {
  await seed();
  await database(async db => {
    await db.collection(collection).deleteMany({ _id: { $in: ids.map(id => new ObjectId(id)) } });
    const matter = await db.collection("cases").findOne({ _id: new ObjectId(ACTIVE) });
    await db.collection(collection).insertMany(ids.map((id, index) => ({ _id: new ObjectId(id), caseId: matter._id, ...(posting ? { kind: ['created', 'updated', 'deleted', 'edits_requested', 'review_requested'][index], ownerId: matter.attorney, actorUserId: matter.attorney, userId: matter.paralegal, eventKey: id.padStart(64, '0'), stateKey: 'a'.repeat(64) } : preEngagement ? { kind: ["requested", "submitted", "changes_requested"][index], ownerId: matter.attorney, actorUserId: matter.attorney, userId: matter.paralegal, paralegalId: matter.paralegal, revisionKey: id.padStart(64, "0") } : invitation ? { kind: invitationResponse ? ["accepted", "declined", "revoked"][index] : "sent", ownerId: matter.attorney, actorUserId: matter.attorney, userId: matter.paralegal, paralegalId: matter.paralegal, invitationKey: id.padStart(64, "0") } : application ? { kind: applicationWithdrawal ? "withdrawn" : "submitted", source: "canonical", userId: matter.attorney, paralegalId: matter.paralegal, applicationId: new ObjectId(), jobId: new ObjectId(), submissionKey: "a".repeat(64) } : review ? { userId: matter.attorney, userRole: "attorney", ...(resolution ? { kind: "resolved", resolvedAt: new Date(), action: "refund", operationId: new ObjectId() } : overdue ? { kind: "overdue", deadlineAt: new Date(), remindedAt: new Date() } : { kind: "opened" }), disputeId: `synthetic-admin-review-${index}`, openedAt: new Date() } : payment ? { userId: matter.attorney, paymentIntentId: "pi_browser_payment_notice", paymentStatus: "requires_action" } : withdrawal ? { userId: matter.attorney, attorneyId: matter.attorney, paralegalId: matter.paralegal, withdrawnAt: new Date(), outcome: "awaiting_attorney_decision" } : { userId: matter.paralegal, attorneyId: matter.attorney, hiredAt: new Date() }), status: ["unknown", "failed", "disabled"][index % 3], attempts: 1, failure: ["Delivery could not be confirmed. Check the mail provider's delivery record.", "The mail provider rejected this attempt.", "Email sending was disabled. This notice was not sent."][index % 3], claim: `synthetic-${index}`, createdAt: new Date(), updatedAt: new Date(), nextAttemptAt: new Date() })));
  });
  const before = await records(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/admin-dashboard.html", { waitUntil: "domcontentloaded" });
  await page.locator('#sidebarNav [data-section="support-ops"]').click();
  const fold = page.locator(".admin-communications");
  await fold.locator(":scope > summary").click();
  await expect(fold.getByText(heading, { exact: true })).toBeVisible();
  const notices = fold.locator(`[data-delivery-attention="${kind}"]`);
  await notices.locator("summary").click();
  await expect(notices.locator("article")).toHaveCount(posting ? 5 : 3);
  if (posting) await expect(notices.locator("article strong")).toHaveText(['Posting review requested · failed', 'Posting revisions requested · unknown', 'Posting removed · disabled', 'Posting updated · failed', 'Posting published · unknown']);
  if (preEngagement) await expect(notices.locator("article strong")).toHaveText(["Pre-engagement changes requested · disabled", "Pre-engagement response · failed", "Pre-engagement requested · unknown"]);
  if (invitationResponse) await expect(notices.locator("article strong")).toHaveText(["Invitation acceptance withdrawn · disabled", "Invitation declined · failed", "Invitation accepted · unknown"]);
  if (applicationWithdrawal) await expect(notices.locator("article strong")).toHaveText(["Application withdrawn · disabled", "Application withdrawn · failed", "Application withdrawn · unknown"]);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle("theme-dark", value), dark);
      await page.evaluate(() => document.fonts.ready);
      await notices.scrollIntoViewIfNeeded();
      expect(await notices.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      for (const action of await notices.getByRole("button").all()) {
        // Firefox can subtract fractional page coordinates as 43.9999847 for
        // a 44px box. Check both layout height and rendered height to 0.001px.
        expect(await action.evaluate(el => el.offsetHeight)).toBeGreaterThanOrEqual(44);
        expect(Math.round((await action.boundingBox()).height * 1000) / 1000).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).include(".admin-communications").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`${kind}-email-${width}-${dark ? "dark" : "light"}.png`), fullPage: true });
    }
  }
  expect(await records()).toEqual(before);
  const button = notices.locator(`[data-delivery-retry="${ids[0]}"]`);
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Retry email notice" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: info.outputPath(`${kind}-email-review-dialog.png`), fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await records()).toEqual(before);
  await button.click();
  let body;
  page.on("request", req => { if (req.method() === "POST" && req.url().endsWith(`/communications/${kind}/${ids[0]}/retry`)) body = req.postDataJSON(); });
  await dialog.getByRole("button", { name: "I checked — queue attempt", exact: true }).click();
  await expect(fold.getByText("Another attempt is queued.", { exact: true })).toBeVisible();
  const after = await records(); expect(after[0]).toMatchObject({ status: "pending", attempts: 0 });
  expect(after.slice(1)).toEqual(before.slice(1));
  expect(body.confirmed).toBe(true); expect(body.revision).toMatch(/^[a-f0-9]{64}$/);
  const replay = await page.request.post(`/api/admin/workspace/communications/${kind}/${ids[0]}/retry`, { data: body });
  expect(replay.status()).toBe(409); expect(await records()).toEqual(after);
  await page.route("**/api/admin/workspace/communications", route => route.fulfill({ status: 503, json: { error: "Synthetic status outage" } }));
  await fold.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(fold.getByRole("alert")).toContainText("Communication status is unavailable.");
  await page.unroute("**/api/admin/workspace/communications");
  await fold.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(fold.getByText(heading, { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

if (!invitationResponse && !preEngagement && !posting) test(`${category} email has one direct Matter action and readable mobile content`, async ({ page }, info) => {
  const templates = require("../../../email/templates");
  const message = templates[invitation ? "caseInvite" : application ? applicationWithdrawal ? "applicationWithdrawn" : "applicationSubmitted" : resolution ? "reviewDecision" : review ? "reviewOpened" : payment ? "paymentAction" : withdrawal ? "withdrawalRequest" : "workReady"]({ role: "attorney", inviterName: "Dana Young", caseId: ACTIVE, applicantId: "650000000000000000000003", paralegalName: "Dana Young", disputeId: "synthetic-admin-review", summary: withdrawal ? "The paralegal withdrew. Review the completed work and choose a partial payout or close without release." : "Payment requires your attention.", caseTitle: "Lease review for Montgomery Harrington Rivera-Santiago and associated entities" });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<html lang="en"><head><title>${heading}</title></head><body><main>${message.html}</main></body></html>`);
    await expect(page.getByRole("link")).toHaveCount(1);
    await expect(page.getByRole("link", { name: invitation ? "View invitation" : application ? applicationWithdrawal ? "View application" : "Review application" : resolution ? "Review decision" : review ? "View review status" : payment ? "Review funding" : withdrawal ? "Review withdrawal" : "Open Matter", exact: true })).toHaveAttribute("href", invitation ? new RegExp(`/dashboard-paralegal.html[?]inviteCase=${ACTIVE}#home$`) : applicationWithdrawal ? new RegExp(`/dashboard-attorney.html[?]caseId=${ACTIVE}&applicantId=650000000000000000000003&openApplicant=1&applicationHistory=1#cases:inquiries$`) : new RegExp(`/case-detail.html\\?caseId=${ACTIVE}&tab=${application ? "applications&applicantId=650000000000000000000003" : review || payment || withdrawal ? "financials" : "work"}$`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${kind}-email-message-${width}.png`), fullPage: true });
  }
});

}

test('invitation response emails give each original recipient one readable action', async ({ page }, info) => {
  const templates = require('../../../email/templates');
  for (const [kind, self] of [['accepted', false], ['declined', false], ['declined', true], ['revoked', false], ['revoked', true]]) {
    const message = templates.caseInvitationResponse({ kind, self, caseId: ACTIVE, paralegalId: '650000000000000000000003', message: `${self ? 'You' : 'Dana Young'} ${kind === 'revoked' ? 'withdrew from consideration' : kind === 'accepted' ? 'accepted your invitation' : 'declined the invitation'} for the Montgomery Harrington Rivera-Santiago filing.` });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.setContent(`<html lang="en"><head><title>Invitation response</title></head><body><main>${message.html}</main></body></html>`);
      const link = page.getByRole('link'); await expect(link).toHaveCount(1);
      await expect(link).toHaveText(self ? 'Browse Matters' : kind === 'accepted' ? 'Continue hiring' : 'Review applications');
      const href = new URL(await link.getAttribute('href'));
      expect(href.pathname).toBe(self ? '/browse-jobs.html' : '/case-detail.html');
      if (!self) { expect(href.searchParams.get('caseId')).toBe(ACTIVE); expect(href.searchParams.get('tab')).toBe('applications'); }
      if (kind === 'accepted') expect(href.searchParams.get('applicantId')).toBe('650000000000000000000003');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`invitation-response-${kind}-${self ? 'paralegal' : 'attorney'}-${width}.png`), fullPage: true });
    }
  }
});

test("withdrawn paralegal email opens retained history with readable mobile content", async ({ page }, info) => {
  const message = require("../../../email/templates").withdrawalRequest({ caseId: ACTIVE, role: "paralegal", caseTitle: "Lease review for Montgomery Harrington Rivera-Santiago and associated entities", summary: "You withdrew from this Matter. The attorney's payout decision is pending." });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<html lang="en"><head><title>Withdrawal confirmation</title></head><body><main>${message.html}</main></body></html>`);
    await expect(page.getByRole("link")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "View Matter history", exact: true })).toHaveAttribute("href", new RegExp(`/dashboard-paralegal.html\\?highlightCase=${ACTIVE}#cases-completed$`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`withdrawal-paralegal-message-${width}.png`), fullPage: true });
  }
});

for (const outcome of ["review_window", "partial_recorded", "zero_recorded", "relisted", "expired_zero"]) {
  for (const role of ["attorney", "paralegal"]) {
    test(`withdrawal outcome ${outcome} email gives the ${role} one readable relevant action`, async ({ page }, info) => {
      const summary = require("../../../services/matterWithdrawalNotifications").withdrawalSummary(outcome, role);
      const message = require("../../../email/templates").withdrawalDecision({ caseId: ACTIVE, role, outcome, caseTitle: "Lease review for Montgomery Harrington Rivera-Santiago and associated entities", summary });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.setContent(`<html lang="en"><head><title>Withdrawal decision</title></head><body><main>${message.html}</main></body></html>`);
        await expect(page.getByText(summary, { exact: true })).toBeVisible();
        await expect(page.getByRole("link")).toHaveCount(1);
        const href = require("../../../services/objectDeepLinks").buildObjectDeepLink({ type: role === "attorney" ? "matter" : "completed_matter", caseId: ACTIVE, role, tab: "financials" });
        const destination = new URL(await page.getByRole("link").getAttribute("href"));
        expect(destination.pathname + destination.search + destination.hash).toBe(href);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
        await page.screenshot({ path: info.outputPath(`${outcome}-${role}-${width}.png`), fullPage: true });
      }
    });
  }
}

for (const role of ["attorney", "paralegal"]) test(`completion email gives the ${role} one readable retained Matter action`, async ({ page }, info) => {
  const message = require("../../../email/templates").completionNotice({ caseId: ACTIVE, role, caseTitle: "Lease review for Montgomery Harrington Rivera-Santiago and associated entities" });
  for (const width of [1280,390]) {
    await page.setViewportSize({ width, height:844 });
    await page.setContent(`<html lang="en"><head><title>Matter completed</title></head><body><main>${message.html}</main></body></html>`);
    await expect(page.getByText('Matter completed',{exact:true})).toBeVisible();await expect(page.getByRole('link')).toHaveCount(1);
    const href = role === 'attorney' ? `/case-detail.html?caseId=${ACTIVE}&tab=financials` : `/dashboard-paralegal.html?highlightCase=${ACTIVE}#cases-completed`;
    const destination = new URL(await page.getByRole('link').getAttribute('href'));expect(destination.pathname+destination.search+destination.hash).toBe(href);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`completion-${role}-${width}.png`),fullPage:true});
  }
});

test("administrator notice opens an exact review beyond page one and can return to the review queue", async ({ page }, info) => {
  await seed(); const target = 'synthetic-linked-review-31';
  await database(db => db.collection('cases').updateOne({ _id: new ObjectId(ACTIVE) }, { $set: { status: 'disputed', pausedReason: 'dispute', disputes: Array.from({ length: 31 }, (_, n) => ({ _id: new ObjectId(), disputeId: `synthetic-linked-review-${n + 1}`, message: `Distinct review details ${n + 1}`, status: 'open', raisedBy: new ObjectId('650000000000000000002001'), createdAt: new Date(2020, 0, n + 1) })) } }));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/admin-dashboard.html?review=${target}&reviewMatter=${ACTIVE}#finance`, { waitUntil: 'domcontentloaded' });
  const detail = page.locator('.admin-dispute-detail:not([hidden])');
  await expect(detail).toContainText('Distinct review details 31'); await expect(page.locator('#disputesBody tr[data-dispute-id]:not(.admin-dispute-detail)')).toHaveCount(1);
  for (const [name, width, dark, font] of [['desktop',1280,false,''],['phone',390,false,''],['phone-dark-large',390,true,'32px'],['narrow-dark',320,true,'']]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(({ dark, font }) => { for (const element of [document.documentElement, document.body]) element.classList.toggle('theme-dark',dark); document.documentElement.style.fontSize=font; }, {dark,font});
    const summary=page.locator('#disputesBody>.admin-dispute-summary'), review=summary.getByRole('button',{name:'Review dispute',exact:true});
    await summary.scrollIntoViewIfNeeded();
    expect(await summary.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
    expect((await review.boundingBox()).width).toBeGreaterThanOrEqual(100);
    expect((await review.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await new AxeBuilder({page}).include('.admin-dispute-table').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({path:info.outputPath(`review-summary-${name}.png`),fullPage:true});
    await review.focus(); await review.press('Enter'); await expect(detail).toBeHidden();
    await review.press('Enter'); await expect(detail).toBeVisible();
    await detail.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await page.getByRole('button', { name: 'Return to review queue', exact: true }).evaluate(el => el.offsetHeight)).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`linked-review-${name}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: 'Return to review queue', exact: true }).click();
  await expect(page.locator('#disputesBody tr[data-dispute-id]:not(.admin-dispute-detail)')).toHaveCount(25);
  expect(new URL(page.url()).searchParams.has('review')).toBe(false);
  expect(errors).toEqual([]);
});

for (const kind of ['requested', 'submitted', 'changes_requested']) test(`pre-engagement ${kind} email gives its recipient one readable application action`, async ({ page }, info) => {
  const applicationId = '650000000000000000000003';
  const message = require('../../../email/templates').preEngagementNotice({ kind, caseId: ACTIVE, paralegalId: applicationId, applicationId, caseTitle: 'Lease review for Montgomery Harrington Rivera-Santiago and associated entities' });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<html lang="en"><head><title>Pre-engagement</title></head><body><main>${message.html}</main></body></html>`);
    const link = page.getByRole('link'); await expect(link).toHaveCount(1); await expect(link).toHaveText(kind === 'submitted' ? 'Review response' : 'View requirements');
    const href = new URL(await link.getAttribute('href'));
    expect(href.pathname + href.search + href.hash).toBe(kind === 'submitted' ? `/case-detail.html?caseId=${ACTIVE}&tab=applications&applicantId=${applicationId}` : `/dashboard-paralegal.html?applicationId=${applicationId}#cases`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`pre-engagement-${kind}-${width}.png`), fullPage: true });
  }
});

for (const kind of ['created', 'updated', 'deleted', 'edits_requested', 'review_requested']) test(`posting ${kind} email identifies the retained event without a removed-Matter link`, async ({ page }, info) => {
  const templates = require('../../../email/templates'), caseTitle = 'Lease review for Montgomery Harrington Rivera-Santiago and associated entities';
  const destination = kind === 'updated' ? '/dashboard-paralegal.html?jobId=650000000000000000000003#cases' : kind === 'edits_requested' ? `/dashboard-attorney.html?previewCaseId=${ACTIVE}#cases` : '/admin-dashboard.html#posts';
  const message = kind === 'created' ? templates.adminJobPosted({ caseTitle, attorneyName: 'Dana Young', attorneyEmail: 'dana@example.test', practiceArea: 'Contract Law', budget: '$400.00' }) : kind === 'deleted' ? templates.caseDeleted({ caseTitle, recipientName: 'Dana', reason: 'Outside the permitted posting scope', message: 'Review the scope before posting again.' }) : templates.postingNotice({ kind, caseTitle, destination });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<html lang="en"><head><title>Posting notice</title></head><body><main>${message.html}</main></body></html>`);
    await expect(page.getByText(caseTitle, { exact: true })).toBeVisible();
    if (kind === 'deleted') { await expect(page.getByRole('link')).toHaveCount(0); await expect(page.getByText('Outside the permitted posting scope', { exact: true })).toBeVisible(); }
    else { const link = page.getByRole('link'); await expect(link).toHaveCount(1); const href = new URL(await link.getAttribute('href')); expect(href.pathname + href.search + href.hash).toBe(destination); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`posting-${kind}-${width}.png`), fullPage: true });
  }
});
