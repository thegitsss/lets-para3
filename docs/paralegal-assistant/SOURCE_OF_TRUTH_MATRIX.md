# Paralegal Assistant Source-of-Truth Matrix

Audit date: July 23, 2026

This is an independent paralegal inventory. “Current source” means represented in code, not automatically safe or complete enough for manager use.

| ID | Capability family | Required authoritative source | Current state | Package 1 disposition |
| --- | --- | --- | --- | --- |
| P01 | Assigned matter overview | `Case` queried by authenticated `paralegal`/`paralegalId`, plus withdrawn history where explicitly requested | Broad shared overview exists | Partial: lifecycle totals and archived/read-only semantics need policy |
| P02 | Matter details and attorney | Authorized `Case` projection and safe attorney identity | Shared case details exist | Partial: least-privilege paralegal projection is not independently defined |
| P03 | Deadlines | Authorized case deadline plus approved task authority | Shared next-deadline tool exists | Policy-blocked: embedded and standalone task dates are not reconciled |
| P04 | Scope tasks and progress | `Case.tasks`, `tasksLocked`, assignment and completion state | Legacy chat reads embedded tasks | Partial: responsibility and completion authority require shared policy |
| P05 | Files, deliverables, and revisions | `Case.files`, `CaseFile`, storage existence where approved | No complete paralegal manager tool | Policy-blocked: metadata, review state, and retrieval readiness are not canonical |
| P06 | My applications | `Application` plus the signed-in paralegal’s matching `Case.applicants` | `/applications/my` merges some paths | Partial: dual-store reconciliation and status precedence need a service |
| P07 | Browse and application eligibility | Browse/jobs/cases query plus approval, block, assignment, and open-state rules | Product routes exist | Partial: support tool and executable eligibility explanation are missing |
| P08 | Invitations | `Case.invites` plus legacy pending fields for the authenticated paralegal | Product endpoints exist | Partial: pending/accepted/declined/revoked precedence is not centralized |
| P09 | Pre-engagement | `Case.preEngagement` when `requestedParalegalId` matches | Route-scoped projection exists | Partial: next actor, document readiness, and changes-requested policy need normalization |
| P10 | Hiring/assignment start | Accepted application/invite, funded matter, scope tasks, Stripe readiness, assignment timestamps | Mutation routes enforce several checks | Partial: no read-only readiness tool; invitation acceptance and attorney hire have different gates |
| P11 | Workspace access | Assignment, status, read-only, archive, block, withdrawal, revocation fields | Shared workspace snapshot exists | Partial: one canonical access decision is missing |
| P12 | Messaging availability | Messaging service, authorized matter, block state, completion/read-only rules | Shared messaging tool exists | Partial: conversation selection and send eligibility need paralegal-specific tests |
| P13 | Unread and response state | `Message` plus canonical viewed markers and participant role | No paralegal account-wide manager tool | Policy-blocked: unread/awaiting-reply semantics are incomplete |
| P14 | Stripe payout setup | Live Stripe Connect account, safe stored markers as fallback | Context resolver reads both | Partial: live outage and absent setup can collapse; raw account ID must not reach output |
| P15 | LPC release and payout timing | Completion/release policy, `Case` release fields, `Payout`, Stripe transfer/payout evidence | General workflow policy and latest snapshot exist | Partial: release, transfer, payout, and bank arrival must remain distinct |
| P16 | Payout history | `Payout` by authenticated paralegal, authorized case history | Latest payout only in manager tool; dashboard route has broader history | Partial: capped complete history and case labels need a tool |
| P17 | Matter payout breakdown | Locked gross, historical fee snapshot, settlement, finalized `Payout.amountPaid` | No paralegal matter-financial tool | Gap: gross, platform fee, net, finalized, and pending values must not be recomputed ambiguously |
| P18 | Paralegal platform fee | Historical case fee snapshot; central policy only for prospective explanation | General policy exists | Partial: historical/prospective distinction needs validator coverage |
| P19 | Withdrawal eligibility | Assigned active case, task completion, status, dispute, prior withdrawal | Mutation route contains rules | Gap: read-only evaluator shared with route is missing |
| P20 | Withdrawal/dispute outcome | `withdrawnParalegalId`, pause/dispute window, finalized type, partial amount, settlement, receipts | Multiple case/payment routes | Partial: current status, next actor, gross/net amount, and receipt readiness need one source |
| P21 | Completion and release | Tasks, case status, `completedAt`, `paymentReleased`, `paidOutAt`, `Payout` | Shared workflow policy covers general lifecycle | Partial: paralegal-side next actor and bank timing need a dedicated contract |
| P22 | Disputes and moderation | Paralegal-visible dispute/flag state only | Case fields/routes exist | Policy-blocked: internal/admin notes and risk signals must remain excluded |
| P23 | Profile completion | Own `User` profile fields and an approved completeness definition | Many fields exist; no canonical paralegal completeness service | Policy-blocked: onboarding, browse visibility, and profile quality definitions differ |
| P24 | Availability and search visibility | Own availability, hide-profile, approval, photo, and browse filters | Product routes/fields exist | Partial: visibility reason and next step are not normalized |
| P25 | Resume, certificate, and samples | Own safe metadata/readiness only | User fields and application snapshots exist | Policy-blocked: object availability and moderation status are not fully represented |
| P26 | Preferences and notifications | Own preference and notification settings | Fields/routes exist | Partial: assistant snapshot and safe mutation boundary are missing |
| P27 | Security | Global feature state plus own safe 2FA/session markers | Fields exist | Partial: no paralegal-specific tool; secrets are forbidden |
| P28 | Deactivation | Shared eligibility service over own active work/application/payout blockers | Service exists for attorney hardening | Gap: paralegal blockers and wording are not contracted |
| P29 | Archive, completed, and read-only access | Authorized case archive/read-only/revocation/purge fields and storage checks | Dashboard routes expose partial history | Policy-blocked: storage readiness and post-withdrawal access are not canonical |
| P30 | Navigation | Role allowlist for cases, completed, applications, browse, payouts, messages, profile, help, contact | Shared destination tool exists | Implemented foundation; relevance and one-action UI still require paralegal tests |
| P31 | Product knowledge | Approved versioned knowledge subordinate to workflow/live evidence | Search tool exists | Partial: conflicting prose must not override executable policy |
| P32 | Legal/drafting/mutation boundary | Role policy and response contract | General boundary exists | Boundary: no legal advice, work product, filing, communication, or record changes |

## Present manager-tool inventory

| Tool | Paralegal access | Material limitation |
| --- | --- | --- |
| `search_lpc_knowledge` | Approved general knowledge | Cannot prove account or workflow state |
| `get_my_case_overview` | Assigned/withdrawn cases through shared scope query | Not a paralegal lifecycle contract |
| `get_case_details` | Shared accessible-case resolver | Projection and ambiguity rules are not independently approved |
| `get_next_deadline` | Accessible paralegal cases | Does not reconcile task systems |
| `get_payout_snapshot` | Authenticated paralegal latest relevant case/payout | Latest-only, broad, and incomplete for amount/timing/history questions |
| `get_messaging_state` | Accessible matter | Needs paralegal-specific authorization and state tests |
| `find_navigation_destination` | Paralegal allowlist | Safe foundation; response relevance still requires validation |

## Package 2 build priorities

1. Application/invitation/pre-engagement aggregate.
2. Assigned-matter workspace/readiness aggregate.
3. Paralegal payout setup/history/matter-financial aggregates.
4. Withdrawal/completion/release policy evaluators.
5. Profile/visibility/account/attention aggregates.
6. Paralegal-specific planner, validator, safe fallback, telemetry, and rollout contracts.
