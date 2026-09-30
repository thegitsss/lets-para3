# LPC admin: solo owner with AI operations

Date: September 26, 2026
Status: implementation started September 26–27, 2026. The owner accepted the consolidation direction and clarified that there are no employees; Samantha and AI operate LPC. This document specifies the complete target. Individual capabilities are not implemented, deployed, or enabled merely because they appear here.

## Objective and scope

Reduce the work Samantha must read, remember, route, and repeat across the entire admin. AI should complete permitted routine work, assemble consequential decisions, and escalate actionable exceptions. Success is less owner work with correct outcomes, not more generated drafts or a larger number of agent runs.

The prior suggestion to hire or assign work to support, admissions, finance, and marketing operators is replaced by background workflows. Employee management and a new staff-role system are not initial deliverables. Human escalation means Samantha until another person is explicitly added.

[LPC Product North Star](LPC_PRODUCT_NORTH_STAR.md) remains the product baseline: preserve canonical records, working workflows, Matter context, and consequential-action boundaries. The accepted redesign permits admin reorganization. General agreement to greater autonomy is not evidence that any particular outbound campaign, payment, deployment, or destructive operation was approved.

## Owner experience

The landing page has three parts:

1. **Needs your decision:** prioritized exceptions and prepared approval cards. Each explains what happened, what was already checked, the proposed action, its effect, and why AI cannot finish it.
2. **In progress:** compact, optional visibility into background work and waiting records, including the next scheduled step. No approval required to inspect this list.
3. **Handled:** an optional digest of verified outcomes with links to the underlying records. Successful routine work does not become a new review task.

An empty decision list must say whether sources were checked successfully. An unavailable payment feed or stopped worker cannot appear as “everything handled.”

Primary navigation: Today, People, Matters, Inbox, Finance. Growth and System are secondary. The admin Assistant is available throughout and understands the selected record. Do not add a separate AI department directory or another competing decision dashboard.

Visual direction: white sidebar and surfaces, subtle gray dividers, dark working text, Sarabun for controls and body copy, restrained Cormorant Garamond headings. Use a queue/detail layout for reviews and conversations, complete pages for investigations, and deliberate mobile list/detail navigation.

## Voice and wording

Owner requirement, September 26: AI must use a friendly, easy tone. Apply this throughout Assistant conversations, background-work updates, decision cards, errors, notifications, button labels, and AI-prepared messages. This is part of acceptance, not optional copy polish.

Sound like a calm, capable assistant: warm, direct, and respectful of the owner's time. Use familiar words, natural contractions, short sentences, and specific next steps. Lead with what happened or what needs attention. Usually one or two sentences are enough; make supporting details available when needed.

- Use “I” in Assistant conversation and plain status labels elsewhere. Keep the AI identity clear; do not invent employees or imply that a human reviewed something.
- Explain the work, not the AI machinery. Keep terms such as agent orchestration, confidence threshold, execution lane, and autonomous remediation out of everyday screens. Technical details remain available for investigation.
- Use friendly specificity: “I need your decision on this refund” rather than “Human intervention required.” Buttons name the action, such as “Review refund” or “Remind me Friday.”
- Match tense to evidence. “I've drafted” means a draft exists; “scheduled” means a persisted job exists; “completed” requires a verified result. Do not promise to keep checking when no background process is running.
- Be candid about uncertainty and failures without blame, alarmism, or false reassurance. Explain what is known, what happens next, and whether the owner needs to do anything. Never imply that a failed check means a healthy system.
- Avoid repeated greetings, excessive apologies, forced enthusiasm, praise, pet names, and celebratory language for routine actions. Serious money or account issues get calm, precise wording.
- Routine updates must not end with another offer or question that creates work. Ask only for a missing fact or a decision needed to proceed.

Illustrative copy; names and counts below are examples, not live records:

