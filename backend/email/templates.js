const { letterEmail } = require("./layout");
const GOLD = "#507bc5";
const INK = "#596579";
const { buildObjectDeepLink, normalizeId } = require("../services/objectDeepLinks");

function documentLink(payload) {
  if (!normalizeId(payload.caseId) || !normalizeId(payload.fileId)) return "";
  const destination = buildObjectDeepLink({ type: "file", caseId: payload.caseId, fileId: payload.fileId });
  return platformLink(destination);
}
function platformLink(destination) {
  try {
    const base = new URL(process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || "https://www.lets-paraconnect.com");
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) return "";
    return new URL(destination, base.origin).href;
  } catch { return ""; }
}

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
  return letterEmail(`<p>${title}</p>${body}`, { title });
}

const templates = {
  postingNotice: (payload = {}) => {
    const edits = payload.kind === 'edits_requested', review = payload.kind === 'review_requested';
    const title = edits ? 'Posting revisions requested' : review ? 'Revised posting ready for admin review' : 'The posting you applied to changed';
    const text = edits ? 'LPC requested revisions to your posting' : review ? 'The attorney requested admin review of the revised posting' : 'The attorney updated the posting you applied to';
    const label = edits ? 'Review requested revisions' : review ? 'Review posting' : 'View application';
    const link = payload.destination ? platformLink(payload.destination) : '';
    return { subject: subjectText(`${title}: ${payload.caseTitle || 'your Matter'}`), html: frameEmail(title, `<p>${text} for <strong>${escapeHtml(payload.caseTitle || 'this Matter')}</strong>.</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">${label}</a></p>` : ''}`) };
  },
  preEngagementNotice: (payload = {}) => {
    const submitted = payload.kind === 'submitted', changes = payload.kind === 'changes_requested';
    const title = submitted ? 'Pre-engagement response ready for review' : changes ? 'Pre-engagement changes requested' : 'Pre-engagement requested';
    const destination = submitted
      ? buildObjectDeepLink({ type: 'application', caseId: payload.caseId, applicantId: payload.paralegalId })
      : buildObjectDeepLink({ type: 'paralegal_application', applicationId: payload.applicationId, jobId: payload.jobId });
    const link = destination ? platformLink(destination) : '';
    const text = submitted ? 'A pre-engagement response is ready for your review' : changes ? 'The attorney requested changes to your pre-engagement response' : 'The attorney requested pre-engagement items';
    const label = submitted ? 'Review response' : 'View requirements';
    const html = frameEmail(title, `<p>${text} for <strong>${escapeHtml(payload.caseTitle || 'this Matter')}</strong>.</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">${label}</a></p>` : '<p>Sign in to review the saved requirements.</p>'}`);
    return { subject: subjectText(`${title}: ${payload.caseTitle || 'your Matter'}`), html };
  },
  caseInvitationResponse: (payload = {}) => {
    const accepted = payload.kind === 'accepted';
    const destination = payload.self ? '/browse-jobs.html' : accepted
      ? buildObjectDeepLink({ type: 'application', caseId: payload.caseId, applicantId: payload.paralegalId })
      : buildObjectDeepLink({ type: 'matter', caseId: payload.caseId, tab: 'applications' });
    const link = destination ? platformLink(destination) : '';
    const label = payload.self ? 'Browse Matters' : accepted ? 'Continue hiring' : 'Review applications';
    const title = accepted ? 'Invitation accepted' : payload.kind === 'revoked' ? 'Invitation acceptance withdrawn' : 'Invitation declined';
    const html = frameEmail(title, `<p>${escapeHtml(payload.message)}</p>${accepted ? '<p>Confirm the hire and fund the Matter to get started.</p>' : ''}${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">${label}</a></p>` : '<p>Sign in to view your Matters.</p>'}`);
    return { subject: title, html };
  },
  applicationWithdrawn: (payload = {}) => {
    const destination = buildObjectDeepLink({ type: "retained_application", caseId: payload.caseId, applicantId: payload.applicantId });
    const link = destination ? platformLink(destination) : "";
    const html = frameEmail("Application withdrawn", `<p>${escapeHtml(payload.paralegalName || "A paralegal")} withdrew their application for <strong>${escapeHtml(payload.caseTitle || "your Matter")}</strong>.</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">View application</a></p>` : '<p>Sign in to view your applications.</p>'}`);
    return { subject: subjectText(`Application withdrawn: ${payload.caseTitle || "your Matter"}`), html };
  },
  applicationSubmitted: (payload = {}) => {
    const destination = buildObjectDeepLink({ type: "application", caseId: payload.caseId, applicantId: payload.applicantId });
    const link = destination ? platformLink(destination) : "";
    const html = frameEmail("Application received", `<p>${escapeHtml(payload.paralegalName || "A paralegal")} applied to <strong>${escapeHtml(payload.caseTitle || "your Matter")}</strong>.</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">Review application</a></p>` : '<p>Sign in to review your applications.</p>'}`);
    return { subject: subjectText(`Application received: ${payload.caseTitle || "your Matter"}`), html };
  },
  reviewOverdue: (payload = {}) => {
    const destination = buildObjectDeepLink({ type: "matter_review", caseId: payload.caseId, disputeId: payload.disputeId, role: payload.role, retained: payload.retained });
    const link = normalizeId(payload.caseId) ? platformLink(destination) : "";
    const html = frameEmail("LPC review still open", `<p><strong>${escapeHtml(payload.caseTitle || "Your Matter")}</strong></p><p>No decision is recorded for this review. Sign in to read its current status.</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">View review status</a></p>` : ""}`);
    return { subject: subjectText(`Review still open: ${payload.caseTitle || "your Matter"}`), html };
  },
  reviewDecision: (payload = {}) => {
    const destination = buildObjectDeepLink({ type: payload.retained ? "completed_matter" : "financials", caseId: payload.caseId, role: payload.role });
    const link = normalizeId(payload.caseId) ? platformLink(destination) : "";
    const html = frameEmail("Review decision recorded", `<p><strong>${escapeHtml(payload.caseTitle || "Your Matter")}</strong></p><p>LPC recorded a decision on this Matter. Sign in to review the outcome and payment details.</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">${payload.retained ? "View Matter history" : "Review decision"}</a></p>` : ""}`);
    return { subject: subjectText(`Review decision: ${payload.caseTitle || "your Matter"}`), html };
  },
  reviewOpened: (payload = {}) => {
    const destination = buildObjectDeepLink({ type: "matter_review", caseId: payload.caseId, disputeId: payload.disputeId, role: payload.role, retained: payload.retained });
    const link = normalizeId(payload.caseId) ? platformLink(destination) : "";
    const summary = payload.role === "admin" ? "A Matter review is awaiting an administrator's decision. Sign in to read its record." : "A review is open for this Matter. Sign in to read its status.";
    const html = frameEmail("Matter review opened", `<p><strong>${escapeHtml(payload.caseTitle || "Your Matter")}</strong></p><p>${summary}</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">View review status</a></p>` : ""}`);
    return { subject: subjectText(`Review opened: ${payload.caseTitle || "your Matter"}`), html };
  },
  completionNotice: (payload = {}) => {
    const attorney = payload.role === "attorney";
    const destination = buildObjectDeepLink({ type: attorney ? "matter" : "completed_matter", caseId: payload.caseId, role: payload.role, tab: "financials" });
    const link = normalizeId(payload.caseId) ? platformLink(destination) : "";
    const summary = attorney ? "Review the final payment and retained records in your Matter." : "The payout was released to Stripe. Review your payment details in Matter history; bank arrival depends on your Stripe payout schedule and financial institution.";
    const html = frameEmail("Matter completed", `<p><strong>${escapeHtml(payload.caseTitle || "Your Matter")}</strong></p><p>${summary}</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">${attorney ? "Review completed Matter" : "View Matter history"}</a></p>` : ""}`);
    return { subject: subjectText(`Matter completed: ${payload.caseTitle || "your Matter"}`), html };
  },
  paymentAction: (payload = {}) => {
    const link = normalizeId(payload.caseId) ? platformLink(buildObjectDeepLink({ type: "matter", caseId: payload.caseId, tab: "financials" })) : "";
    const html = frameEmail(escapeHtml(payload.summary || "Payment requires your attention."), `<p><strong>${escapeHtml(payload.caseTitle || "Your Matter")}</strong></p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${INK};font-weight:600;">Review funding</a></p>` : '<p>Sign in to review funding.</p>'}`);
    return { subject: subjectText(`Payment update: ${payload.caseTitle || "your Matter"}`), html };
  },
  workReady: (payload = {}) => {
    const link = normalizeId(payload.caseId) ? platformLink(buildObjectDeepLink({ type: "matter", caseId: payload.caseId, tab: "work" })) : "";
    const html = frameEmail("Ready to begin", `<p><strong>${escapeHtml(payload.caseTitle || "Your Matter")}</strong> is funded.</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${INK};font-weight:600;">Open Matter</a></p>` : '<p>Sign in to open your Matter.</p>'}`);
    return { subject: subjectText(`Work can begin on ${payload.caseTitle || "your Matter"}`), html };
  },
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
    const destination = buildObjectDeepLink({ type: "invitation", caseId: payload.caseId });
    const link = destination ? platformLink(destination) : "";
    const html = frameEmail(
      "Matter invitation",
      `<p>${inviter} invited you to consider <strong>${title}</strong>.</p><p>Review the scope and amount before responding. Accepting an invitation does not assign the Matter to you.</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">View invitation</a></p>` : ""}`
    );
    return { subject: "Matter invitation on LPC", html };
  },
  withdrawalRequest: (payload = {}) => {
    const attorney = payload.role === "attorney";
    const destination = buildObjectDeepLink({ type: attorney ? "matter" : "completed_matter", caseId: payload.caseId, role: payload.role, tab: "financials" });
    const link = normalizeId(payload.caseId) ? platformLink(destination) : "";
    const html = frameEmail("Paralegal withdrawal", `<p><strong>${escapeHtml(payload.caseTitle || "Your Matter")}</strong></p><p>${escapeHtml(payload.summary || "A withdrawal was recorded.")}</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">${attorney ? "Review withdrawal" : "View Matter history"}</a></p>` : ""}`);
    return { subject: "Paralegal withdrawal on LPC", html };
  },
  withdrawalDecision: (payload = {}) => {
    const attorney = payload.role === "attorney";
    const heading = payload.outcome === "review_window" ? "Withdrawal payment review" : payload.outcome === "relisted" ? "Matter relisted" : payload.outcome === "expired_zero" ? "Withdrawal review ended" : "Withdrawal decision recorded";
    const destination = buildObjectDeepLink({ type: attorney ? "matter" : "completed_matter", caseId: payload.caseId, role: payload.role, tab: "financials" });
    const link = normalizeId(payload.caseId) ? platformLink(destination) : "";
    const html = frameEmail(heading, `<p><strong>${escapeHtml(payload.caseTitle || "Your Matter")}</strong></p><p>${escapeHtml(payload.summary || "A withdrawal decision was recorded.")}</p>${link ? `<p><a href="${escapeHtml(link)}" style="color:${GOLD};font-weight:600;">${attorney ? "Review withdrawal" : "View Matter history"}</a></p>` : ""}`);
    return { subject: `${heading} on LPC`, html };
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
    const link = escapeHtml(payload.link || platformLink("/admin-dashboard.html#posts"));
    const html = frameEmail(
      "New attorney Matter posted",
      `<p><strong>${attorneyName}</strong>${attorneyEmail ? ` (${attorneyEmail})` : ""} posted a new Matter.</p>
       <div style="margin:16px 0 18px;padding:16px;border:1px solid rgba(0,0,0,0.06);border-radius:14px;background:#fbfaf7;">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6f695e;">Matter</div>
         <div style="font-size:16px;font-weight:600;color:${INK};margin-top:4px;">${title}</div>
         <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6f695e;">Practice area</div>
         <div style="font-size:15px;color:${INK};margin-top:4px;">${practiceArea}</div>
         <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6f695e;">Budget</div>
         <div style="font-size:15px;color:${INK};margin-top:4px;">${budget}</div>
       </div>
       <p><a href="${link}" style="color:${GOLD};font-weight:600;">Review Matter posting in Admin</a></p>`
    );
    return { subject: subjectText(`New attorney Matter posted: ${payload.caseTitle || "Untitled Matter"}`), html };
  },
  profileApproved: () => {
    const html = frameEmail(
      "Your profile is approved",
      "<p>Your profile has been approved.</p><p>Sign in to review your profile details and keep your availability current.</p>"
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
    const greeting = recipientName ? `<p>Hi ${recipientName},</p>` : "";
    const breakdown = totalDisplay || feeDisplay
      ? `<p>${totalDisplay ? `Matter total: ${totalDisplay}` : ""}${totalDisplay && feeDisplay ? "<br>" : ""}${feeDisplay ? `Platform fee${Number.isFinite(feePct) ? ` (${feePct}%)` : ""}: ${feeDisplay}` : ""}</p>`
      : "";
    const html = letterEmail(
      `${greeting}<p>Your payout${amount ? ` of <strong>${amount}</strong>` : ""} for <strong>${caseTitle}</strong> was released to Stripe.</p>
      ${breakdown}
      <p>Check Stripe for your estimated bank arrival. Timing depends on your payout schedule and bank.</p>`,
      { title: "Payout update" }
    );
    return { subject: "Your payout was released to Stripe", html };
  },
  caseCompletedAttorney: (payload = {}) => {
    const caseTitle = escapeHtml(payload.caseTitle || "your Matter");
    const attorneyName = escapeHtml(payload.attorneyName || "there");
    const completedDate = payload.completedDate ? escapeHtml(payload.completedDate) : "";
    const html = frameEmail(
      "Your Matter has been completed",
      `<p>Hi ${attorneyName},</p>
       <p>Your Matter <strong>${caseTitle}</strong> has been completed${completedDate ? ` on <strong>${completedDate}</strong>` : ""}.</p>
       <div style="margin:16px 0 18px;padding:16px;border:1px solid rgba(0,0,0,0.06);border-radius:14px;background:#fbfaf7;">
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6f695e;">Status</div>
         <div style="font-size:16px;font-weight:600;color:${INK};margin-top:4px;">Completed</div>
         <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6f695e;">Matter</div>
         <div style="font-size:15px;color:${INK};margin-top:4px;">${caseTitle}</div>
         <div style="margin-top:12px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6f695e;">Completed on</div>
         <div style="font-size:15px;color:${INK};margin-top:4px;">${completedDate || "See Matter history"}</div>
       </div>
       <p style="margin:0;">Deliverables will remain available in your account for six (6) months. Please download and save any files you wish to retain.</p>`
    );
    return { subject: "Your Matter has been completed", html };
  },
  documentUploaded: (payload = {}) => {
    const doc = escapeHtml(payload.documentName || "A document");
    const caseTitle = payload.caseTitle ? `<p style="margin:8px 0 20px;">${escapeHtml(payload.caseTitle)}</p>` : "";
    const link = documentLink(payload);
    const html = frameEmail(
      "New file shared",
      `<p style="margin:0;overflow-wrap:anywhere;"><strong>${doc}</strong></p>${caseTitle}`
        + (link ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;border:1px solid ${GOLD};border-radius:6px;color:${INK};font-weight:600;text-decoration:underline;">View file</a></p>`
          : "<p>Sign in to LPC to view the file.</p>")
    );
    return { subject: "File shared on LPC", html };
  },
  resumeUpdated: () => {
    const html = frameEmail(
      "Resume uploaded successfully",
      "<p>Your résumé has been uploaded to your profile. Sign in to review it or make changes.</p>"
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
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6f695e;">Reason</div>
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
         <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6f695e;">Reason</div>
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
            <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#6f695e;margin-bottom:4px;">${section.label}</div>
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
          <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#6f695e;margin-bottom:6px;">Recent activity</div>
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
