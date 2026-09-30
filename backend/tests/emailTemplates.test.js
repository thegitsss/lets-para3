const emailTemplates = require("../email/templates");
const { emailTemplate: notificationEmailTemplate } = require("../utils/notifyUser");

describe("customer email templates", () => {
  test("file notices link to the named file through the protected workspace", () => {
    const caseId = '64b000000000000000000991', fileId = '64b000000000000000000992';
    const template = notificationEmailTemplate('case_file_uploaded', { caseId, fileId, caseTitle: 'Lease review', fileName: 'Exhibit.txt', link: 'https://untrusted.example/other' });
    expect(template.html).toContain(`/case-detail.html?caseId=${caseId}&amp;tab=files&amp;fileId=${fileId}`);
    expect(template.html).toContain('View file');
    expect(template.html).not.toContain('untrusted.example');
    expect(template.html.match(/Exhibit\.txt/g)).toHaveLength(1);
    expect(template.html.match(/Lease review/g)).toHaveLength(1);
    expect(emailTemplates.documentUploaded({ caseId: 'invalid', fileId }).html).not.toContain('<a ');
    expect(emailTemplates.documentUploaded({ caseId, fileId: 'invalid' }).html).not.toContain('<a ');
  });

  test("file email links accept only an HTTP application origin without embedded credentials", () => {
    const before = process.env.EMAIL_BASE_URL;
    try {
      for (const base of ['javascript:alert(1)', 'https://user:password@example.test', 'not a URL']) {
        process.env.EMAIL_BASE_URL = base;
        expect(emailTemplates.documentUploaded({ caseId: '64b000000000000000000991', fileId: '64b000000000000000000992' }).html).not.toContain('<a ');
      }
      process.env.EMAIL_BASE_URL = 'https://app.example.test/prefix?unrelated=yes#fragment';
      expect(emailTemplates.documentUploaded({ caseId: '64b000000000000000000991', fileId: '64b000000000000000000992' }).html).toContain('href="https://app.example.test/case-detail.html?');
    } finally { if (before === undefined) delete process.env.EMAIL_BASE_URL; else process.env.EMAIL_BASE_URL = before; }
  });

  test("escapes user-controlled values before inserting them into HTML", () => {
    const attack = '<img src=x onerror="alert(1)">';
    const rendered = [
      emailTemplates.newMessage({ fromName: attack, caseTitle: attack, messageSnippet: attack }),
      emailTemplates.completionNotice({ caseTitle: attack, role: "attorney" }),
      emailTemplates.caseInvite({ inviterName: attack, caseTitle: attack }),
      emailTemplates.caseUpdate({ caseTitle: attack, summary: attack }),
      emailTemplates.withdrawalRequest({ caseTitle: attack, summary: attack }),
      emailTemplates.withdrawalDecision({ caseTitle: attack, summary: attack }),
      emailTemplates.paymentAction({ caseTitle: attack, summary: attack }),
      emailTemplates.payoutReleased({ caseTitle: attack, recipientName: attack, amount: attack }),
      emailTemplates.caseCompletedAttorney({ caseTitle: attack, attorneyName: attack, completedDate: attack }),
      emailTemplates.documentUploaded({ documentName: attack, caseTitle: attack }),
      emailTemplates.accountSuspended({ recipientName: attack, reason: attack, message: attack }),
      emailTemplates.caseDeleted({ recipientName: attack, caseTitle: attack, reason: attack, message: attack }),
      emailTemplates.systemAnnouncement({ title: attack, message: attack }),
      emailTemplates.digestSummary({
        user: { firstName: attack },
        summary: { recent: [{ type: "case_update", payload: { caseTitle: attack } }] },
        period: "daily",
      }),
    ];

    for (const template of rendered) {
      expect(template.html).not.toContain("<img src=x");
      expect(template.html).toContain("&lt;img src=x");
    }
  });

  test("strips subject-header line breaks from dynamic subjects", () => {
    const admin = emailTemplates.adminJobPosted({ caseTitle: "Matter\r\nBcc: attacker@example.com" });
    const announcement = emailTemplates.systemAnnouncement({ title: "Notice\nBcc: attacker@example.com" });

    expect(admin.subject).toBe("New attorney Matter posted: Matter Bcc: attacker@example.com");
    expect(announcement.subject).toBe("Notice Bcc: attacker@example.com");
    expect(admin.subject).not.toMatch(/[\r\n]/);
    expect(announcement.subject).not.toMatch(/[\r\n]/);
    expect(emailTemplates.paymentAction({ caseTitle: "Matter\r\nBcc: attacker@example.com" }).subject).not.toMatch(/[\r\n]/);
  });

  test("payment notices have one trusted funding action and no broken fallback link", () => {
    const caseId = "64b000000000000000000991";
    const template = emailTemplates.paymentAction({ caseId, caseTitle: "Lease review", summary: "Payment requires your attention.", link: "https://untrusted.example/other" });
    expect(template.html.match(/<a /g)).toHaveLength(1);
    expect(template.html).toContain(`/case-detail.html?caseId=${caseId}&amp;tab=financials`);
    expect(template.html).not.toContain("untrusted.example");
    expect(template.html.match(/Lease review/g)).toHaveLength(1);
    expect(emailTemplates.paymentAction({ caseId: "invalid" }).html).not.toContain("<a ");
  });

  test("describes processor release without claiming bank receipt or fixed arrival timing", () => {
    const template = emailTemplates.payoutReleased({
      caseTitle: "Smith Matter",
      amount: "$820.00",
      totalDisplay: "$1,000.00",
      feeDisplay: "$180.00",
      feePct: 18,
    });

    expect(template.subject).toBe("Your payout was released to Stripe");
    expect(template.html).toMatch(/released to Stripe/i);
    expect(template.html).toMatch(/estimated bank arrival/i);
    expect(template.html).toMatch(/Matter total/);
    expect(template.html).not.toMatch(/payout is complete|reached your bank|\b\d+[–-]\d+\s+(?:business )?days/i);
  });

  test("uses approval and Matter language without unsupported placement claims", () => {
    const templates = [
      emailTemplates.caseInvite(),
      emailTemplates.caseUpdate(),
      emailTemplates.adminJobPosted(),
      emailTemplates.profileApproved(),
      emailTemplates.caseCompletedAttorney(),
      emailTemplates.caseDeleted(),
    ];
    const combined = templates.map((template) => `${template.subject}\n${template.html}`).join("\n");

    expect(combined).toMatch(/Matter invitation|Matter update|Matter posted|approved/);
    expect(combined).not.toMatch(/vetted paralegals?|elite paralegals?|best matches|inviting you to cases/i);
  });

  test("escapes notification-email payloads and normalizes dynamic subjects", () => {
    const attack = '<svg onload="alert(1)">';
    const payload = {
      response: "accepted",
      paralegalName: attack,
      caseTitle: `${attack}\r\nBcc: attacker@example.com`,
      title: attack,
      fileName: attack,
      message: attack,
      resolution: attack,
      receiptNote: attack,
      recipientName: attack,
      reason: attack,
      customNote: attack,
    };
    const rendered = [
      notificationEmailTemplate("message", { fromName: attack, caseTitle: attack }),
      notificationEmailTemplate("case_invite", payload),
      notificationEmailTemplate("case_invite_response", payload),
      notificationEmailTemplate("application_submitted", payload),
      notificationEmailTemplate("application_accepted", payload),
      notificationEmailTemplate("application_denied", payload),
      notificationEmailTemplate("case_awaiting_funding", payload),
      notificationEmailTemplate("case_work_ready", payload),
      notificationEmailTemplate("pre_engagement_requested", payload),
      notificationEmailTemplate("pre_engagement_submitted", payload),
      notificationEmailTemplate("pre_engagement_changes_requested", payload),
      notificationEmailTemplate("case_file_uploaded", payload),
      notificationEmailTemplate("dispute_resolved", payload),
      notificationEmailTemplate("dispute_opened", payload),
      notificationEmailTemplate("admin_review_overdue", payload),
      notificationEmailTemplate("account_suspended", payload),
      notificationEmailTemplate("case_deleted", payload),
    ];

    for (const template of rendered) {
      expect(template.html).not.toContain("<svg onload");
      expect(template.subject).not.toMatch(/[\r\n]/);
    }
    expect(rendered.some((template) => template.html.includes("&lt;svg onload"))).toBe(true);
  });
});


describe('email context boundaries', () => {
  test('photo approval and résumé upload do not imply overall readiness', () => {
    expect(notificationEmailTemplate('profile_photo_approved').html).not.toMatch(/now visible|now live|early group/i);
    expect(emailTemplates.resumeUpdated().html).not.toMatch(/set to apply|ready to apply/i);
    expect(emailTemplates.profileApproved().html).not.toMatch(/now live|now find your profile/i);
  });
  test('a review decision does not invent a receipt', () => {
    const html = notificationEmailTemplate('dispute_resolved', { caseTitle: 'Lease review' }).html;
    expect(html).toContain('decision and any payment details');
    expect(html).not.toContain('A receipt is available');
  });
  test('completion without a supplied date does not invent today', () => {
    expect(emailTemplates.caseCompletedAttorney({ caseTitle: 'Lease review' }).html).not.toContain('today');
    expect(emailTemplates.caseCompletedAttorney({ completedDate: 'September 27, 2026' }).html).toContain('September 27, 2026');
  });
});