| Situation | Preferred wording |
| --- | --- |
| Application prepared | “I've checked this application and summarized what's ready. It needs your approval.” |
| Waiting for information | “Waiting for Jordan's reply.” Add “I'll check again Friday” only when that follow-up is actually scheduled. |
| Draft ready | “The reply is ready for you to review.” |
| Confirmed in-app reply | “I've replied in the conversation. No action needed from you.” |
| Owner decision | “This person is asking for a refund. I've gathered the payment history so you can decide.” |
| Temporary lookup failure | “I couldn't check this payment just now. Please try again.” Use a retry promise only when a retry is actually scheduled. |
| Uncertain email outcome | “I couldn't confirm whether this email was sent. Check its delivery record before trying again.” |
| Worker stopped | “Automatic follow-ups are paused because the background service stopped.” Link the specific recovery action available. |
| No owner work | “Nothing needs your attention right now.” Only show after all required sources were successfully checked. |

Copy acceptance: read each message without technical context. The owner should understand what happened, whether anything is needed, and what happens next. Verify that every claim matches the underlying state, and that tone remains clear and considerate during failures as well as success.

## Work ownership and attention

Show “AI is handling this,” “Waiting for applicant,” “Waiting for a reply,” “Needs your decision,” and “Completed” only when authoritative workflow evidence supports the label. An agent role label or routing suggestion alone does not prove someone is handling a task.

AI-owned work needs a persisted next step, due time, execution state, and escalation deadline. A crashed or stopped worker must not leave work silently owned forever. Keep human ticket assignment distinct from machine execution; do not create fake staff accounts to satisfy the existing admin-only assignee field.

Keep one owner decision per underlying problem. Link support reports, matter exceptions, failed notifications, and incidents rather than making the owner resolve each representation separately. Retain distinct domain records and histories.

Rank work using actual impact, external deadlines, age, and owner-only authority. Routine applications cannot indefinitely precede a funding problem. A passed matter deadline first enters the appropriate participant follow-up workflow; it escalates to Samantha when intervention is needed.

Replace session-only “Later” with durable scheduled follow-up. New material facts can reopen deferred work; an ordinary refresh cannot reset its agreed follow-up time. Ordinary reminders and alerts are batched. Urgent interruptions identify the affected user or matter and an available action.

## Proposed automation contract

These are implementation targets, not activation claims. Initial communication limits below are proposed defaults; apply them through explicit action policies and existing preferences.

| Area | Routine work AI/software should complete | What reaches Samantha |
| --- | --- | --- |
| Admissions | Run existing readiness checks, summarize documents, identify missing requirements, prepare a precise request, track replies. A bounded missing-information notice may send under an approved template policy. | Final admission decisions and ambiguous or conflicting qualifications; evidence and suggested decision already assembled. |
| Support | Answer grounded product questions, retrieve authorized account/matter facts, classify requests, connect related issues, send eligible approved routine responses, track follow-ups. | Explicit requests for a person, complaints needing discretion, sensitive promises, uncertainty, and failed resolution. |
| Follow-ups | Schedule and send approved workflow reminders; stop on reply or resolution. Proposed default: at most two unanswered reminders per issue before waiting/escalation, with no self-renewing loop. | A case requiring judgment after the bounded process finishes. |
| Finance | Read authoritative payment evidence, compare records, identify discrepancies, assemble timelines and proposed next steps. Existing deterministic lifecycle processing retains its own established rules. | Discretionary refunds, settlements, payment releases, payout changes, and unresolved money exceptions. AI does not infer a new authority to move funds. |
| Technical operations | Group repeated reports, gather diagnostics, perform explicitly allowlisted reversible recovery steps, prepare fixes and validation evidence. | Persistent failures with user impact, ambiguous outcomes, production release decisions, or a business tradeoff. |
| Marketing | Prepare one small weekly batch using approved facts and strategy; run readiness checks; consolidate feedback. | A concise batch of brand/publication decisions. Approval, scheduling, and actual publication are separate states. |
| Sales/directors | Maintain supported context, prepare follow-ups and commission evidence, run already-authorized bounded follow-up workflows. | Novel outreach commitments, relationship escalations, conflicts, and discretionary commission/payment decisions. |
| Knowledge | Reuse approved answers; identify repeated unanswered questions; draft revisions with source evidence. | Material policy changes or new unsupported guidance. Repeated owner approvals alone do not make a new answer correct. |
| Notifications | Synchronize mail and deliver existing queued notices; retry definite failures within limits; track provider outcomes. | Sustained failures and uncertain outcomes that cannot be resolved automatically. Provider acceptance must not be called confirmed inbox delivery. |

