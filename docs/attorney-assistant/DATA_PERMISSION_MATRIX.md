# Attorney Assistant Data Availability and Permission Matrix

Audit date: July 22, 2026

This matrix defines what the attorney assistant may retrieve, what evidence state it must return, and what it must never expose. Authentication and ownership are enforcement requirements, not prompt instructions.

## Evidence-State Vocabulary

| State | Meaning | Required assistant behavior |
| --- | --- | --- |
| `verified` | An authorized source returned the requested fact and its meaning is unambiguous. | Answer directly and concisely. |
| `absent` | The authorized lookup succeeded and confirms the record/value does not exist. | State that it is not present; do not call it an outage. |
| `unknown` | Records exist, but the requested conclusion cannot be derived safely. | Name the missing or ambiguous evidence and ask one focused question only if it can resolve it. |
| `temporarily_unavailable` | The authoritative dependency or lookup failed. | Say it could not be checked right now; never convert this to `absent`. |
| `unauthorized` | The signed-in user lacks role, ownership, or record access. | Refuse the record-specific disclosure without confirming sensitive record details. |
| `not_applicable` | The question does not apply in the current workflow state. | Explain the relevant state and the next applicable step. |
| `blocked_policy` | Product rules or source definitions conflict. | Do not manufacture a definitive answer; use the approved interim limitation. |

## Account and Security Data

| Data family | Authoritative source and fields | Attorney access | Current availability | Prohibited output |
| --- | --- | --- | --- | --- |
| Identity and role | `User`: `_id`, `firstName`, `lastName`, `email`, `role`, `status` | Own authenticated record only | Available through account snapshot; role must be attorney | Password/hash, session tokens, auth internals |
| Attorney profile | `User`: firm, jurisdiction, biography, practice, publication, website/profile fields | Own record only | Fields available; completion meaning is policy-blocked | Hidden moderation/admin annotations |
| Preferences | Account preference service/route and user preference fields | Own record only | Partial assistant coverage | Other users' settings or delivery metadata not needed to answer |
| Payment-method presence | Stripe customer/default payment method, with safe stored reference where verified | Own Stripe customer only | Available; processor failure must remain distinct from no method | Card number, CVC, full bank details, client secret, raw Stripe object |
| Two-factor state | Feature flag plus user 2FA fields | Own record only | Tool gap; feature flag must be part of answer | Recovery secrets, OTP seed, backup codes |
| Deactivation eligibility | `userDeletion` eligibility service and related active workflow records | Own eligibility result only | Authoritative service exists; assistant tool missing | Other party's private details or internal admin notes |

### Exact account-field inventory

- Identity/approval: `User._id`, `firstName`, `lastName`, `email`, `role`, `status`, `disabled`, `deleted`, `deletedAt`.
- Profile/onboarding inputs: `lawFirm`, `firmWebsite`, `state`, `timezone`, `practiceAreas`, `primaryPracticeArea`, `bio`, `profilePhotoStatus`, `attorneyPricingAccepted`, `termsAccepted`, `onboarding.attorneyProfileCompleted` plus the separate fields used by the `profileCompleteness` virtual.
- Preferences: `preferences.theme`, `preferences.fontSize`, `preferences.hideProfile`, `notifications`, `notificationPrefs`, `digestFrequency`, `emailPref`.
- Security markers safe for a future normalized tool: feature flag `ENABLE_TWO_FACTOR`, `twoFactorEnabled`, `twoFactorMethod`, and safe recent-session/audit projections where approved. `twoFactorTempCode` and `twoFactorBackupCodes` are forbidden.
- Billing readiness: `stripeCustomerId` identifies the attorney's customer; saved-method presence must come from the Stripe Customer/PaymentMethod lookup rather than the identifier alone.

## Matter and Workflow Data

