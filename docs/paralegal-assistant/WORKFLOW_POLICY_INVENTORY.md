# Paralegal Workflow Policy Inventory

Audit date: July 23, 2026

This inventory records represented workflow rules and contradictions. Package 1 does not choose a new rule or change runtime behavior.

| Stage | Represented source | Current represented rule | Conflict or gap |
| --- | --- | --- | --- |
| Approval/profile | `User`, onboarding/profile routes, browse filters | Approved paralegals maintain a profile and supporting materials | No single definition for profile complete, browse-visible, application-ready, or high-quality |
| Stripe setup | `User` markers plus live Stripe Connect retrieval | Stripe setup is required for payout readiness and invitation acceptance | Stored `stripeOnboarded` is used for both details submitted and overall readiness; outage vs stale state needs explicit evidence |
| Browse | case/job browse routes and block filters | Paralegals may view open, unassigned, nonarchived work subject to eligibility | Case and Job browse sources differ; visibility and application eligibility are not one policy |
| Apply | `Application`, `Case.applicants`, application routes | One paralegal may apply once; own application can be viewed/revoked in allowed states | Dual stores and statuses can drift; invite-accept entries can resemble applications |
| Invite | `Case.invites`, pending legacy fields, invite routes | Paralegal may accept/decline/revoke an invitation under represented conditions | Pending fields and invite list can disagree; acceptance requires Stripe and tasks before assignment is final |
| Pre-engagement | `Case.preEngagement`, application/case routes | Requested paralegal may acknowledge confidentiality and answer conflicts requirements | Document readiness, changes requested, next actor, and relationship to hiring eligibility need one evaluator |
| Hire/assignment | attorney hire route, invite accept route, Case assignment fields | Assignment requires eligible paralegal and scoped/funded work | Attorney and paralegal entry points enforce overlapping but not obviously identical gates |
| Workspace | case access queries, messaging, files, tasks | Assigned paralegal can work in the authorized matter | Archived, read-only, completed, blocked, withdrawn, and revoked-access behavior is distributed |
| Tasks/progress | `Case.tasks`, `Task`, case routes | Scope tasks drive completion and withdrawal calculations | Embedded and standalone tasks are not a canonical single system |
| Files/deliverables | `Case.files`, `CaseFile`, storage services | Files can be reviewed, approved, or returned for attorney revision | Metadata stores and storage readiness are not reconciled; “delivered” is not a single state |
| Messaging | message routes/service and viewed markers | Authorized participants may message while workflow/access permits | Send eligibility, unread, awaiting-reply, and post-completion behavior need a canonical policy |
| Completion | case/task/payment routes and shared workflow policy | Work completion precedes attorney completion/release | “Marked finished,” case completed, payment released, and payout created must remain distinct |
| LPC release | case release fields and `Payout` creation | Released funds create/record paralegal payout evidence | `paymentReleased`, `paidOutAt`, transfer ID, and Payout record can represent different points |
| Bank delivery | live Stripe payout/balance evidence where available | Bank delivery occurs after LPC/Stripe release | Current data does not prove bank receipt merely from case release; estimates must be labeled |
| Withdrawal | case withdraw route and lifecycle helpers | Eligibility depends on assignment, nonfinal status, and incomplete tasks; outcome depends on task progress | Partial/zero/full outcome, dispute windows, relist, receipts, and access revocation span multiple sources |
| Dispute/moderation | case/payment routes and admin resolution | Paralegal may see own user-facing state and outcome | Internal notes, risk signals, and deliberations must be excluded |
| Archive/history | completed routes, archive/purge fields, storage | Completed/withdrawn history remains available subject to retention/access | Database record, archive object, download, purge, and post-withdrawal visibility are distinct |
| Deactivation | shared deletion eligibility service | Active obligations may block deactivation | Paralegal-specific blockers across applications, invitations, assigned matters, disputes, and payouts are not contracted |

## Required Package 2 decisions

1. Canonical precedence between `Application`, `Case.applicants`, `Case.invites`, and legacy pending fields.
2. One application/invitation/pre-engagement/assignment readiness evaluator shared with routes.
3. One assigned-workspace access evaluator for active, completed, archived, read-only, withdrawn, and blocked states.
4. One accepted task authority for progress, completion, and withdrawal.
5. One payout timeline vocabulary: setup, eligible, completion pending, release pending, released, transfer recorded, payout recorded, bank pending, bank confirmed/unavailable.
6. Historical payout amount precedence among `Payout`, settlement snapshots, partial payout, locked amount, and fee snapshots.
7. Paralegal profile-completion and browse-visibility definitions.
8. Paralegal deactivation blockers.