No routine task should require daily reauthorization once a narrow action policy is configured. New facts outside that policy cause escalation. Broad confidence scores and approval streaks cannot replace verified prerequisites or grant new permissions.

## Admin Assistant

Examples of intended requests:

- “What actually needs me today?” returns the same decision set as Today, with freshness and reasons.
- “Why is this payment blocked?” assembles authorized provider/application evidence and identifies what remains unknown.
- “Prepare the missing-information requests” checks current application requirements and creates specific drafts without inventing missing fields.
- “Handle the routine inquiries” executes only enabled response policies and reports completed, waiting, and escalated records separately.
- “Remind me Friday” creates a durable follow-up for the selected record.
- “Pause automatic support replies” pauses that category without disabling unrelated payment or storage lifecycle work.

Chat, Today, and background workers use the same canonical action handlers and policy checks. Chat cannot grant itself broader access. User messages, uploaded documents, emails, and webpages are evidence inputs, not trusted instructions for tool execution.

Retain evidence freshness and role/record authorization patterns from the existing Assistant. Build an admin-specific tool contract; do not enable the attorney manager for admins by changing its role allowlist. Admin access does not imply access to attorney-private notes or unrestricted disclosure to other users.

## Consolidation and removal

| Existing surface | Disposition |
| --- | --- |
| Overview and AI Control Room decision summaries | Consolidate on Today; retain inspectable run/incident evidence under System. |
| Founder Daily Log inside Marketing | Replace with the shared optional digest. |
| CCO/CMO/CSO/CTO lanes and internal processing details | Keep internal identifiers where needed; present understandable work and outcomes to the owner. |
| Separate content review | Place review with its actual content and link the same decision on Today. |
| Posting moderation | Operate within Matters. |
| Support knowledge | Manage from Inbox; reuse existing approved-source services. |
| Marketing research/cycles/briefs/packets | One owner-facing batch with advanced details available on demand. |
| Routine statistics and successful delivery counters | Reports and optional digest; no daily task. |
| Unused growth channels | Pause explicitly unused generation workflows and hide them from daily navigation; preserve historical records. Do not assume a channel is unused from empty test data. |
| Proposed employee delegation UI | Defer; there are no employees. |

## Current source findings and reuse map

Inspected September 26, 2026. Source presence is not proof of enabled production behavior.

- `backend/services/adminFlowService.js`: fixed application/inquiry/payment/matter category order; inquiry selection is not owner-filtered; deadline exceptions are owner work. Replace category priority with an evidence-based attention projection.
- `frontend/assets/scripts/admin/flow.js`: “Later” is stored in sessionStorage. Preserve existing completion rechecks while adding durable follow-up.
- `backend/services/adminAccountService.js` and `frontend/assets/scripts/admin/accounts.js`: existing readiness evidence, admission checks, information requests, and private drafts. Reuse these instead of introducing another admission record.
- `backend/routes/adminSupport.js`: assignees are approved admin users. Machine workflow state must not masquerade as a human assignee.
- `backend/ai/supportAgent.js`: existing admin-aware guidance is present. `backend/ai/supportManagerAgent.js` explicitly enables its hardened manager for attorney only. Existing admin guidance is not a complete autonomous admin execution contract.
- `backend/services/ai/autonomyPreferenceService.js`: existing preferences, streak-based suggestions, evaluations, and action handlers. A marketing “publish automatically” label leads to packet approval, not publication. Trace every autonomy label to its actual handler before reuse, including incident approval paths; do not enable all existing preferences wholesale.
- `backend/scripts/run-automation-cycle.js`: timed triggers, director follow-ups, marketing preparation, monitoring, and lifecycle work already have a scheduler entry point. Reuse rather than create competing schedulers.
- `backend/scripts/admin-communications-worker.js`: existing mail sync, alerts, and multiple persisted lifecycle notice queues. Verify configuration, heartbeat, retries, and delivery evidence before claiming hands-off communications.
- `backend/services/communicationRetry.js`: uncertain delivery requires checking provider evidence. Preserve duplicate-send protection; ambiguity is not permission to blindly retry.

