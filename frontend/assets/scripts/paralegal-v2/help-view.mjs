import { createHelpCenter } from "../utils/help-center.mjs";
import { createHelpApi } from "../utils/help-api.mjs";
import { verifyParalegalSession } from "./session-boundary.mjs";

const HELP_SECTIONS = Object.freeze([
  Object.freeze({ id: "account-access", title: "Account & access", answers: Object.freeze([
    Object.freeze({"question": "When can I open my Private Office?", "answer": "After your account is approved. Until then, follow the email verification and review instructions from signup."}),
    Object.freeze({"question": "Where do I update my profile?", "answer": "Open Profile Settings to edit your details, résumé, photo, and experience. Enter your completed years of paralegal experience accurately; they affect which matters you can apply for."}),
    Object.freeze({"question": "What happens when I change my photo?", "answer": "Your profile is hidden from attorneys until the new photo is approved."}),
    Object.freeze({"question": "Where are my account preferences?", "answer": "Profile Settings includes security, Stripe payouts, text size, and appearance."}),
    Object.freeze({"question": "What if I can’t sign in?", "answer": "Use Reset password or contact support."}),
    Object.freeze({"question": "Can I deactivate my account?", "answer": "Use Deactivate account in Profile Settings after active matters and outstanding payments are resolved. Deactivation closes your account but does not delete all records."}),
  ]) }),
  Object.freeze({ id: "applying", title: "Invitations & applying", answers: Object.freeze([
    Object.freeze({"question": "How do I apply?", "answer": "Open Browse Matters, use filters, and choose Details to review the scope and required experience. Add a cover letter to apply. Track your response in My Matters & Applications."}),
    Object.freeze({"question": "How do invitations work?", "answer": "Find Invitations in My Matters & Applications. Choose Review full invitation, then Accept invitation or Decline. Acceptance shows interest; work begins after the attorney hires you and funds the matter."}),
    Object.freeze({"question": "What might the attorney request before hiring?", "answer": "A confidentiality agreement, a conflicts check, or both. Review and respond in My Matters & Applications."}),
    Object.freeze({"question": "Do I need Stripe before applying?", "answer": "Yes. Complete Stripe setup before applying or accepting invitations."}),
  ]) }),
  Object.freeze({ id: "working", title: "Working on a matter", answers: Object.freeze([
    Object.freeze({"question": "Where do I find my current work?", "answer": "Home prioritizes overdue work, revisions, and upcoming deadlines. Open a matter from My Matters & Applications to see its work, files, messages, and history."}),
    Object.freeze({"question": "Where do message links take me?", "answer": "To the intended message, or the first unread message. If you’re caught up, the conversation opens at the latest message."}),
    Object.freeze({"question": "How do I submit files?", "answer": "In Files & submissions, choose your files, review the list, then select Submit file or Submit files. Files must pass a security check before they become available."}),
    Object.freeze({"question": "How do I respond to a revision request?", "answer": "Select Choose revised file beside the request, then submit your revised version. It stays linked to the requested file and version."}),
    Object.freeze({"question": "Who approves the work?", "answer": "The attorney reviews files, requests revisions, and marks work items complete. Submitting a file does not approve work or release payment."}),
    Object.freeze({"question": "Who completes the matter?", "answer": "The attorney handles final review, matter completion, and payment release. Check Work for progress and Payments for payment status."}),
  ]) }),
  Object.freeze({ id: "payouts", title: "Getting paid", answers: Object.freeze([
    Object.freeze({"question": "How do I set up Stripe?", "answer": "On Home, choose Continue to Stripe. You can also open Stripe payouts in Profile Settings → Security."}),
    Object.freeze({"question": "What is the platform fee?", "answer": "LPC deducts an 18% paralegal platform fee from approved, paid compensation. The posted matter amount is before this fee."}),
    Object.freeze({"question": "What does an estimated payout mean?", "answer": "It is not a confirmed payment. The final amount depends on the work approved and paid, including any partial payout or dispute resolution."}),
    Object.freeze({"question": "When will I receive payment?", "answer": "The attorney must authorize payment release. Open Payout details in My Matters & Applications for the payment record. Check Stripe for bank arrival dates; timing depends on your payout schedule and bank."}),
  ]) }),
  Object.freeze({ id: "disputes", title: "Withdrawals & disputes", answers: Object.freeze([
    Object.freeze({"question": "How do I leave a matter?", "answer": "In Work, open Matter options and choose Withdraw from matter when available. Review the payout details before confirming. Withdrawal closes your workspace access."}),
    Object.freeze({"question": "Will I receive a payout if I withdraw?", "answer": "No completed work means no payout. For completed work, the attorney decides whether a partial payout is appropriate. You can’t withdraw once all work items are complete; other restrictions may apply."}),
    Object.freeze({"question": "How do I request a formal review?", "answer": "In Work, open Matter options, then Open dispute. For an eligible withdrawn matter, choose Request LPC review. You can add details before confirming. An active matter pauses while LPC reviews the dispute."}),
    Object.freeze({"question": "How do I report an account or website problem?", "answer": "Use Report an issue below. Do not include privileged matter information or documents."}),
  ]) }),
]);

const RESOURCES = Object.freeze([
  { href: "/forgot-password.html", label: "Reset password" },
  { href: "/privacy.html", label: "Privacy Policy" },
  { href: "/terms.html", label: "Terms of Service" },
  { href: "/paralegal-admission.html", label: "Admissions" },
  { href: "/contact.html", label: "Contact" },
  { href: "/accessibility.html", label: "Accessibility" },
]);

export function createHelpView(options = {}) {
  const guardedApi = createHelpApi({ ...options, verifySession: request => verifyParalegalSession(options.api, request) });
  const center = createHelpCenter({ ...options, api: guardedApi, sections: HELP_SECTIONS, title: "Help for Paralegals",
    introduction: "Guidance for invitations, applications, matter work, and payouts.",
    guideLabel: "Paralegal Help guide", featureKey: "paralegal-v2-help", resources: RESOURCES,
    routeAttribute: "data-v2-route" });
  return Object.freeze({ ...center, clearDrafts(settings) { center.clearDrafts(settings); guardedApi.clear(); } });
}
export { HELP_SECTIONS };
