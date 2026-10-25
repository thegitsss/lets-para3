# Admin execution contract and remaining implementation

Updated September 30, 2026. Checklist D01-D09; source reconciliation and isolated verification, not production enablement.

Samantha is the human operator. Existing source records remain authoritative. An automatic approval is not a sent reply, a published post, a resolved inquiry, or a released payment.

| Workflow | Existing handler / record | Implemented boundary | Still required for the complete target |
| --- | --- | --- | --- |
| Today and durable personal follow-up | `adminFlowService`, `AdminFollowUp`, `adminAttentionService` | Owner queue, persisted snooze/revision, deterministic Assistant queue read | Complete list/detail/empty/partial-failure visual acceptance; deduplicate genuinely identical decisions across domains |
| Incoming support email | `support/mailboxSyncService`, `AdminInboundMail`, `SupportTicket` | Exact message-reference and sender matching; durable import; replay protection | Provider acceptance and configured worker evidence; no assumption that provider acceptance proves inbox delivery |
| Incoming requester replies and reminders | `support/answeredFollowUp`, human handoff and transactional support routing | A fresh reply clears an older waiting-for-requester reminder; newer owner schedules remain; queued overdue alerts recheck current state | Outbound automatic reminder policy, scheduling/attempt limits, recipient disclosure and pause/takeover behavior are separate work |
| Support reply preparation | `adminPreparationService.prepareInquiry`, approved knowledge retrieval | Role-scoped candidate answer, risk exclusions, current-source check; owner reviews the draft | Deterministic eligibility and persisted intent/claim for automatic sends; recipient disclosure; bounded policy; reliable outcome reconciliation |
| Missing application information | `adminPreparationService.prepareApplication`, `adminAccountService`, encrypted `AdminDraft` | Draft from known missing fields; current manual send has a request ID and delivery history | Automatic eligibility, stale-source recheck, configured policy and bounded reminders; no fabricated missing requirements |
| Human-requested support | `support/adminInboxService.handleHumanRequest` | Canonical ticket, same conversation, preserved operator ownership and notes | Owner takeover must also fence any future automatic sender; a human request must never silently become automated resolution |
| Governed answer/marketing/sales approval | `ai/autonomyPreferenceService`, `ApprovalTask`, `AutonomyPreference`, `AutonomousAction` | Current policy and reviewed source, transactional domain/action writes, concurrent pause write fence, per-pass attempt bound; failures return to owner | Daily approval attempt limits and transactionally persisted approval-event recovery are implemented. Outbound message and spending limits remain separate work |
| Publication and outreach delivery | Existing marketing/director handlers | Separate from draft approval; existing permission and readiness checks remain | One actual weekly review batch, Director Oversight consolidation, intended-provider evidence; no activation from this document |
| Financial exceptions | Existing Matter/payment/dispute handlers and Admin Finance projections | Owner review; existing deterministic lifecycle remains authoritative | Paired record/provider evidence, finance acceptance, exact authorized live test/reconciliation |
| Technical decisions | Existing incident approval/release handlers | Production release decisions remain Samantha-only, including legacy automatic preferences | Exact candidate, substantive engineering/security reviews, required tests and operational drills; Samantha's final approval; no independent reviewer requirement |
| Knowledge corrections | Existing governed knowledge/review services | Approval is explicit and source-backed | Deliberate save of useful owner corrections; one evidence-backed improvement for repeated unanswered questions |
| Scheduled work and recovery | `run-automation-cycle`, `automationCycleStatus`, communications worker | Separate execution evidence; running/completed/paused/failed; stale evidence is not healthy | Persistent task ownership/deadline, recovery for claimed work, category pause, business hours and interruption policy, unattended-day acceptance |
| Admin Assistant | `adminAssistantService`, existing support mutation receipt | Reads the owner queue and recorded background status; exact commands pause the three supported draft-approval categories transactionally with their reply and audit | Additional governed actions and production acceptance; no automatic sends, publication, account decisions or financial writes through chat |

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


## September 30 operational audit

Admin is not yet certified for unattended solo operation. The existing cards and sidebar remain. Overview now exposes the complete Needs you queue, including decisions outside the five cards, and warns when background-service evidence is unavailable or stale. The Assistant opens that same review queue. Finance counts include open Matter disputes. Explicit Control Room harness inquiries are excluded from owner work without hiding genuine requests that merely mention testing.

Automatic support-answer, marketing-draft and sales-draft approval events now commit in the same transaction as the approval. A scheduled recovery pass claims pending or failed decision events, recovers expired claims, retries at most five times with backoff, and reports exhausted recovery in System. Marketing evaluation writes share the approval transaction. Recovery finishes recorded decisions only; it cannot approve another draft, publish, send mail or move money. Older decisions cannot close newer approval or stale-knowledge alerts. Historical decisions with no persisted event are not reconstructed by this change.

Local evidence is saved in `docs/audits/admin-readiness-2026-09-30/`. These are separate source snapshots, not one release-candidate run:

- 288 operational backend checks passed across 18 suites before the recovery implementation.
- 71 approval and operational compatibility checks passed across nine suites, including the corrected dispute count.
- 40 recovery and owner-queue checks passed; the later focused recovery and Assistant run passed eight checks, including the newer knowledge-alert guard.
- Ten default-menu Chromium checks passed, covering desktop, tablet, phone, Inbox, System, payment search and admin Security. Overview desktop and the owner review queue were visually inspected. Financial report screenshots additionally exposed a narrow toolbar overlap that width assertions alone missed; a containment assertion was added.

