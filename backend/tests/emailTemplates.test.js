const emailTemplates = require("../email/templates");
const { emailTemplate: notificationEmailTemplate } = require("../utils/notifyUser");

describe("customer email templates", () => {
  test("escapes user-controlled values before inserting them into HTML", () => {
    const attack = '<img src=x onerror="alert(1)">';
    const rendered = [
      emailTemplates.newMessage({ fromName: attack, caseTitle: attack, messageSnippet: attack }),
      emailTemplates.caseInvite({ inviterName: attack, caseTitle: attack }),
      emailTemplates.caseUpdate({ caseTitle: attack, summary: attack }),
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
    expect(template.html).toMatch(/current payout status and estimated arrival/i);
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