## Execution requirements

Use deterministic rules for scheduling, routing, retries, and prerequisites. Use models where interpretation, summarization, or drafting adds value. Avoid model calls for unchanged records and cap work per run, spend, retries, and reminder volume. Surface a limit breach as a specific blocked task rather than an endless retry or vague AI error.

Each automatic action needs an allowed action type, scope, current source revision, prerequisites, bounded attempt policy, and audit identity. Reuse existing persistence when it supports these requirements. Add fields or a narrowly scoped execution record only when an inventory proves the existing system cannot represent the work; do not create a second matter, payment, or support truth.

Persist intent and claim work atomically before execution. Prevent duplicate effects across overlapping workers. Recheck state before consequential steps; do not overwrite a newer owner edit. After provider timeout, distinguish definite failure from unknown outcome. Recovery uses fresh evidence and preserves action history.

Prepared, approved, queued, attempted, provider-accepted, and confirmed-completed are different outcomes. Only label work completed when the actual domain operation supports it. Pausing a category prevents new work and safely handles already-claimed work; it does not pretend an in-flight external action was cancelled.

## Additional agreed operating requirements

- Configure business hours, preferred wording, reminder limits, interruptions, and narrow action policies once. The normal workflow should not ask the owner to authorize the same routine step every day.
- Let event-driven routine work continue while the owner is away. Decisions requiring Samantha wait safely; outgoing updates cannot promise a response time she has not committed to.
- When Samantha corrects a reply, offer to save the useful wording or preference. A single correction must not silently become a company policy or expand AI permissions.
- Surface repeat questions and recurring failures as one proposed product or knowledge improvement with supporting examples. Do not open a separate owner task for each repetition of the same problem.
- Provide “I’ll handle this,” category-specific pause, and durable follow-up controls. Owner takeover prevents conflicting new automatic actions while preserving a truthful account of any operation already in flight.
- Apply recipient-level disclosure checks to outbound messages. Information available to the admin Assistant is not automatically appropriate to share with the person receiving a reply.
- Provide undo where the underlying operation genuinely supports it. For irreversible messages and actions, preserve the history and offer an explicit correction path rather than claim the action was undone.
- Distinguish answering a question from resolving a problem. Track the actual workflow outcome, honor requests for a human, and reopen issues when the person remains blocked.
- Verify a complete unattended-day scenario covering applications, inquiries, missing information, replies, reminders, payment problems, owner absence, and stopped services. Measure correct completion and owner workload together.

## Implementation progress

The first foundation changes introduce priority-aware daily work, private account-persisted follow-ups, plain-language reasons, and a read-only admin Assistant answer that reads the same queue. A follow-up returns an item to the queue; it does not send an email or push notification. This step retains the existing guided review and does not represent the finished Today layout or the complete admin redesign.

The new `AdminFollowUp` record stores only personal queue scheduling and revision checks. Existing Task records belong to paralegal matter work, AdminDraft records hold encrypted writing drafts, and support followUpAt belongs to the ticket's shared operational state; none represents a private cross-record owner reminder. Source records remain authoritative and are not modified by scheduling a review.

The Assistant integration uses a narrow deterministic admin queue reader through the existing admin conversation path. It does not enable the attorney manager for admin, grant mutation tools, or claim to run routine support work. The continuation below adds more queue coverage, preparation, and workspace consolidation. Bounded automatic outbound execution, worker recovery, and complete visual redesign acceptance remain outstanding until implemented and verified.

## September 27 continuation

Today now reads pending content approvals, nonexpired technical approvals, profile-photo reviews for existing accounts, and submitted posting edits from their canonical records. They use the same priority and personal follow-up mechanism as existing operational work. Approval cards open the existing decision handlers; they do not approve content or deploy changes. Pending applicants remain one application review rather than an additional photo task.