The first owner-queue browser attempt timed out during fixture setup before running a scenario. The retained Finance browser suite initially pointed at moved navigation controls; its paths were updated to the current System and Finance menus while preserving the operational assertions. It then detected insufficient shared email contrast; the existing blue was darkened. The retained Finance collection passed 60 of 68 checks initially; the affected email, navigation and chart checks passed in focused reruns after correction (13 of 14 in the follow-up run, then the remaining dispute-link check passed). All 68 scenarios therefore have passing local evidence across those runs, not one frozen-candidate run. The owner-queue collection passed 11 of 12; the corrected queue-mode path and a repeated default-layout check both passed in the next run. The final toolbar-height correction passed the default-workspace check at desktop, 390px and 320px widths. The final 320px Inbox screenshot was inspected and shows no toolbar overlap.

The frontend build passed, and binding checks passed for 16 touched modules. Earlier repository-wide binding checks reported unrelated unused bindings in publicParalegalDirectory and paralegal-v2/work-view; those concurrent work areas were left unchanged. A pinned Render blueprint schema and production-contract check passed. Local communications configuration fails because email sending is disabled; required local mailbox and backup-monitoring keys are absent. This does not establish the live Render configuration. An unauthenticated production request to the admin flow API returned 401, but production did not expose a release-commit header. No authenticated deployment, mailbox, payment-provider or backup evidence was available in this session. The installed Render CLI returned unauthorized on its read-only identity check. No real message, payment, publication, preference activation or deployment was performed.

Remaining source work still includes automatic outbound reply/information/reminder policies and their fenced execution, weekly marketing and Director consolidation, and broader governed Admin Assistant actions. The first bounded Assistant action is described below. These gaps are not closed by draft preparation or approval recovery. Production acceptance additionally requires the intended connections, an exact deployed candidate, provider reconciliation and the unattended-day exercise. Preserve the previously agreed email-last ordering.


## September 30 weekly preparation

The existing marketing preparation schedule now supports Weekly. Its default remains disabled and manual; no stored policy was changed. Recurring preparation preserves the chosen local hour across daylight-saving changes. Nineteen scheduling and existing publishing-workflow checks passed, including open-cycle limits, approval states, midnight handling and both clock changes (`weekly-preparation.json`). This adds weekly cadence to the existing cycle system; it does not by itself complete the consolidated weekly review experience or authorize publication.

## September 30 bounded Assistant actions

The Admin Assistant now answers background-status questions from the existing persisted activity feed. Missing, stale and failed evidence remains visible. Its initial prompts are “What needs me?”, “What is AI doing?” and “What can you do?”

The exact commands “Pause marketing approvals”, “Pause support approvals”, “Pause outreach approvals” and “Pause all approvals” pause the corresponding draft-approval preferences. The server parses the original user message against an allowlist; model output and client role hints cannot add an action. A fresh approved-admin check and account write fence protect execution. The preference change, audit record, assistant confirmation and existing idempotent request receipt share one transaction. Retrying the same request returns the saved outcome. An open System page refreshes after the saved result.

“All” covers these three draft-approval categories only. It does not stop the scheduler, mailbox importer, already completed work or every background service. Broader pause/enable commands explicitly leave settings unchanged. No absent preference is created, no automatic preference is enabled, and no live account or provider was changed during implementation.

The initial Assistant collection passed 15 checks. A later focused run passed six Assistant checks, including three additional unsupported-command cases, plus two existing concurrent-pause regressions. Together these cover 18 Assistant scenarios and two worker regressions, not 23 distinct scenarios. The first browser attempt selected the hidden legacy launcher; after switching to the visible admin Assistant button, the desktop flow passed and its screenshot was inspected. These local results are retained under `docs/audits/admin-readiness-2026-09-30/assistant/`. No production activation is implied.

The final Chromium run passed through the visible starting prompt, status read, saved pause and immediate System refresh. It also verified the 390px phone layout and feedback icons no larger than 18px. Both screenshots were inspected. The generic support greeting is hidden, leaving three starting prompts; the intermediate test that expected a visible greeting was corrected to assert those actual prompts. The final report and screenshots are `assistant/browser-final.json`, `assistant/assistant-pause-desktop.png` and `assistant/assistant-pause-phone.png`. The local Mongo fixture required forced shutdown during cleanup, but the run completed with exit code zero. This remains isolated synthetic evidence, not production or unattended-day acceptance.

## September 30 unresolved-dispute visibility

Needs you now uses the same unresolved-dispute definition as Finance. A changed parent Matter status or a legacy dispute with no status no longer hides the outstanding decision. An unresolved dispute is urgent and opens dispute review. Multiple disputes on the same Matter produce one Matter review item; resolved and rejected disputes do not keep the item open. This is a read-only projection correction and does not settle a dispute or move funds.

All 37 owner-queue checks passed (`assistant/dispute-queue.json`). The frontend build and targeted binding checks for five changed modules passed. The broader frontend binding check reported an unrelated unused `search` binding in `paralegal-v2/work-view.mjs`; that concurrent work area was not modified by this admin pass.
