export const HELP_SECTIONS = Object.freeze([
  { id: "account", title: "Account & access", answers: [
    { question: "Where do I update my profile?", answer: "Open Profile Settings to update your name, firm, contact details, photo and bio. Use your profile preview to check how your profile appears to paralegals." },
    { question: "Where are security and appearance settings?", answer: "Profile Settings includes password changes, sign-in verification, passkeys, signed-in devices and Preferences. Review the sign-out consequence before confirming a security change." },
    { question: "What if I can’t sign in?", answer: "Use Reset password below, or contact LPC. Never include your password or verification codes in a support report." },
    { question: "Can I deactivate my account?", answer: "Account closure in Profile Settings checks your active work, disputes and outstanding payments. Review the consequences before confirming. Deactivation ends access; retained work and financial records remain." },
  ] },
  { id: "hiring", title: "Posting & hiring", answers: [
    { question: "How do I post a Matter?", answer: "Open Matters and choose Create a Matter. Describe the work, required experience, budget and dates. Review the posting before publishing. A saved draft is not a published opportunity." },
    { question: "Where do I review applications and invitations?", answer: "Open the Matter to review its applications and manage invitations. Find a Paralegal lets you explore eligible profiles. An accepted invitation expresses interest; it does not by itself start paid work." },
    { question: "What should I review before hiring?", answer: "Review the paralegal’s application, experience and availability, together with any confidentiality agreement or conflicts check you request. Confirm the selected paralegal and payment details in the hiring flow." },
  ] },
  { id: "working", title: "Working together", answers: [
    { question: "Where is the work for a Matter?", answer: "Open the Matter from your workspace. Its work, files, messages, payment information and activity belong to that Matter. Check the current status and next action before making a change." },
    { question: "How do I review submitted work?", answer: "Open the submitted files, review the work and request revisions when needed. Keep revision requests attached to the relevant file. Uploading a file does not mark work complete or release payment." },
    { question: "Where do private tasks belong?", answer: "Private Tasks and your personal notes help organize your own work. Use the Matter’s shared work and messages for instructions or updates the paralegal needs to see." },
    { question: "Why is an action unavailable?", answer: "Available actions depend on your access and the Matter’s current stage. Read the explanation beside the action, resolve any requirement and refresh if the state has changed." },
  ] },
  { id: "payments", title: "Payments & completion", answers: [
    { question: "Where can I review charges and receipts?", answer: "Open Payments for your payment activity. Open the related Matter for its payment status and available records. Review the displayed amounts and charges before confirming a payment." },
    { question: "Does completed work automatically release payment?", answer: "Review the final work and follow the Matter’s completion and payment-release steps. A work item being complete, a Matter being complete and a payment being released describe different events." },
    { question: "What if payment confirmation is interrupted?", answer: "Use the displayed check or recovery action to confirm the existing payment before starting another. Keep the reference if one is shown. An unconfirmed response does not prove that no charge occurred." },
  ] },
  { id: "problems", title: "Problems & support", answers: [
    { question: "How do I handle a withdrawal or dispute?", answer: "Open the Matter and review its available withdrawal or dispute actions. Review any completed work, payout details and restrictions before confirming. Use the Matter’s formal review process for a work or payment dispute." },
    { question: "What should I report here?", answer: "Use Report an issue for account or platform problems. Describe what you expected and what happened. Keep privileged Matter content, documents, passwords and payment details out of the report." },
    { question: "Where can I check a report?", answer: "Use View report after LPC confirms receipt, or open the report from its notification. The report page shows its current status and available update history." },
  ] },
]);

export const HELP_RESOURCES = Object.freeze([
  { href: "#/home?replayTour=1", label: "Replay workspace guide" },
  { href: "/forgot-password.html", label: "Reset password" }, { href: "/attorney-faq.html", label: "Attorney FAQ" },
  { href: "/contact.html", label: "Contact" }, { href: "/privacy.html", label: "Privacy Policy" },
  { href: "/terms.html", label: "Terms of Service" }, { href: "/accessibility.html", label: "Accessibility" },
]);
