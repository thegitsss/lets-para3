const DIRECTOR_OUTREACH_SUBJECT = "for matters that need an extra hand next";
const DIRECTOR_FOLLOW_UP_SUBJECT = "need help posting your first matter?";
const DIRECTOR_FOLLOW_UP_BODY_TEXT = `Hi {{attorneyName}},

I noticed you recently created an attorney account with Let's-ParaConnect, but haven't posted a matter yet.

If you have a project, deadline, overflow task, or one-time paralegal need, you can post the matter directly through the platform and connect with available paralegals on a project-by-project basis.

If you need help getting your first matter posted, I'd be happy to have Samantha, our Founder, assist you.

LPC is solely platform and does not employ attorneys or paralegals. All users are vetted before acceptance. Approval is not guaranteed. Attorneys hire paralegals through the platform for individual matters, and LPC provides a professional workspace for legal professionals to collaborate on a matter-by-matter basis.

--
Let's-ParaConnect

Let's-ParaConnect was built to provide a more sustainable way for attorneys and paralegals to work together. Every interaction on the platform is supported by verification and Stripe-processed payments, helping set clear expectations and support for both sides.

Connect with us:
LinkedIn: https://www.linkedin.com/company/lets-paraconnect/
Facebook: https://www.facebook.com/LetsParaConnect/

16192 Coastal Hwy, Lewes, DE 19958`;

function buildDirectorFollowUpHtml(attorneyName = "there") {
  const safeName = String(attorneyName || "there")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `
    <p>Hi ${safeName},</p>
    <p>I noticed you recently created an attorney account with Let's-ParaConnect, but haven’t posted a matter yet.</p>
    <p>If you have a project, deadline, overflow task, or one-time paralegal need, you can post the matter directly through the platform and connect with available paralegals on a project-by-project basis.</p>
    <p>If you need help getting your first matter posted, I’d be happy to have Samantha, our Founder, assist you.</p>
    <p>LPC is solely platform and does not employ attorneys or paralegals. All users are vetted before acceptance. Approval is not guaranteed. Attorneys hire paralegals through the platform for individual matters, and LPC provides a professional workspace for legal professionals to collaborate on a matter-by-matter basis.</p>
    <p>—<br>Let’s-ParaConnect</p>
    <p>Let's-ParaConnect was built to provide a more sustainable way for attorneys and paralegals to work together. Every interaction on the platform is supported by verification and Stripe-processed payments, helping set clear expectations and support for both sides.</p>
    <p>Connect with us</p>
    <p>
      <a href="https://www.linkedin.com/company/lets-paraconnect/" target="_blank" rel="noopener">LinkedIn</a>
      &nbsp;|&nbsp;
      <a href="https://www.facebook.com/LetsParaConnect/" target="_blank" rel="noopener">Facebook</a>
    </p>
    <p>16192 Coastal Hwy, Lewes, DE 19958</p>
  `;
}

function buildDirectorFollowUpText(attorneyName = "there") {
  return DIRECTOR_FOLLOW_UP_BODY_TEXT.replace(/\{\{attorneyName\}\}/g, String(attorneyName || "there").trim() || "there");
}

const DIRECTOR_STAGE_LABELS = Object.freeze({
  outreach_sent: "Outreach Sent",
  attorney_registered: "Attorney Registered",
  follow_up_needed: "Follow-Up Needed",
  follow_up_sent: "Follow-Up Auto Sent",
  follow_up_failed: "Follow-Up Failed",
  matter_posted: "Matter Posted",
  matter_completed: "Matter Completed",
  commission_complete: "Commission Complete",
  founder_attention: "Founder Attention",
  suppressed: "Suppressed",
});

const US_STATE_CODES = Object.freeze([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
]);

module.exports = {
  buildDirectorFollowUpHtml,
  buildDirectorFollowUpText,
  DIRECTOR_FOLLOW_UP_SUBJECT,
  DIRECTOR_FOLLOW_UP_BODY_TEXT,
  DIRECTOR_OUTREACH_SUBJECT,
  DIRECTOR_STAGE_LABELS,
  US_STATE_CODES,
};