| Data family | Authoritative source and fields | Attorney access | Current availability | Prohibited output |
| --- | --- | --- | --- | --- |
| Matter identity/status | `Case`: owner fields, title, status, lifecycle timestamps | Owning attorney only | Available; automatic likely-case selection is unsafe | Existence/details of a non-owned case |
| Participants | `Case`: attorney, assigned/withdrawn paralegal and allowed public identity fields | Owning attorney only | Available when ownership passes | Private profile/contact fields not needed for the workflow |
| Applications | Embedded case applicants plus Job `Application` records | Owned matters only | Incomplete because two stores are not merged | Applicants on another attorney's matter; internal review metadata |
| Invitations | Case/invitation records and invitation workflow route state | Owned matters only | Partial; eligibility evaluator missing | Unnecessary payout-account details of invitee |
| Pre-engagement | Case pre-engagement fields and route state | Owned matters only | Partial; details and next actor missing | Uploaded agreement content unless separately authorized and required |
| Scope tasks | `Case.tasks`, including completion/lock state | Owned matters only | Available, but task ownership cannot be inferred | Claim that an unassigned task is owed by a particular person |
| Standalone tasks | `Task` model/routes | Authorized matter only | Policy-blocked because relationship to scope tasks is unresolved | Combined counts that imply both systems are one source |
| Files | `CaseFile` plus legacy `Case.files` metadata | Authorized matter only | Merged listing is partial; storage/download readiness not proven | Raw storage keys, signed URLs beyond their intended use, files from another case |
| Messages | Case conversation/message service and canonical viewed-state fields | Active authorized workspace only | Partial; unread calculation is inconsistent | Messages from non-owned/nonparticipant conversations; hidden moderation data |
| Deadlines | Case deadline and the accepted task system's due dates | Owned matters only | Future deadline partial; overdue rollup missing | Deadline certainty when source date/time semantics are ambiguous |
| Internal notes | Case internal/admin notes | Not attorney-visible unless product explicitly classifies an attorney-authored subset | Unsupported and sensitive | Admin notes, staff deliberations, hidden fraud/risk annotations |

### Exact matter-field inventory

- Ownership/participants: `Case.attorney`, `attorneyId`, `paralegal`, `paralegalId`, `pendingParalegalId`, `withdrawnParalegalId`, and `jobId` for cross-store reconciliation.
- Core/lifecycle: `title`, `practiceArea`, `details`, `state`, `locationState`, `status`, `deadline`, `hiredAt`, `completedAt`, `pausedReason`, `pausedAt`, `readOnly`, `archived`, `paralegalAccessRevokedAt`.
- Work: `tasks`, `tasksLocked`, `applicants`, `invites`, `preEngagement`, `files`; separate `Task`, `Application`, and `CaseFile` records remain independently identified until canonical merge rules exist.
- Withdrawal/relist: `disputeDeadlineAt`, `partialPayoutAmount`, `payoutFinalizedAt`, `payoutFinalizedType`, `relistRequestedAt`, `relistPending`, `remainingAmount`.
- Completion/archive: `paymentReleased`, `paidOutAt`, `archiveZipKey`, `archiveReadyAt`, `archiveDownloadedAt`, `purgeScheduledFor`, `purgedAt`. `archiveZipKey` is internal storage metadata and must not be displayed.
- Termination/moderation: `terminationStatus`, `terminationRequestedAt`, `terminationRequestedBy`, `terminatedAt`, `disputes`, `flags`, `moderationStatus`, `moderationFlaggedAt`, `moderationResolutionRequestedAt`. Attorney output requires field-level privacy review.

## Financial Data

| Data family | Authoritative source and fields | Attorney access | Current availability | Prohibited output |
| --- | --- | --- | --- | --- |
| Matter amount | Per-case locked/original/remaining amount fields, with lifecycle meaning | Owning attorney only | Available but requires state-aware labels | Amount from a different matter or guessed value |
| Attorney fee | Per-case fee snapshot first; centralized current policy only for prospective estimates | Owning attorney or general policy explanation | Partial; duplicated defaults and timing conflict | Recalculating historical fees from today's default |
| Total charge | Verified PaymentIntent/charge snapshot or exact stored transaction record | Owning attorney only | Partial; live processor/snapshot parity required | Full payment credentials, client secrets, raw processor error payload |
| Paralegal payout/fee | Finalized payout/transfer fields for owned case | Owning attorney only when product permits | Partial; pending vs finalized must be distinct | Paralegal bank/Connect account data |
| Funding state | Case funding fields plus verified processor state when material | Owning attorney only | Partial; failed/requires-action/canceled distinctions incomplete | Claiming money was charged, held, refunded, or released without verified evidence |
| Billing summary/history | Payment routes and authorized transaction records | Own account/owned cases only | Backend exists; assistant tool missing or incomplete | Other users' transactions, raw processor metadata |
| Invoice/receipt | Generated document record and retrievable storage object | Own transaction/owned case only | History partial; readiness must not be inferred from completion | Claim that a document is downloadable unless retrieval is verified |
| Refund/dispute settlement | Finalized case/payment/dispute records | Owning attorney only | Partial | Admin-only settlement notes or unfinalized amounts presented as final |

### Exact financial-field inventory

- Matter/case snapshots: `currency`, `totalAmount`, `lockedTotalAmount`, `amountLockedAt`, `feeAttorneyPct`, `feeAttorneyAmount`, `feeParalegalPct`, `feeParalegalAmount`, `remainingAmount`, and `partialPayoutAmount`.
- Funding/processor references: `escrowIntentId`, `paymentIntentId`, `stripeMode`, `escrowStatus`, `paymentStatus`. Processor IDs are lookup keys/provenance, not user-facing proof by themselves.
- Release/settlement: `paymentReleased`, `paidOutAt`, `payoutFinalizedAt`, `payoutFinalizedType`, `payoutTransferId`, and `disputeSettlement.action`, `grossAmount`, fee snapshots, `payoutAmount`, `refundAmount`, `resolvedAt`.
- Authoritative external evidence where stored state is insufficient: Stripe Customer default payment method, PaymentIntent/Charge status and amounts, Refund state, and Transfer/Payout state, queried only for the authenticated attorney's owned transaction relationship.

