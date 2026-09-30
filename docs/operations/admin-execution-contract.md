# Admin execution contract and remaining implementation

September 29, 2026. Checklist D01-D09; source reconciliation, not production enablement.

Samantha is the human operator. Existing source records remain authoritative. An automatic approval is not a sent reply, a published post, a resolved inquiry, or a released payment.

| Workflow | Existing handler / record | Implemented boundary | Still required for the complete target |
| --- | --- | --- | --- |
| Today and durable personal follow-up | `adminFlowService`, `AdminFollowUp`, `adminAttentionService` | Owner queue, persisted snooze/revision, deterministic Assistant queue read | Complete list/detail/empty/partial-failure visual acceptance; deduplicate genuinely identical decisions across domains |
| Incoming support email | `support/mailboxSyncService`, `AdminInboundMail`, `SupportTicket` | Exact message-reference and sender matching; durable import; replay protection | Provider acceptance and configured worker evidence; no assumption that provider acceptance proves inbox delivery |
| Incoming requester replies and reminders | `support/answeredFollowUp`, human handoff and transactional support routing | A fresh reply clears an older waiting-for-requester reminder; newer owner schedules remain; queued overdue alerts recheck current state | Outbound automatic reminder policy, scheduling/attempt limits, recipient disclosure and pause/takeover behavior are separate work |
| Support reply preparation | `adminPreparationService.prepareInquiry`, approved knowledge retrieval | Role-scoped candidate answer, risk exclusions, current-source check; owner reviews the draft | Deterministic eligibility and persisted intent/claim for automatic sends; recipient disclosure; bounded policy; reliable outcome reconciliation |
| Missing application information | `adminPreparationService.prepareApplication`, `adminAccountService`, encrypted `AdminDraft` | Draft from known missing fields; current manual send has a request ID and delivery history | Automatic eligibility, stale-source recheck, configured policy and bounded reminders; no fabricated missing requirements |
| Human-requested support | `support/adminInboxService.handleHumanRequest` | Canonical ticket, same conversation, preserved operator ownership and notes | Owner takeover must also fence any future automatic sender; a human request must never silently become automated resolution |
| Governed answer/marketing/sales approval | `ai/autonomyPreferenceService`, `ApprovalTask`, `AutonomyPreference`, `AutonomousAction` | Current policy and reviewed source, transactional domain/action writes, concurrent pause write fence, per-pass attempt bound; failures return to owner | Durable daily/spend/message limits; recover post-commit work |
| Publication and outreach delivery | Existing marketing/director handlers | Separate from draft approval; existing permission and readiness checks remain | One actual weekly review batch, Director Oversight consolidation, intended-provider evidence; no activation from this document |
| Financial exceptions | Existing Matter/payment/dispute handlers and Admin Finance projections | Owner review; existing deterministic lifecycle remains authoritative | Paired record/provider evidence, finance acceptance, exact authorized live test/reconciliation |
| Technical decisions | Existing incident approval/release handlers | Production release decisions remain owner-only, including legacy automatic preferences | Exact candidate, independent review, deployment approval and operational drills |
| Knowledge corrections | Existing governed knowledge/review services | Approval is explicit and source-backed | Deliberate save of useful owner corrections; one evidence-backed improvement for repeated unanswered questions |
| Scheduled work and recovery | `run-automation-cycle`, `automationCycleStatus`, communications worker | Separate execution evidence; running/completed/paused/failed; stale evidence is not healthy | Persistent task ownership/deadline, recovery for claimed work, category pause, business hours and interruption policy, unattended-day acceptance |

## Completion order

Owner ordering update, September 29: defer all remaining email work until the end. Continue non-email queue, ownership, recovery, and interface work first; retain outbound policy and provider acceptance as outstanding work rather than blocking earlier implementation on an inbox choice.

1. Close the reproduced reminder and pause races with isolated regression evidence.
2. Define the concrete automatic reply/information-request policies and outbound templates. Keep them inactive until explicitly enabled through their intended owner controls.
3. Persist bounded work intent, claims, source revision, next action and outcome on existing canonical records where possible. Inventory existing queues before introducing an execution record.
4. Implement takeover and pause against that same claim boundary. Distinguish queued, attempted, provider-accepted, uncertain and completed; never blindly retry an uncertain send.
5. Enforce configured reminder, attempt, spending and message limits transactionally across overlapping workers. Surface blocked work rather than hiding it.
6. Complete weekly marketing/Director Oversight and the Admin Assistant action contract, then inspect every retained surface and run the unattended-day test.

The presence of existing preparation, private reminders, automatic draft approval or worker evidence does not close steps 2-6. No source inventory, local test or owner preference authorizes sending a real message or deploying a release by itself.

## September 29 daily approval bounds

Existing automatic support-answer, marketing-draft and outreach-draft approvals now reserve a persisted daily attempt before entering the domain transaction. The default is 25 attempts per category per UTC day, in addition to the existing ten-attempt per-pass limit. Overlapping workers share the allowance; process restart, a failed domain write or a rolled-back approval does not refund an attempt. The policy still must be automatic when the domain transaction executes, so reserving an attempt never overrides an owner pause. The limit is represented on the existing preference, not a second work queue. System policy details report the recorded daily usage.

This bounds existing approval work only. It does not implement automatic replies, information requests, reminders, dollar spending caps or publication. No actual preference was enabled. The initial focused collection passed 45/46; its new concurrent-cap case omitted the existing eligibility history and therefore correctly produced no approval. With an eligible fixture, both new daily-limit cases pass (`outputs/completion-2026-09-29/admin-daily-limit-final.json`). The original collection retains the existing owner-pause, rollback and per-pass checks.

## September 29 owner-decision preservation

FAQ pattern generation now proposes a single candidate without overwriting owner-edited text, resetting an approved/rejected state, or changing the source revision timestamp on an unchanged rerun. Task creation rechecks the current candidate inside a transaction and writes a candidate claim before creating the pending task. Concurrent generators converge on one task; a competing owner approval or rejection prevents task recreation. The request event is published only after the creation transaction commits. Four focused support-phase-2 checks pass, including both owner-decision races (`outputs/completion-2026-09-29/support-faq-owner-race-final.json`). This does not finish cross-domain decision consolidation or the automatic outbound support workflow.

Unconfirmed or disabled email sending remains owner work. The attention projection says to check delivery rather than inviting another reply, and the activity projection excludes those records from its waiting-on-user count. The underlying delivery record is retained; no resend is triggered by viewing either projection. All 33 admin-flow checks pass (`outputs/completion-2026-09-29/admin-delivery-waiting-final.json`).

## September 29 due personal follow-ups

An unchanged record whose personal follow-up is due now receives high queue priority before pagination, behind urgent payment exceptions. The queue and selected review explain that the follow-up is due. The schedule belongs to its owner; another admin does not inherit its priority, and changed source revisions do not inherit an outdated reminder. Resolved records still drop out through their authoritative source status. All 34 backend queue checks pass (`outputs/completion-2026-09-29/admin-due-follow-ups.json`), including a due record beyond a full page of older routine work. All three browser engines pass the narrow-screen application follow-up check (`outputs/completion-2026-09-29/admin-due-follow-ups-browser.json`); the Chromium screenshot was visually inspected. This is an owner-facing reminder only and sends no messages.
