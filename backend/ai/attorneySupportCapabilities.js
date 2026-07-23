function capability(id, title, tools, sources, prompts, options = {}) {
  return Object.freeze({
    id,
    title,
    status: options.status || "implemented",
    tools: Object.freeze(tools),
    requiredTools: Object.freeze(options.requiredTools || []),
    sources: Object.freeze(sources),
    prompts: Object.freeze(prompts),
    boundary: options.boundary === true,
    multiTurn: Object.freeze(options.multiTurn || []),
    limitation: String(options.limitation || ""),
  });
}

const ATTORNEY_ENTITY_CAPABILITY_IDS = Object.freeze([
  "A02_matter_details",
  "A03_deadlines",
  "A04_scope_tasks",
  "A05_task_records",
  "A06_files",
  "A07_applications",
  "A08_invitations",
  "A09_pre_engagement",
  "A10_hiring",
  "A12_funding",
  "A15_case_financials",
  "A16_receipts",
  "A17_messages",
  "A18_pending_paralegal",
  "A24_disputes_termination",
  "A25_withdrawal_relist",
  "A26_completion",
  "A27_archive",
  "A28_moderation",
  "A29_notes_meetings",
]);

const ATTORNEY_SUPPORT_CAPABILITIES = Object.freeze([
  capability("A01_matter_overview", "Matter counts and lifecycle totals", ["get_my_case_overview"], ["Case"], ["How many matters do I have?", "How many cases have I completed?", "Break down my cases by status."]),
  capability("A02_matter_details", "Named matter status and participants", ["get_case_details", "get_attorney_case_workspace"], ["Case", "User"], ["What is happening with the Smith matter?", "Is Testing payout closed?", "Who is assigned to that case?"], { multiTurn: [{ history: [{ role: "user", content: "Tell me about the Smith matter." }], prompt: "Is it still active?" }] }),
  capability("A03_deadlines", "Upcoming and overdue deadlines", ["get_next_deadline", "get_attorney_case_workspace"], ["Case.deadline"], ["What is my next deadline?", "When is the Smith matter due?", "Do I have anything overdue?"], { status: "policy_blocked", limitation: "Overdue aggregation and task-system authority remain unresolved." }),
  capability("A04_scope_tasks", "Scope tasks and completion blockers", ["get_attorney_case_workspace", "get_attorney_matter_readiness"], ["Case.tasks", "completion policy"], ["What tasks remain?", "Can I complete this matter?", "Are all scope tasks finished?"], { requiredTools: ["get_attorney_matter_readiness"] }),
  capability("A05_task_records", "Standalone task records", ["get_attorney_case_workspace"], ["Task", "Case.tasks"], ["What standalone tasks are open?", "Which tasks are in review?", "Are task due dates overdue?"], { status: "policy_blocked", limitation: "The two task systems do not have an approved merge contract." }),
  capability("A06_files", "Files and deliverable review", ["get_attorney_case_workspace"], ["CaseFile", "Case.files"], ["Which files need review?", "Did the paralegal upload a deliverable?", "Can I download that file?"], { status: "policy_blocked", limitation: "Metadata is available; object retrieval readiness requires a storage check." }),
  capability("A07_applications", "Applications across matter stores", ["get_attorney_application_activity", "get_attorney_case_workspace"], ["Application", "Job", "Case.applicants"], ["Did anyone apply?", "Who applied to the Smith matter?", "How many applicants are waiting?"], { requiredTools: ["get_attorney_application_activity"] }),
  capability("A08_invitations", "Invitation state and readiness", ["get_attorney_case_workspace", "get_attorney_matter_readiness"], ["Case.invites", "invitation policy"], ["Is my invitation pending?", "Can I invite this paralegal?", "Who has not answered an invitation?"], { requiredTools: ["get_attorney_matter_readiness"] }),
  capability("A09_pre_engagement", "Pre-engagement requirements and state", ["get_attorney_case_workspace", "get_attorney_matter_readiness"], ["Case.preEngagement", "pre-engagement policy"], ["Is the conflicts check complete?", "Who needs to act on pre-engagement?", "Can I request an NDA acknowledgement?"], { requiredTools: ["get_attorney_matter_readiness"] }),
  capability("A10_hiring", "Hiring workflow and live eligibility", ["get_attorney_workflow_readiness", "get_attorney_matter_readiness"], ["hiring policy", "Case", "User", "Stripe"], ["Can I hire now?", "What blocks hiring?", "How does the hiring process work?"], { requiredTools: ["get_attorney_matter_readiness"] }),
  capability("A11_posting", "Draft and publishing readiness", ["get_attorney_workflow_readiness", "find_navigation_destination"], ["posting policy", "CaseDraft", "Case", "Job"], ["Can I post a matter?", "Do I need a payment method first?", "Can I save this as a draft?"], { requiredTools: ["get_attorney_workflow_readiness"] }),
  capability("A12_funding", "Funding timing and failures", ["get_attorney_workflow_readiness", "get_attorney_matter_readiness", "get_attorney_case_financials"], ["funding policy", "Stripe PaymentIntent", "Case"], ["When is my card charged?", "Why is funding blocked?", "Is this matter funded?"], { requiredTools: ["get_attorney_matter_readiness"] }),
  capability("A13_payment_method", "Saved payment method", ["get_billing_snapshot"], ["Stripe Customer", "PaymentMethod"], ["Do I have a card saved?", "Is my payment method usable?", "Did the card lookup fail?"]),
  capability("A14_billing_summary", "Account billing totals and history", ["get_attorney_billing_summary", "get_attorney_receipt_history"], ["Case financial snapshots", "receipt routes"], ["How much have I spent?", "What is currently funded?", "Can I export billing history?"], { requiredTools: ["get_attorney_billing_summary"] }),
  capability("A15_case_financials", "Matter charges, fees, and payout", ["get_attorney_case_financials"], ["Case fee snapshots", "Payout"], ["What was I charged?", "What did the paralegal receive?", "Give me both amounts."], { requiredTools: ["get_attorney_case_financials"], multiTurn: [{ history: [{ role: "user", content: "How much was Testing payout for?" }, { role: "assistant", content: "Which amount?" }], prompt: "Both." }] }),
  capability("A16_receipts", "Receipt index and readiness", ["get_attorney_receipt_history"], ["receipt route", "Case"], ["Show my receipts.", "Is the receipt ready?", "Where is the receipt for that matter?"], { status: "policy_blocked", limitation: "Index access is implemented; object generation/retrieval readiness is not yet verified by the tool." }),
  capability("A17_messages", "Unread and response state", ["get_attorney_message_activity", "get_messaging_state"], ["Message", "User.messageLastViewedAt", "messaging policy"], ["Do I have unread messages?", "Who needs a reply?", "Can I message in this matter?"]),
  capability("A18_pending_paralegal", "Explicitly attributable paralegal activity", ["get_pending_paralegal_activity"], ["Case invites", "Case.preEngagement", "Message"], ["Am I waiting on a paralegal?", "Does a paralegal owe me a reply?", "What response is pending?"], { limitation: "Unassigned scope tasks are intentionally excluded." }),
  capability("A19_attention", "Account attention summary", ["get_attorney_attention_summary"], ["Case", "Message", "Application", "User"], ["What needs my attention?", "Catch me up.", "What should I handle next?"], { status: "policy_blocked", limitation: "The complete dashboard signal taxonomy is not yet shared." }),
  capability("A20_profile", "Attorney profile and onboarding state", ["get_attorney_account_snapshot"], ["User", "profile policy"], ["Is my profile complete?", "What is missing from my profile?", "Did I finish onboarding?"], { status: "policy_blocked", limitation: "Conflicting completion definitions are returned explicitly and not collapsed." }),
  capability("A21_preferences", "Preferences and notifications", ["get_attorney_account_snapshot"], ["User.preferences", "User.notificationPrefs"], ["What are my notification settings?", "Which theme is saved?", "Is my profile hidden?"]),
  capability("A22_security", "Two-factor feature and configuration", ["get_attorney_account_snapshot"], ["ENABLE_TWO_FACTOR", "User 2FA markers"], ["Is two-factor available?", "Is 2FA configured?", "Which 2FA method is enabled?"]),
  capability("A23_deactivation", "Account deactivation eligibility", ["get_attorney_deactivation_eligibility"], ["userDeletion eligibility service"], ["Can I deactivate my account?", "What blocks deactivation?", "Do active matters prevent deactivation?"], { requiredTools: ["get_attorney_deactivation_eligibility"] }),
  capability("A24_disputes_termination", "Disputes and termination", ["get_attorney_case_workspace", "get_attorney_matter_readiness"], ["Case.disputes", "Case termination state"], ["Is there an open dispute?", "What is the termination state?", "Who acts next on this dispute?"]),
  capability("A25_withdrawal_relist", "Withdrawal, payout decision, and relisting", ["get_attorney_case_workspace", "get_attorney_matter_readiness", "get_attorney_case_financials"], ["withdrawal/relist policy", "Case payout snapshots"], ["Can I relist this matter?", "Is the review window active?", "Was the partial payout finalized?"], { requiredTools: ["get_attorney_matter_readiness"] }),
  capability("A26_completion", "Completion and funds release readiness", ["get_attorney_matter_readiness", "get_attorney_case_financials"], ["completion policy", "Case", "Payout"], ["Can I complete this matter?", "What blocks release?", "Were funds released?"], { requiredTools: ["get_attorney_matter_readiness"] }),
  capability("A27_archive", "Archive, retention, and purge state", ["get_attorney_case_workspace", "get_attorney_matter_readiness"], ["archive policy", "Case", "storage"], ["Is the archive ready?", "When will this matter be purged?", "Can I download the archive?"], { status: "policy_blocked", limitation: "Storage readiness is explicit but not yet checked live." }),
  capability("A28_moderation", "Flagged-post remediation", ["get_attorney_case_workspace"], ["Case moderation fields"], ["Was my post flagged?", "Do I need to revise this matter?", "Has moderation cleared it?"]),
  capability("A29_notes_meetings", "Attorney-visible notes and meeting link", ["get_attorney_case_workspace"], ["Case.zoomLink", "approved note scope"], ["Is there a Zoom link?", "What notes are on this matter?", "When was the meeting link updated?"], { status: "policy_blocked", limitation: "Internal/admin notes remain forbidden pending product classification." }),
  capability("A30_navigation", "Role-safe navigation", ["find_navigation_destination"], ["attorney navigation allowlist"], ["Open billing.", "Where are my cases?", "Take me to profile settings."]),
  capability("A31_product_knowledge", "General non-workflow LPC explanations", ["search_lpc_knowledge"], ["approved knowledge registry"], ["What is the platform fee?", "What is LPC?", "Which non-workflow features does LPC provide?"], { limitation: "Executable workflow policy and live scoped data are separate authoritative sources." }),
  capability("A32_boundary", "Legal, drafting, and mutation boundary", [], ["assistant boundary policy"], ["Draft an NDA.", "Tell me which claim to file.", "Hire this paralegal for me."], { status: "boundary", boundary: true }),
]);

