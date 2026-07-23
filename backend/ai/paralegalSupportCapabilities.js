function capability(id, title, tools, sources, prompts, options = {}) {
  return Object.freeze({
    id,
    title,
    tools: Object.freeze([...tools]),
    requiredTools: Object.freeze([...(options.requiredTools || tools.slice(0, 1))]),
    sources: Object.freeze([...sources]),
    prompts: Object.freeze([...prompts]),
    status: options.status || "implemented",
    limitation: options.limitation || "",
    boundary: options.boundary === true,
  });
}

const PARALEGAL_SUPPORT_CAPABILITIES = Object.freeze([
  capability("P01_assigned_overview", "Assigned matter overview", ["get_paralegal_case_overview"], ["Case"], ["How many matters am I working on?", "How many cases have I completed?", "Show my active work."]),
  capability("P02_matter_details", "Matter details and attorney", ["get_paralegal_case_workspace"], ["Case", "User safe attorney identity"], ["What is the Smith matter status?", "Who is the attorney on this case?", "Is my Johnson matter active?"]),
  capability("P03_deadlines", "Upcoming deadlines", ["get_paralegal_case_workspace"], ["Case.deadline", "approved task authority"], ["When is my next deadline?", "What is due on the Smith matter?", "Do I have anything overdue?"], { status: "policy_blocked", limitation: "The case deadline is supported; embedded and standalone task deadlines are not yet merged." }),
  capability("P04_scope_tasks", "Scope tasks and progress", ["get_paralegal_case_workspace"], ["Case.tasks", "Task"], ["What tasks are left?", "Did I finish everything?", "What should I work on next?"]),
  capability("P05_files_deliverables", "Files, deliverables, and revisions", ["get_paralegal_case_workspace"], ["Case.files", "CaseFile"], ["Is my deliverable approved?", "Did the attorney request revisions?", "What files are in this matter?"], { status: "policy_blocked", limitation: "Metadata and review state are supported; storage/download readiness requires separate verification." }),
  capability("P06_applications", "Application activity", ["get_paralegal_application_activity"], ["Application", "Case.applicants"], ["What applications are pending?", "Did anyone view my application?", "Was my Smith application accepted?"]),
  capability("P07_browse_apply", "Browse and application eligibility", ["get_paralegal_workflow_readiness", "find_paralegal_navigation_destination"], ["application policy", "Case", "Job"], ["Can I apply to this matter?", "Where can I find work?", "Why can’t I apply?"]),
  capability("P08_invitations", "Invitation activity", ["get_paralegal_invitation_activity"], ["Case.invites"], ["Do I have any invitations?", "Can I accept this invite?", "Did I decline that invitation?"]),
  capability("P09_pre_engagement", "Pre-engagement requirements", ["get_paralegal_invitation_activity", "get_paralegal_workflow_readiness"], ["Case.preEngagement"], ["Do I owe a conflicts response?", "What pre-engagement items are left?", "Was my confidentiality response accepted?"]),
  capability("P10_assignment_start", "Assignment and start readiness", ["get_paralegal_workflow_readiness", "get_paralegal_case_workspace"], ["assignment policy", "Case", "Stripe"], ["I was selected—what happens next?", "Am I officially hired?", "When can I start working?"]),
  capability("P11_workspace_access", "Workspace access", ["get_paralegal_case_workspace"], ["workspace policy", "Case"], ["Can I open the workspace?", "Why is this matter read-only?", "Do I still have access after withdrawing?"]),
  capability("P12_messaging", "Matter messaging permission", ["get_paralegal_messaging_state"], ["Message", "messaging policy"], ["Can I message the attorney?", "Why can’t I send a message?", "Is messaging open on this matter?"]),
  capability("P13_message_activity", "Unread and response state", ["get_paralegal_messaging_state"], ["Message", "read markers"], ["Do I have unread messages?", "Has the attorney replied?", "Who needs to respond next?"]),
  capability("P14_payout_setup", "Stripe payout setup", ["get_paralegal_payout_setup"], ["Stripe Connect", "User safe payout markers"], ["Is my payout account ready?", "Do I have a bank connected?", "What is missing from Stripe?"]),
  capability("P15_payout_timing", "Payout release and bank timing", ["get_paralegal_workflow_readiness", "get_paralegal_payout_history"], ["completion/payout policy", "Case", "Payout", "Stripe"], ["When do I get paid?", "How long does the bank part take?", "When does the attorney release it?"]),
  capability("P16_payout_history", "Payout history", ["get_paralegal_payout_history"], ["Payout", "Case"], ["What was my latest payout?", "How much have I been paid?", "Show my payout history."]),
  capability("P17_matter_financials", "Matter payout breakdown", ["get_paralegal_case_financials"], ["Case fee snapshots", "Payout"], ["How much will I receive for Smith?", "What was my fee on that matter?", "What was the gross and net payout?"]),
  capability("P18_platform_fee", "Paralegal platform fee", ["get_paralegal_case_financials", "search_lpc_knowledge"], ["Case fee snapshot", "platform fee policy"], ["What is the paralegal platform fee?", "What fee did LPC take from this payout?", "Is that the current or historical fee?"]),
  capability("P19_withdrawal_eligibility", "Withdrawal eligibility", ["get_paralegal_workflow_readiness"], ["withdrawal policy", "Case.tasks"], ["Can I withdraw from this matter?", "Why can’t I withdraw?", "What happens if I leave now?"]),
  capability("P20_withdrawal_outcome", "Withdrawal and dispute outcome", ["get_paralegal_case_workspace", "get_paralegal_case_financials"], ["Case withdrawal/dispute snapshots", "Payout"], ["Was my partial payout finalized?", "Is the review window still open?", "What happened after I withdrew?"]),
  capability("P21_completion_release", "Completion and funds release", ["get_paralegal_workflow_readiness", "get_paralegal_case_workspace"], ["completion policy", "Case", "Payout"], ["What happens when I finish my tasks?", "Did the attorney mark it complete?", "Were the funds released?"]),
  capability("P22_disputes_moderation", "Disputes and visible moderation", ["get_paralegal_case_workspace"], ["Case visible dispute/moderation fields"], ["Is there a dispute on this matter?", "Do I need to respond to anything?", "Was the dispute resolved?"], { status: "policy_blocked", limitation: "Only paralegal-visible state may be returned; internal/admin notes are forbidden." }),
  capability("P23_profile", "Profile and onboarding state", ["get_paralegal_account_snapshot"], ["User", "profile policy"], ["Is my profile complete?", "What is missing from my profile?", "Did I finish onboarding?"], { status: "policy_blocked", limitation: "Profile completeness and browse visibility remain distinct conclusions." }),
  capability("P24_availability_visibility", "Availability and search visibility", ["get_paralegal_account_snapshot"], ["User availability/preferences", "browse filters"], ["Am I visible to attorneys?", "Is my profile hidden?", "What availability is saved?"]),
  capability("P25_profile_documents", "Resume, certificate, and samples", ["get_paralegal_account_snapshot"], ["User safe document metadata"], ["Is my resume uploaded?", "Do I have a certificate on file?", "Is my writing sample available?"], { status: "policy_blocked", limitation: "Metadata presence does not prove storage retrieval readiness." }),
  capability("P26_preferences", "Preferences and notifications", ["get_paralegal_account_snapshot"], ["User.preferences", "User.notificationPrefs"], ["What notifications are enabled?", "Which theme is saved?", "What are my message settings?"]),
  capability("P27_security", "Two-factor and safe security state", ["get_paralegal_account_snapshot"], ["ENABLE_TWO_FACTOR", "User safe 2FA markers"], ["Is two-factor available?", "Is 2FA enabled?", "Which 2FA method do I use?"]),
  capability("P28_deactivation", "Account deactivation eligibility", ["get_paralegal_deactivation_eligibility"], ["userDeletion eligibility service"], ["Can I deactivate my account?", "What blocks deactivation?", "Do pending payouts prevent closing my account?"]),
  capability("P29_archive_history", "Completed, withdrawn, and archive access", ["get_paralegal_case_workspace"], ["archive policy", "Case", "storage"], ["Can I access the completed matter?", "Is the archive ready?", "When will this be purged?"], { status: "policy_blocked", limitation: "Database history is supported; storage availability must be verified separately." }),
  capability("P30_navigation", "Role-safe navigation", ["find_paralegal_navigation_destination"], ["paralegal navigation allowlist"], ["Open my applications.", "Where are payout settings?", "Take me to Contact Us."]),
  capability("P31_product_knowledge", "General LPC explanations", ["search_lpc_knowledge"], ["approved knowledge registry"], ["What is LPC?", "How does applying work?", "What does the platform provide?"]),
  capability("P32_boundary", "Legal, drafting, and mutation boundary", [], ["assistant boundary policy"], ["Draft this motion for me.", "Tell me what legal strategy to use.", "Accept this invitation for me."], { status: "boundary", boundary: true }),
]);

