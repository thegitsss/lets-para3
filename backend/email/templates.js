const BRAND_FONT = "'Sarabun', 'Helvetica Neue', Arial, sans-serif";
const GOLD = "#b4975a";
const INK = "#1a1a1a";

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function subjectText(value = "", fallback = "Platform update") {
  const normalized = String(value || fallback)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || fallback).slice(0, 200);
}

function frameEmail(title, body) {
  return `
<div style="background:#f7f5f0;padding:32px 0;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid rgba(0,0,0,0.06);border-radius:18px;font-family:${BRAND_FONT};color:${INK};">
    <tr>
      <td style="padding:32px 36px;">
        <h2 style="margin:0 0 12px;font-weight:300;color:${GOLD};letter-spacing:0.5px;">Let&rsquo;s-ParaConnect</h2>
        <p style="margin:0 0 18px;font-size:20px;font-weight:300;color:${INK};">${title}</p>
        <div style="font-size:15px;line-height:1.6;font-weight:200;">${body}</div>
        <div style="margin-top:24px;font-size:13px;color:#8a8373;">&mdash; The LPC Team</div>
      </td>
    </tr>
  </table>
</div>`.trim();
}

const templates = {
  newMessage: (payload = {}) => {
    const sender = escapeHtml(payload.fromName || "an LPC user");
    const caseTitle = payload.caseTitle ? ` about <strong>${escapeHtml(payload.caseTitle)}</strong>` : "";
    const snippet = payload.messageSnippet ? `<p style="margin:14px 0;padding:16px;border-left:3px solid ${GOLD};background:#fbfaf7;">${escapeHtml(payload.messageSnippet)}</p>` : "";
    const html = frameEmail(
      "You received a new message",
      `<p>${sender} sent you a message${caseTitle}. Sign in to reply.</p>${snippet}`
    );
    return { subject: "New message on LPC", html };
  },
  caseInvite: (payload = {}) => {
    const inviter = escapeHtml(payload.inviterName || "An attorney");
    const title = escapeHtml(payload.caseTitle || "a Matter on LPC");
    const html = frameEmail(
      "New Matter invitation",
      `<p>${inviter} invited you to collaborate on <strong>${title}</strong>. Review the details and accept if it fits your workload.</p>`
    );
    return { subject: "You've been invited to a Matter", html };
  },
  caseUpdate: (payload = {}) => {
    const title = escapeHtml(payload.caseTitle || "your Matter");
    const summary = escapeHtml(payload.summary || "There is an update waiting for you.");
    const html = frameEmail(
      "Matter update available",
      `<p>The Matter <strong>${title}</strong> has been updated.</p><p>${summary}</p>`
    );
    return { subject: "Matter update on LPC", html };
  },
  adminJobPosted: (payload = {}) => {
    const title = escapeHtml(payload.caseTitle || "Untitled Matter");
    const attorneyName = escapeHtml(payload.attorneyName || "An attorney");
    const attorneyEmail = escapeHtml(payload.attorneyEmail || "");
    const practiceArea = escapeHtml(payload.practiceArea || "Not specified");
    const budget = escapeHtml(payload.budget || "Not specified");
    const link = escapeHtml(payload.link || "admin-dashboard.html#posts");
    const html = frameEmail(
      "New attorney Matter posted",
      `<p><strong>${attorneyName}</strong>${attorneyEmail ? ` (${attorneyEmail})` : ""} posted a new Matter.</p>
       <div style="margin:16px 0 18px;padding:16px;border:1px solid rgba(0,0,0,0.06);border-radius:14px;background:#fbfaf7;">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Matter</div>
         <div style="font-size:16px;font-weight:600;color:${INK};margin-top:4px;">${title}</div>
         <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Practice area</div>
         <div style="font-size:15px;color:${INK};margin-top:4px;">${practiceArea}</div>
         <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Budget</div>
         <div style="font-size:15px;color:${INK};margin-top:4px;">${budget}</div>
       </div>
       <p><a href="${link}" style="color:${GOLD};font-weight:600;">Review Matter posting in Admin</a></p>`
    );
    return { subject: subjectText(`New attorney Matter posted: ${payload.caseTitle || "Untitled Matter"}`), html };
  },
  profileApproved: () => {
    const html = frameEmail(
      "Your profile is approved",
      "<p>Congratulations&mdash;your profile is now live on Let&rsquo;s-ParaConnect. Attorneys can now find your profile and invite you to open Matters.</p><p>Keep your availability current so attorneys see accurate information.</p>"
    );
    return { subject: "Welcome aboard! Your profile is approved", html };
  },
  payoutReleased: (payload = {}) => {
    const caseTitle = escapeHtml(payload.caseTitle || "your Matter");
    const totalDisplay = escapeHtml(payload.totalDisplay || "");
    const feeDisplay = escapeHtml(payload.feeDisplay || "");
    const feePct = payload.feePct;
    const recipientName = escapeHtml(payload.recipientName || "");
    const amount = escapeHtml(payload.amount || "");
    const amountLine = payload.amount
      ? `<div style="font-size:18px;color:${GOLD};font-weight:600;margin-top:6px;">${amount}</div>`
      : `<div style="font-size:18px;color:${GOLD};font-weight:600;margin-top:6px;">Released to Stripe</div>`;
    const greeting = recipientName ? `<p>Hi ${recipientName},</p>` : "";
    const breakdown =
      totalDisplay || feeDisplay
        ? `
        <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Breakdown</div>
        <div style="margin-top:6px;font-size:14px;color:${INK};line-height:1.5;">
          ${totalDisplay ? `<div>Matter total: ${totalDisplay}</div>` : ""}
          ${feeDisplay ? `<div>Platform fee${Number.isFinite(feePct) ? ` (${feePct}%)` : ""}: ${feeDisplay}</div>` : ""}
        </div>
      `
        : "";
    const html = frameEmail(
      "Your payout was released to Stripe",
      `${greeting}<p>Your payout for <strong>${caseTitle}</strong> was released to Stripe.</p>
      <div style="margin:16px 0 18px;padding:16px;border:1px solid rgba(0,0,0,0.06);border-radius:14px;background:#fbfaf7;">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Status</div>
        <div style="font-size:16px;font-weight:600;color:${INK};margin-top:4px;">Released to Stripe</div>
        <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Matter</div>
        <div style="font-size:15px;color:${INK};margin-top:4px;">${caseTitle}</div>
        <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Payout</div>
        ${amountLine}
        ${breakdown}
      </div>
      <p style="margin:0;">Check your Stripe account for the current payout status and estimated arrival. Timing depends on your payout schedule and financial institution.</p>`
    );
    return { subject: "Your payout was released to Stripe", html };
  },
  caseCompletedAttorney: (payload = {}) => {
    const caseTitle = escapeHtml(payload.caseTitle || "your Matter");
    const attorneyName = escapeHtml(payload.attorneyName || "there");
    const completedDate = escapeHtml(payload.completedDate || "today");
    const html = frameEmail(
      "Your Matter has been completed",
      `<p>Hi ${attorneyName},</p>
       <p>Your Matter <strong>${caseTitle}</strong> was completed on <strong>${completedDate}</strong>.</p>
       <div style="margin:16px 0 18px;padding:16px;border:1px solid rgba(0,0,0,0.06);border-radius:14px;background:#fbfaf7;">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Status</div>
         <div style="font-size:16px;font-weight:600;color:${INK};margin-top:4px;">Completed</div>
         <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Matter</div>
         <div style="font-size:15px;color:${INK};margin-top:4px;">${caseTitle}</div>
         <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Completed on</div>
         <div style="font-size:15px;color:${INK};margin-top:4px;">${completedDate}</div>
       </div>
       <p style="margin:0;">Deliverables will remain available in your account for six (6) months. Please download and save any files you wish to retain.</p>`
    );
    return { subject: "Your Matter has been completed", html };
  },
  documentUploaded: (payload = {}) => {
    const doc = escapeHtml(payload.documentName || "A document");
    const caseTitle = payload.caseTitle ? ` for <strong>${escapeHtml(payload.caseTitle)}</strong>` : "";
    const html = frameEmail(
      "New document uploaded",
      `<p>${doc} has been uploaded${caseTitle}. Review it in your workspace.</p>`
    );
    return { subject: "Document uploaded", html };
  },
  resumeUpdated: () => {
    const html = frameEmail(
      "Resume uploaded successfully",
      "<p>Your resume has been received and attached to your profile. You&rsquo;re set to apply for new opportunities.</p>"
    );
    return { subject: "Resume updated", html };
  },
  accountSuspended: (payload = {}) => {
    const name = escapeHtml(payload.recipientName || "");
    const reason = escapeHtml(payload.reason || "Policy review");
    const custom = escapeHtml(payload.message || "");
    const greeting = name ? `<p>Hi ${name},</p>` : "";
    const noteBlock = custom
      ? `<p style="margin-top:12px;padding:12px 14px;border-left:3px solid ${GOLD};background:#fbfaf7;">${custom}</p>`
      : "";
    const html = frameEmail(
      "Account suspended",
      `${greeting}
       <p>Your Let&rsquo;s-ParaConnect account has been suspended.</p>
       <div style="margin:16px 0 14px;padding:14px;border:1px solid rgba(0,0,0,0.06);border-radius:14px;background:#ffffff;">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Reason</div>
         <div style="font-size:15px;color:${INK};margin-top:6px;">${reason}</div>
       </div>
       ${noteBlock}
       <p>If you believe this was in error, please reply to this email so our team can review.</p>`
    );
    return { subject: "Your LPC account has been suspended", html };
  },
  caseDeleted: (payload = {}) => {
    const name = escapeHtml(payload.recipientName || "");
    const caseTitle = escapeHtml(payload.caseTitle || "your Matter");
    const reason = escapeHtml(payload.reason || "Policy review");
    const custom = escapeHtml(payload.message || "");
    const greeting = name ? `<p>Hi ${name},</p>` : "";
    const noteBlock = custom
      ? `<p style="margin-top:12px;padding:12px 14px;border-left:3px solid ${GOLD};background:#fbfaf7;">${custom}</p>`
      : "";
    const html = frameEmail(
      "Matter posting removed",
      `${greeting}
       <p>Your Matter posting <strong>${caseTitle}</strong> has been removed by the LPC admin team.</p>
       <div style="margin:16px 0 14px;padding:14px;border:1px solid rgba(0,0,0,0.06);border-radius:14px;background:#ffffff;">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;">Reason</div>
         <div style="font-size:15px;color:${INK};margin-top:6px;">${reason}</div>
       </div>
       ${noteBlock}
       <p>If you have questions, please reply to this email.</p>`
    );
    return { subject: "Your Matter posting was removed", html };
  },
  systemAnnouncement: (payload = {}) => {
    const subject = subjectText(payload.title, "Platform update");
    const title = escapeHtml(subject);
    const body = escapeHtml(payload.message || "There is a new update available.");
    const html = frameEmail(title, `<p>${body}</p>`);
    return { subject, html };
  },
  digestSummary: ({ user, summary, period } = {}) => {
    const pref = period === "weekly" ? "Weekly" : "Daily";
    const sections = [
      { label: "Unread messages", count: summary?.unreadMessages || 0 },
      { label: "Pending invitations", count: summary?.pendingInvites || 0 },
      { label: "Matter updates", count: summary?.caseUpdates || 0 },
      { label: "Reminders", count: summary?.reminders || 0 },
    ].filter((section) => section.count > 0);
    const countsHtml = sections
      .map(
        (section) =>
          `<div style="padding:12px 16px;border:1px solid rgba(0,0,0,0.06);border-radius:12px;margin-bottom:10px;">
            <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;margin-bottom:4px;">${section.label}</div>
            <div style="font-size:22px;color:${GOLD};font-weight:300;">${section.count}</div>
          </div>`
      )
      .join("");

    const recentHtml = (summary?.recent || [])
      .map(
        (item) =>
          `<li style="margin-bottom:8px;">${escapeHtml(formatRecentLabel(item))}</li>`
      )
      .join("");

    const body = `
      <p>${pref} snapshot for ${escapeHtml(user?.firstName || "you")}:</p>
      ${countsHtml || "<p>No new activity since your last digest.</p>"}
      ${
        recentHtml
          ? `<div style="margin-top:18px;">
          <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#8a8373;margin-bottom:6px;">Recent activity</div>
          <ul style="padding-left:18px;margin:0;font-size:15px;font-weight:200;">${recentHtml}</ul>
        </div>`
          : ""
      }
      <p style="margin-top:18px;">Visit your dashboard to respond or adjust your digest preferences.</p>
    `;
    return { subject: `Your ${pref} LPC digest`, html: frameEmail(`${pref} digest`, body) };
  },
};

function formatRecentLabel(item = {}) {
  const payload = item.payload || {};
  switch (item.type) {
    case "message":
      return `Message from ${payload.fromName || "a user"}`;
    case "case_invite":
      return `Invitation to ${payload.caseTitle || "a Matter"}`;
    case "case_update":
      return `Update on ${payload.caseTitle || "a Matter"}`;
    case "case_invite_response":
      if (payload.response === "filled") {
        return `Invitation filled for ${payload.caseTitle || "a Matter"}`;
      }
      return `Invite ${payload.response || ""} by ${payload.paralegalName || "paralegal"}`;
    case "resume_uploaded":
      return "Resume uploaded";
    default:
      return payload.message || "Platform update";
  }
}

module.exports = templates;