function getAttorneySupportCapabilities() {
  return ATTORNEY_SUPPORT_CAPABILITIES.map((item) => ({
    ...item,
    tools: [...item.tools],
    requiredTools: [...item.requiredTools],
    sources: [...item.sources],
    prompts: [...item.prompts],
    multiTurn: item.multiTurn.map((turn) => ({
      ...turn,
      history: turn.history.map((entry) => ({ ...entry })),
    })),
  }));
}

function getCapabilityForTool(toolName = "") {
  return ATTORNEY_SUPPORT_CAPABILITIES.find((item) => item.tools.includes(toolName)) || null;
}

function expandPrompt(prompt = "") {
  const base = String(prompt || "").trim();
  const noPunctuation = base.replace(/[?.!]+$/g, "");
  const shorthand = noPunctuation
    .replace(/\bparalegal\b/gi, "para")
    .replace(/\bmatters?\b/gi, "cases")
    .replace(/\bapplications?\b/gi, "applicants");
  return [...new Set([
    base,
    base.toLowerCase(),
    noPunctuation,
    `Can you tell me ${noPunctuation.charAt(0).toLowerCase()}${noPunctuation.slice(1)}`,
    shorthand,
  ].filter(Boolean))];
}

function buildAttorneyRoutingEvalCases({ expanded = false } = {}) {
  return getAttorneySupportCapabilities().flatMap((item) => {
    const expected = item.boundary ? [] : item.tools;
    const required = item.boundary ? [] : item.requiredTools;
    const direct = item.prompts.flatMap((prompt, promptIndex) =>
      (expanded ? expandPrompt(prompt) : [prompt]).map((variant, variantIndex) => ({
        name: `${item.id} ${promptIndex + 1}.${variantIndex + 1}`,
        capabilityId: item.id,
        prompt: variant,
        expected,
        required,
        boundary: item.boundary,
        status: item.status,
      }))
    );
    const generatedEntityTurns = ATTORNEY_ENTITY_CAPABILITY_IDS.includes(item.id)
      ? [
          {
            history: [{ role: "user", content: "Use the Smith matter." }],
            prompt: "What about that one?",
            referenceKind: "pronoun",
          },
          {
            history: [
              { role: "user", content: "Use the Smith matter." },
              { role: "assistant", content: "I found the Smith matter." },
            ],
            prompt: "Now use the Jones matter instead.",
            referenceKind: "subject_change",
          },
          {
            history: [
              { role: "user", content: "Use the Smith matter." },
              { role: "assistant", content: "I found the Smith matter." },
            ],
            prompt: "I meant the other case.",
            referenceKind: "correction",
          },
        ]
      : [];
    const multiTurn = [...item.multiTurn, ...generatedEntityTurns].map((turn, index) => ({
      name: `${item.id} follow-up ${index + 1}`,
      capabilityId: item.id,
      prompt: turn.prompt,
      history: turn.history,
      expected,
      required,
      boundary: item.boundary,
      status: item.status,
      referenceKind: turn.referenceKind || "dimension_follow_up",
    }));
    return [...direct, ...multiTurn];
  });
}

module.exports = {
  ATTORNEY_ENTITY_CAPABILITY_IDS,
  buildAttorneyRoutingEvalCases,
  getAttorneySupportCapabilities,
  getCapabilityForTool,
};
