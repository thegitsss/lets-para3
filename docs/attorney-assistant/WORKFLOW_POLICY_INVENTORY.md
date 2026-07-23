# Attorney Workflow Policy Inventory

Audit date: July 22, 2026

This document records current enforcement. It is descriptive, not an endorsement of every current rule. Package 2 must centralize accepted rules and resolve the conflicts noted here before the assistant treats them as authoritative.

## Global Access

| Workflow | Current enforcement | Source | Assistant implication |
| --- | --- | --- | --- |
| Open authenticated support | Valid authenticated user, approved status, role attorney/paralegal/admin | `backend/routes/support.js` | Attorney-specific tools must still independently enforce attorney role and ownership. |
| Access a matter | Admin, owning attorney, assigned paralegal, or explicitly allowed applicant depending on route | `requireCaseAccess`, `ensureCaseParticipant` | The assistant may expose a matter only when the tool confirms the signed-in attorney owns it. |
| Blocked user pair | Several application, invite, hire, and messaging routes check active blocks | `utils/blocks.js`, workflow routes | Tools must report a safe blocked state without exposing unnecessary information about the other user. |

## Posting and Drafts

### Published case route

`POST /api/cases` currently requires for an attorney:

- Approved attorney session and CSRF.
- A Stripe customer with a default payment method.
- Title and nonempty narrative details.
- A recognized practice area.
- Budget greater than zero and at least $400.
- A valid deadline if one is provided.
- Tasks are optional at posting time.

The created case begins `open`; a Job mirror is attempted afterward. Failure to create the Job mirror is logged but does not roll back the Case.

### Direct job route

`POST /api/jobs` currently requires:

- Approved attorney session and CSRF.
- A default payment method.
- Attorney profile state.
- Title of at least five characters.
- Description of at least 50 characters.
- A recognized practice area.
- Budget between $0.01 and $30,000, rounded to whole dollars.

### Draft route

Case drafts are owner-scoped. Draft compensation is optional; when supplied, it need only be greater than zero. A draft may therefore be below the published $400 threshold, which can be acceptable if the final publish validation remains authoritative. The assistant must distinguish “can save this draft” from “can publish this matter.”

### Edit and lock behavior

- Only the owning attorney or admin may edit.
- Amount cannot change after `lockedTotalAmount` exists.
- In-progress matters reject normal edits; only permitted task-completion changes remain.
- After hire, task definitions and normal case edits are locked.
- Pending invitations can lock the amount.
- Completed/closed matters cannot be edited.

## Applications, Invitations, and Pre-Engagement

### Applications

Before a paralegal can apply:

- Attorney must still have a default payment method.
- Matter/job must be open or validly relisted.
- Paralegal must be approved.
- Parties must not be blocked.
- Paralegal profile-photo and Stripe Connect requirements apply.
- Duplicate/reapplication rules apply.

### Invitations

Before an attorney can invite:

- Attorney must own the nonfinal matter.
- Target user must be an approved paralegal.
- Paralegal Stripe Connect and payouts must be ready, except explicit test bypasses.
- Parties must not be blocked.
- Matter must not already have an assigned paralegal.
- Duplicate pending/accepted invitations are rejected.
- Creating the invitation locks the matter amount when it was not already locked.

An invited paralegal must have at least one scope task present before accepting, and their payout setup must remain ready.

### Optional pre-engagement

- Only the owning attorney may request it.
- Matter must be nonfinal, unassigned, and contain at least one task.
- Target must be a paralegal and parties must not be blocked.
- At least one of confidentiality agreement or conflicts check must be selected.
- Conflicts details are required when conflicts checking is selected.
- A document is required when confidentiality acknowledgement is selected.
- State progresses through `requested`, `submitted`, `approved`, or `changes_requested`.
- These items are optional unless the attorney elects them; once elected, hiring must respect their state.

## Hiring and Funding

For an initial hire, the case route currently requires:

- Owning attorney.
- Nonfinal matter with no assigned paralegal.
- At least one scope task.
- Parties not blocked.
- Selected paralegal exists and has completed Stripe payout setup.
- Locked matter amount of at least $400.
- Attorney email and default payment method.
- Successful off-session Stripe PaymentIntent for matter amount plus attorney fee.

The hire route uses `confirm: true` and requires PaymentIntent status `succeeded` before assignment. It then stores the intent, marks funding `funded`, locks tasks, assigns the paralegal, and moves the matter to `in progress`.

For a rehire after withdrawal, the route reuses already funded remaining value and requires finalized payout, expired/cleared review window, and a positive remaining amount. It does not create the same new initial-hire charge.

## Workspace, Tasks, Files, and Messaging

Workspace/messaging eligibility currently requires:

- A hired paralegal.
- A funding intent and `escrowStatus: funded`.
- An active/in-progress status accepted by `canUseWorkspace` and message route filters.
- No revoked paralegal access.
- No active block between the parties.
- Read-only matters may be viewed by the attorney, but messages cannot be sent.
- Completed, closed, and disputed states close normal messaging.

There are two task representations:

- `Case.tasks`: scope tasks used by hire locking and completion.
- `Task` collection: separately routed task records with due dates and status.

The standalone Task routes require funding but also reject changes when a paralegal is hired/tasks are locked, creating an unclear or potentially unreachable lifecycle. Package 2 needs a product ownership decision before the assistant can combine these records.

There are also two file representations:

- Embedded `Case.files`.
- `CaseFile` collection used by current upload tooling.

The assistant currently merges both for display but cannot prove storage/download availability from metadata alone.

## Completion, Release, and Archive

Attorney completion requires:

- Owning attorney or admin.
- An assigned paralegal.
- Every embedded scope task completed.
- Funds verifiably ready for release.

Successful completion:

- Releases/transfers funds through the completion flow.
- Sets case status completed.
- Sets completed time, archived, and read-only.
- Revokes paralegal access.
- Generates an archive when possible.
- Generates receipts when possible.
- Schedules purge six months later.

Archive and receipt generation failures can leave completion successful while a document is temporarily unavailable. The assistant must not infer document readiness from completion alone.

## Withdrawal, Payout Decision, Dispute, and Relisting

When a paralegal withdraws before all tasks are complete:

- The active assignment is removed and the case pauses.
- Zero completed tasks automatically finalize a zero payout and relist.
- Some completed tasks create an attorney payout-decision state.
- All completed tasks block withdrawal and direct the parties to normal completion.

Attorney options after partial work include:

- Set a partial payout, subject to remaining amount and a 70% attorney cap.
- Decline release, starting a 24-hour review window.
- Relist only after payout is finalized and the review window is clear.

A withdrawn paralegal can open a dispute in the allowed review window. Dispute and termination flows can revoke access and require admin resolution. Admin notes are not attorney-visible.

## Account and Security

- Account preference reads/writes are user-scoped.
- Two-factor functionality is globally gated by `ENABLE_TWO_FACTOR`; a stored user flag alone is insufficient to describe feature availability.
- Deactivation eligibility is computed from active matters, unresolved disputes, unresolved funding/withdrawal relationships, and pending payouts.
- Deactivation is not full erasure; it disables access and removes active participation.

## Policies Requiring Package 2 Resolution

| Policy ID | Current conflict or ambiguity | Required decision |
| --- | --- | --- |
| WP-01 | Case publish enforces $400; direct Job publish permits $0.01. | Select one public posting policy and enforce it in both routes and assistant evidence. |
| WP-02 | Help/prompt copy says payment is “authorized” at hire; hire code immediately confirms and requires a succeeded charge. | Use legally and technically accurate charge/funding language approved for users. |
| WP-03 | FAQ says 22% fee on completed, paid projects; code charges matter amount plus attorney fee at initial hire. | Reconcile fee timing copy with actual transaction timing. |
| WP-04 | Platform copy says LPC is not escrow, while code/UI repeatedly calls held funding “escrow.” | Approve consistent user-facing terminology without changing legal characterization casually. |
| WP-05 | Profile completion has at least three definitions: dashboard, assistant, and User virtual. | Define one attorney onboarding/profile-completion contract. |
| WP-06 | `Case.tasks` and `Task` are separate, conflicting task systems. | Designate the authoritative system or migration/merge behavior. |
| WP-07 | `Case.files` and `CaseFile` both exist. | Define the authoritative file index and legacy compatibility rules. |
| WP-08 | Case applications and Job `Application` records both exist; assistant account activity reads only one. | Define canonical merged application view and deduplication. |
| WP-09 | Message unread logic differs between assistant aggregation and route `messageLastViewedAt` logic. | Define canonical unread/reply-state calculation. |
| WP-10 | Incomplete scope tasks have no assignee, but assistant attributes them to the paralegal. | Add assignment evidence or stop attributing ownership. |
| WP-11 | Archive metadata can exist while storage retrieval fails; archive route may generate on demand. | Define authoritative archive readiness states. |
| WP-12 | Fee defaults exist in model, cases route, payments route, prompts, FAQ, and knowledge. | Centralize configurable fee policy and preserve per-case snapshots for historical answers. |

## Package 2 Policy Target

Every accepted rule should live in a small shared policy/service contract imported by the enforcing route and the assistant tool. Policy output must identify the rule, the subject state, the blocker or readiness state, and whether the result is current, historical, or temporarily unverifiable.