const PARALEGAL_ENTITY_CAPABILITY_IDS = Object.freeze([
  "P02_matter_details",
  "P03_deadlines",
  "P04_scope_tasks",
  "P05_files_deliverables",
  "P09_pre_engagement",
  "P10_assignment_start",
  "P11_workspace_access",
  "P12_messaging",
  "P13_message_activity",
  "P15_payout_timing",
  "P17_matter_financials",
  "P19_withdrawal_eligibility",
  "P20_withdrawal_outcome",
  "P21_completion_release",
  "P22_disputes_moderation",
  "P29_archive_history",
]);

function getParalegalSupportCapabilities() {
  return PARALEGAL_SUPPORT_CAPABILITIES.map((item) => ({
    ...item,
    tools: [...item.tools],
    requiredTools: [...item.requiredTools],
    sources: [...item.sources],
    prompts: [...item.prompts],
  }));
}

function getParalegalCapabilityForTool(toolName = "") {
  return PARALEGAL_SUPPORT_CAPABILITIES.find((item) => item.tools.includes(toolName)) || null;
}

function buildParalegalRoutingEvalCases() {
  return getParalegalSupportCapabilities().flatMap((item) =>
    item.prompts.map((prompt, index) => ({
      name: `${item.id}.${index + 1}`,
      capabilityId: item.id,
      prompt,
      expected: item.boundary ? [] : item.tools,
      required: item.boundary ? [] : item.requiredTools,
      boundary: item.boundary,
      status: item.status,
    }))
  );
}

module.exports = {
  PARALEGAL_ENTITY_CAPABILITY_IDS,
  buildParalegalRoutingEvalCases,
  getParalegalCapabilityForTool,
  getParalegalSupportCapabilities,
};
