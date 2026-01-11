const BRAND_FONT = "'Sarabun', 'Helvetica Neue', Arial, sans-serif";
const GOLD = "#b4975a";
const INK = "#1a1a1a";

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
    const sender = payload.fromName || "an LPC user";
    const caseTitle = payload.caseTitle ? ` about <strong>${payload.caseTitle}</strong>` : "";
    const snippet = payload.messageSnippet ? `<p style="margin:14px 0;padding:16px;border-left:3px solid ${GOLD};background:#fbfaf7;">${payload.messageSnippet}</p>` : "";
    const html = frameEmail(
      "You received a new message",
      `<p>${sender} sent you a message${caseTitle}. Sign in to reply.</p>${snippet}`
    );
    return { subject: "New message on LPC", html };
  },
  caseInvite: (payload = {}) => {
    const inviter = payload.inviterName || "An attorney";
    const title = payload.caseTitle || "a case on LPC";
    const html = frameEmail(
      "New case invitation",
      `<p>${inviter} invited you to collaborate on <strong>${title}</strong>. Review the details and accept if it fits your workload.</p>`
    );
    return { subject: "You've been invited to a case", html };
  },
  caseUpdate: (payload = {}) => {
    const title = payload.caseTitle || "your case";
    const summary = payload.summary || "There is an update waiting for you.";
    const html = frameEmail(
      "Case update available",
      `<p>The case <strong>${title}</strong> has been updated.</p><p>${summary}</p>`
    );
    return { subject: "Case update on LPC", html };
  },
  profileApproved: () => {
    const html = frameEmail(
      "Your profile is approved",
      "<p>Congratulations&mdash;your profile is now live on Let&rsquo;s-ParaConnect. Attorneys can begin inviting you to cases immediately.</p><p>Keep your availability current to receive the best matches.</p>"
    );
    return { subject: "Welcome aboard! Your profile is approved", html };
  },
  payoutReleased: (payload = {}) => {
    const caseTitle = payload.caseTitle || "your case";
    const amount = payload.amount ? `<p style="font-size:18px;margin:18px 0;color:${GOLD};">Payout: <strong>${payload.amount}</strong></p>` : "";
    const html = frameEmail(
      "Your payout is on the way",
      `<p>Funds for <strong>${caseTitle}</strong> have been released to your account.${amount}</p><p>You will see the deposit in your bank per Stripe&rsquo;s normal timeline.</p>`
    );
    return { subject: "Payout released", html };
  },
  documentUploaded: (payload = {}) => {
    const doc = payload.documentName || "A document";
    const caseTitle = payload.caseTitle ? ` for <strong>${payload.caseTitle}</strong>` : "";
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
  systemAnnouncement: (payload = {}) => {
    const title = payload.title || "System announcement";
    const body = payload.message || "There is a new update available.";
    const html = frameEmail(title, `<p>${body}</p>`);
    return { subject: title, html };
  },
  digestSummary: ({ user, summary, period } = {}) => {
    const pref = period === "weekly" ? "Weekly" : "Daily";
    const sections = [
      { label: "Unread messages", count: summary?.unreadMessages || 0 },
      { label: "Pending invitations", count: summary?.pendingInvites || 0 },
      { label: "Case updates", count: summary?.caseUpdates || 0 },
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
          `<li style="margin-bottom:8px;">${formatRecentLabel(item)}</li>`
      )
      .join("");

    const body = `
      <p>${pref} snapshot for ${user?.firstName || "you"}:</p>
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
      return `Invitation to ${payload.caseTitle || "a case"}`;
    case "case_update":
      return `Update on ${payload.caseTitle || "a case"}`;
    case "case_invite_response":
      if (payload.response === "filled") {
        return `Invitation filled for ${payload.caseTitle || "a case"}`;
      }
      return `Invite ${payload.response || ""} by ${payload.paralegalName || "paralegal"}`;
    case "resume_uploaded":
      return "Resume uploaded";
    default:
      return payload.message || "Platform update";
  }
}

module.exports = templates;