## Knowledge and Navigation Data

| Data family | Authoritative source | Attorney access | Current availability | Prohibited output |
| --- | --- | --- | --- | --- |
| General product explanation | Approved, versioned knowledge source | All authenticated attorney users | Available only where it does not conflict with code/policy | Treating FAQ prose as proof of account state |
| Workflow requirements | Shared executable policy target | Attorney and owned subject where applicable | Not yet centralized | Answering solely from model memory or UI copy |
| Navigation destination | Approved route/action registry | Attorney routes only | Partial | Links/actions the user cannot access |
| Troubleshooting | Approved support knowledge plus actual dependency status | Attorney | Partial | Invented outage, fix, ticket, or escalation status |

## Tool Authorization Contract

Every attorney tool must:

1. Derive user identity and role from the authenticated request context.
2. Reject a non-attorney session before querying attorney records.
3. Enforce matter ownership in the database query, not after returning a record.
4. Retrieve only fields needed by its declared response contract.
5. Return one evidence state for each requested conclusion.
6. Distinguish lookup failure, missing data, and inaccessible data.
7. Include safe source/freshness metadata when timing affects the conclusion.
8. Never accept a model-supplied user ID as authority.
9. Never return secrets, payment credentials, internal prompts, raw stack traces, or admin-only notes.
10. Never infer another person's obligation, intent, or action without an explicit source field.

## Current Tool Access Inventory

This is an audit of the present allowlist, not a declaration that each tool is complete. All tools require an authenticated session; attorney-scoped entries require `role=attorney` and an approved account under the support route.

| Tool | Current attorney access rule | Ownership / record rule | Audit disposition |
| --- | --- | --- | --- |
| `search_lpc_knowledge` | Attorney allowlisted | Approved general knowledge only; no account evidence | Partial because conflicting knowledge is not suppressed |
| `get_my_case_overview` | Attorney only | Query by authenticated attorney owner ID | Partial; lifecycle definitions and aggregate completeness need policy/tests |
| `get_case_details` | Attorney only | Resolved case must be owned by authenticated attorney | Partial; unsafe automatic likely-case resolution |
| `get_attorney_case_financials` | Attorney only | Owned resolved case | Partial; snapshot/calculation parity required |
| `get_attorney_case_workspace` | Attorney only | Owned resolved case; returns attorney-visible projection | Partial; incomplete lifecycle and dual-store semantics |
| `get_attorney_receipt_history` | Attorney only | Owned cases/attorney transactions | Partial; capped results and retrieval readiness gap |
| `get_attorney_account_snapshot` | Attorney only | Authenticated user's own User record | Partial; profile, preference, and 2FA definitions unresolved |
| `get_next_deadline` | Attorney only | Owned cases | Partial; no overdue result and task authority unresolved |
| `get_pending_paralegal_activity` | Attorney only | Owned cases | Unsafe; unassigned tasks are attributed to paralegal |
| `get_attorney_application_activity` | Attorney only | Owned cases | Partial; omits separate `Application` records |
| `get_attorney_message_activity` | Attorney only | Eligible owned case conversations | Partial; unread semantics conflict |
| `get_attorney_attention_summary` | Attorney only | Aggregates authenticated attorney's owned/account data | Gap; signal taxonomy incomplete |
| `get_billing_snapshot` | Attorney only | Authenticated attorney's Stripe customer/account | Partial; unavailable and absent states collapse |
| `get_attorney_workflow_readiness` | Attorney only | Own account plus owned subject where supplied | Gap; only payment readiness is implemented |
| `get_messaging_state` | Attorney only | Owned case and workspace-participation rules | Partial; must share canonical messaging policy |
| `find_navigation_destination` | Attorney allowlisted | Attorney route allowlist only | Partial; destination coverage and relevance incomplete |

`get_payout_snapshot` exists for paralegal use and is not attorney-allowlisted. It must remain unavailable to the attorney assistant unless a future contract creates a distinct, ownership-safe attorney payout view.

## Explicit Non-Ready Areas

The following remain blocked or incomplete after Package 1: merged applications, task-system authority, file-system authority, canonical unread state, task ownership, profile completion, 2FA availability, deactivation eligibility, archive/receipt readiness, complete financial state, workflow-policy parity, and safe automatic matter resolution. They must not be advertised as reliably answerable until their Package 2 retrieval and policy contracts pass authorization tests.