Daily navigation is Today, People, Matters, Inbox, and Finance. Posting moderation is linked from Matters; approved knowledge and the existing content-review workspace are linked from Inbox. Growth and System remain secondary. Old section hashes remain accepted. Marketing and Sales place creation forms, statistics, research, and scheduling details behind disclosures while keeping their current controls and records.

Today has optional waiting and recent-activity sections, with explicit partial-failure states. Activity is the latest 20 recorded automation actions from seven days, not a claim that all underlying problems remain resolved. Undone actions are labeled. Communications-worker evidence is shown separately; no recent check-in is surfaced on Today rather than called healthy.

Automation presents existing approval preferences and per-category pause controls. Marketing and sales approval labels now state that approval does not publish or send. A pass rechecks its stored preference before each additional item. Opening the new status screen does not load the legacy Control Room diagnostics; those remain available on demand. The legacy diagnostics retain their existing execution behavior, which still requires a separate architectural migration before calling the complete admin read-only on navigation or fully unattended.

Application reviews prepare an optional information-request draft from known missing profile checks. Inquiry reviews retrieve a candidate approved answer using the requester's role and latest message, excluding closed, financially sensitive, and linked-incident requests. Neither replaces existing owner text without an explicit choice. Inquiry preparation detects source changes during retrieval. Both use the existing encrypted private draft store when the owner chooses the prepared text. Neither sends automatically.

Remaining: bounded automatic support/information-request sends and reminders; background ownership and takeover deadlines; comprehensive deduplication across related incidents and tickets; an actual weekly marketing batch; Director Oversight consolidation; automatic recovery and spend/message controls; all-surface tone and visual acceptance; provider/worker evidence and the unattended-day test. No deployment or new automation preference activation is included.

## Delivery sequence and acceptance

### 1. Establish one operating contract

Inventory existing admin/Assistant tools, scheduled tasks, action handlers, preferences, and communications against the table above. Produce an explicit supported/needs-work/disabled matrix. Trace existing autonomy labels through execution and authority checks. Preserve current runtime behavior during this inventory.

Acceptance: every proposed automatic action has a real handler or an identified implementation gap; every owner decision has a named reason; no staff dependency remains.

### 2. Build the shared work state and Today experience

Implement prioritization, durable follow-up, deduplicated attention, and verified outcome presentation. Connect the admin Assistant to the same read model and canonical record navigation. Produce a complete visual specification and render the key list, detail, decision, waiting, empty, partial-failure, and mobile states.

Acceptance: new signups cannot starve urgent payment work; worker-owned tasks have a deadline; missing data never renders as zero work; deferred records survive a new session; the Assistant and UI agree about what needs Samantha.

### 3. Complete bounded routine execution

Implement and verify eligible support responses, information requests, reminders, communication monitoring, and exception preparation. Reuse existing workers and event flows. Proposed outbound templates and limits must be concrete before activation; no messages are authorized merely by this document being written.

Acceptance: incoming replies cancel stale reminders; explicit human requests reach Samantha; duplicate events/workers cannot duplicate sends; stale records are rechecked; unavailable sources escalate; user-supplied instructions cannot expand authority; loop and spend limits work; owner takeover stops conflicting new work.

### 4. Consolidate all admin surfaces

Apply the disposition table across People, Matters, Inbox, Finance, Growth, System, and Director Oversight. Preserve money controls, evidence, record access, drafts, histories, and supported deep links.

Acceptance: one underlying decision is presented consistently across entry points; each consequential action shows its actual effect; no working capability disappears because its navigation destination was removed.

### 5. Verify operation and release separately

Use isolated data for backend contract checks, full owner/AI journeys, authenticated browser inspection, narrow screens, keyboard use, long records/errors, and interrupted operations. Verify actual configured workers/providers before claiming operational autonomy. Deploy only through the existing release process; local tests do not establish live delivery or production readiness.

Measure owner interventions per resolved issue, repeat reviews, age of unresolved exceptions, successful automatic outcomes, reopen/correction rate, duplicate effects, and operating cost. Establish a baseline before promising a percentage reduction. Do not reduce interruption counts by hiding failures or prematurely closing user issues.
