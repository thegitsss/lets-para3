# LPC Premium Readiness Definition

Date: July 5, 2026

This document defines what "complete" means for LPC before attorney inflow. It is intentionally more detailed than a short release checklist. The standard is a premium legal-tech marketplace worthy of $145,000-$500,000 in build value and premium platform fees.

LPC is ready when there are no known launch-blocking issues, no unresolved attorney-trust defects, no untested critical payment/security/case lifecycle paths, and no unclear next steps for attorneys, paralegals, or admins.

Severity:

- Critical: must be fixed or explicitly proven safe before attorney inflow.
- Mildly critical: does not always block launch alone, but undermines premium trust, operational reliability, or regression safety and should be resolved before broad attorney outreach.

## 1. Attorney-Facing UX Standard

Done means attorneys can move from first impression to signup, browsing, paralegal evaluation, case creation, hiring/inviting, payment, collaboration, completion, and dispute/closeout without confusion, broken states, or amateur-feeling friction.

Critical requirements:

- Homepage and entry points clearly communicate what LPC does, who it serves, and why an attorney should trust the platform.
- Attorney signup is clear, professional, and does not leave applicants unsure what happens after submission.
- Login handles pending approval, disabled accounts, wrong role, 2FA, password reset, and session expiration with clear messages.
- Browse paralegals has stable filters, no jumping results, no random dropdown closing, no unavailable paralegals, and clear empty states.
- Paralegal cards show enough trust signals for attorney evaluation: name, photo, location/jurisdiction, experience, practice areas, availability, and relevant profile quality.
- Public/paralegal profile pages feel credible and complete, not like sparse directory records.
- Case creation guides the attorney through title, description, budget, deadline, files, tasks, review, draft save, and submission without ambiguity.
- Attorney dashboard shows current cases, drafts, invitations, required actions, payment status, and next steps clearly.
- Case detail makes the case state obvious and tells the attorney what to do next.
- Payment readiness is visible before an attorney reaches a blocked payment moment.
- Messaging and file-sharing feel integrated into the case workflow, not bolted on.
- Completion, revision request, dispute, archive, and closeout actions have clear confirmations and consequences.
- Empty states are specific and useful, not generic blank panels.
- Loading states avoid layout jumps and do not make the page feel broken.
- Error states explain what happened and what the attorney can do next.
- Premium-fee moments, especially funding and platform fees, are presented with professional clarity.
- No attorney-facing critical path depends on browser storage as the source of truth.

Mildly critical requirements:

- Filters, selects, chips, modals, tabs, and pagination behave consistently across attorney pages.
- CTAs use consistent visual hierarchy and language.
- Page titles, headings, and labels sound like a legal marketplace, not generic SaaS placeholders.
- Attorney pages avoid decorative clutter and prioritize fast scanning.
- Attorney-facing pages maintain consistent spacing, button sizing, typography, and color usage.
- Attorney onboarding should not repeat information unnecessarily.
- Confirmation emails and in-app messages should match the workflow language.
- Draft and autosave behavior should be clear enough that attorneys trust their work will not disappear.
- Profile evaluation should support comparison without forcing excess clicks.
- Search and sort behavior should be predictable and reversible.
- Tooltips/help text should clarify unfamiliar workflows without cluttering the interface.
- Attorneys should never hit a dead end that requires guessing or emailing support.

Verification:

- Manual attorney walkthrough from landing to funded case.
- Manual walkthrough of empty, loading, error, and success states.
- Desktop screenshots for homepage, signup, login, browse, profile, dashboard, create case, payment, and case detail.
- Mobile screenshots for the same critical screens.
- Browser tests for signup/login, browse/filter, case draft, case submit, invite/hire, payment start, case detail next actions, and dispute/closeout where feasible.
- Issue list showing all attorney-facing critical findings fixed or downgraded with rationale.

Evidence before readiness:

- Attorney UX readiness checklist.
- Screenshot set with viewport labels.
- Passing browser/e2e test output.
- List of known remaining attorney UX issues, all non-launch-blocking.

## 2. Paralegal-Facing UX Standard

Done means paralegals can onboard, complete a professional profile, manage availability, discover/apply/respond to work, perform assigned case tasks, communicate, upload files, handle disputes, and understand payout readiness without confusion.

Critical requirements:

- Paralegal signup clearly explains approval, resume/certificate expectations, and what happens next.
- Profile settings clearly show completeness requirements for public visibility.
- Public visibility rules match backend enforcement: profile photo approved, resume uploaded, bio present, skills present, practice areas present, and profile not hidden.
- Availability controls are easy to use and unavailable paralegals are automatically removed from attorney browse results.
- Paralegals understand whether they are visible to attorneys.
- Dashboard shows active cases, applications, invitations, deadlines, unread messages, and payment/payout readiness.
- Application flows clearly show status: submitted, viewed, accepted, rejected, withdrawn, or expired where applicable.
- Assigned case view shows next action, tasks, files, messages, deadline, and payment/case status.
- Upload workflows support required file types, progress/error messaging, and permission checks.
- Withdrawal, dispute, completion, and revision flows clearly explain consequences.
- Stripe Connect/onboarding or payout setup status is visible before payout is blocked.
- Paralegal cannot see attorney/admin-only controls.
- Paralegal cannot access revoked or unrelated case materials.

Mildly critical requirements:

- Profile editor should feel professional, not like a generic form dump.
- Practice area, skills, states/jurisdictions, education, and experience controls should match attorney browse terminology.
- Dashboard cards and tables should use consistent status labels.
- Notifications should route paralegals to the correct action.
- Empty states should guide next profile/work steps.
- Mobile profile and assigned-case workflows should be usable.
- Upload errors should distinguish file type, size, permission, and network failures.
- Availability wording should remain consistent across profile, dashboard, and browse exclusion behavior.
- Paralegal-facing support/help entry points should carry role and case context.

Verification:

- Manual paralegal onboarding and profile-completion walkthrough.
- Manual visibility test for complete, incomplete, pending-photo, hidden, available, and unavailable profiles.
- Manual active-case walkthrough from assignment to completion.
- Tests for availability update, public directory exclusion, profile completeness, application status, file upload authorization, and case access.
- Desktop/mobile screenshots for paralegal dashboard, profile settings, assigned case, applications, and availability.

Evidence before readiness:

- Paralegal UX readiness checklist.
- Public profile visibility matrix.
- Passing profile/application/case-access tests.
- Screenshot set.

## 3. Admin / Control-Room Standard

Done means admins can operate LPC during attorney outreach without database digging: approve users, monitor cases, see payment risk, manage disputes, handle support, audit actions, and recover stuck workflows.

Critical requirements:

- Admin can approve, deny, disable, reactivate, and review users with clear audit history.
- Admin can review profile photos and public-profile readiness.
- Admin can distinguish pending attorney and paralegal approval queues.
- Admin can see money-risk cases: funded not started, failed funding, disputed, refund pending, payout pending, payout failed, stuck webhook, Connect incomplete.
- Admin can view case lifecycle state and safely understand allowed interventions.
- Admin override actions are permission-gated, CSRF-protected, audited, and clearly labeled.
- Admin can reconcile payment/case state without guessing.
- Admin can see disputes, settlement status, refund/payout status, and deadlines.
- Admin can see support tickets or incident reports tied to user/case/payment context.
- Admin can search and filter users, cases, disputes, receipts, and audit logs reliably.
- Admin actions cannot accidentally expose private case files or messages to unauthorized users.
- Director/control-room surfaces do not rely on test harness behavior in production.
- Operationally risky AI/autonomous actions are reviewable and bounded.

Mildly critical requirements:

- Admin UI should prioritize urgent operational work over decorative dashboards.
- Counts, queues, and status labels should match backend truth.
- Tables should have stable pagination, loading states, and empty states.
- Admin modals should show clear consequences before destructive actions.
- Admin screens should be responsive enough for urgent mobile review, even if desktop remains primary.
- Audit log entries should be human-readable.
- Admin should be able to identify who did what, when, and why.
- Admin should have links from alerts directly to the affected user/case/payment/dispute.
- Admin settings should distinguish production controls from informational/test utilities.
- Admin pages should not silently swallow failed API calls.

Verification:

- Manual admin operations walkthrough.
- Permission tests for admin-only routes.
- Audit logging tests for high-risk actions.
- Scenario tests for user approval, profile photo approval, dispute settlement, payment reconciliation, case status intervention, support escalation, and disabled users.
- Screenshots of admin queues and high-risk modals.

Evidence before readiness:

- Admin/control-room readiness checklist.
- Route/permission matrix.
- Passing admin workflow and audit tests.
- Known admin limitations documented as non-launch-blocking.

## 4. Security Hardening Standard

Done means LPC has no known P0/P1 web security gaps in browser-originated flows, role boundaries, file access, payments, or admin actions.

Critical requirements:

- Every authenticated browser mutation route has CSRF protection or a documented non-browser exemption.
- Cookie auth uses secure, httpOnly cookies in production.
- JWT verification checks current database user state, including disabled/deleted status.
- Role checks are enforced server-side, not only through hidden UI.
- Case access is enforced for attorneys, paralegals, admins, applicants, revoked paralegals, and withdrawn users.
- File upload and download routes check role and case ownership before returning signed URLs or files.
- Sensitive API responses use `Cache-Control: no-store`.
- Public routes expose only intended public fields.
- Admin routes require admin role and approval status.
- Payment routes enforce attorney/admin/paralegal role boundaries.
- Password reset, email verification, login, register, and resend verification routes are rate-limited.
- CSP is hardened enough to prevent normalizing inline script execution as a long-term posture.
- User-provided HTML is never rendered unsafely.
- `innerHTML` usage is reviewed or replaced for user/server-controlled content.
- Local/session storage is treated as display cache only, never authoritative auth state.
- Production secrets are not committed.
- Test harness/dev routes are gated off in production.

Mildly critical requirements:

- Route inventory lists auth, role, CSRF, rate limit, audit logging, and public/private data exposure.
- Security tests fail if new high-risk routes omit auth/CSRF.
- Password and 2FA flows use consistent messages that avoid account enumeration where appropriate.
- Login/session expiry behavior is consistent across pages.
- Upload file type and size limits are documented and enforced.
- Error responses do not leak sensitive internals.
- Security headers are documented and tested.
- CORS policy is explicit and production-safe.
- Admin destructive actions require confirmation.
- Rate limits are tuned to protect abuse without breaking normal attorney/paralegal workflows.

Verification:

- Static route inventory.
- Focused security tests.
- Manual review of auth, admin, file, payment, public, and case routes.
- Browser tests for expired sessions and unauthorized role access.
- Header inspection in local/prod-like environment.

Evidence before readiness:

- Security route matrix.
- Passing security test output.
- Header verification notes.
- List of remaining security risks, none P0/P1.

## 5. Payment and Escrow Readiness Standard

Done means payment, escrow-like state, refunds, disputes, and payouts are predictable, tested, observable, and recoverable.

Critical requirements:

- Attorney can add/use payment method and understand payment readiness.
- Funding flow creates the correct Stripe object and maps it to the correct case.
- Webhook signature verification uses raw body and rejects bad signatures.
- Duplicate/retried webhooks do not double-release, double-refund, or corrupt case state.
- Payment succeeded updates case funding state exactly once.
- Payment failed/requires action/canceled gives attorney clear next step.
- Escrow/funding status is visible to attorney, paralegal, and admin in role-appropriate language.
- Work cannot proceed into paid-work states without required funding where the business rule requires funding.
- Completion and payout logic handles Stripe Connect onboarding incomplete.
- Payout cannot be triggered twice for the same case.
- Refund and dispute settlement paths handle partial and full amounts correctly.
- Admin reconciliation can identify stuck payment, missing transfer, failed refund, or mismatched case state.
- Stripe mode/test/live separation is respected in analytics and records.
- Money amounts use cents/integer-safe handling server-side.
- Fees, net payout, attorney charge, platform fee, and paralegal payout are explainable.
- Receipts and payment records are generated and retrievable.

Mildly critical requirements:

- Payment copy avoids legal/accounting ambiguity.
- Payment buttons show disabled/loading states and do not allow double-click duplicate requests.
- Payment errors are actionable and not raw Stripe jargon.
- Admin can filter by payment status and Stripe mode.
- Paralegals see payout setup requirements before completion.
- Attorney sees when a case is awaiting funding versus funded.
- Refund/settlement confirmations show amount and consequence.
- Tests include boundary amounts, minimum budget, zero/negative rejection, partial settlement, and retry behavior.
- Webhook processing is logged with enough context for support.

Verification:

- Money-flow matrix covering funding, failure, requires action, cancellation, duplicate webhook, dispute, partial refund, full refund, completion, payout, payout retry, Connect incomplete, attorney cancellation, paralegal withdrawal, and admin override.
- Jest tests for payment route/service logic.
- Stripe sandbox scenario runs.
- Admin reconciliation manual pass.
- Browser tests for attorney-visible payment start/status where feasible.

Evidence before readiness:

- Payment/escrow matrix.
- Passing payment test output.
- Stripe sandbox notes.
- Admin reconciliation screenshots.
- List of payment edge cases with pass/fail status.

## 6. Case Lifecycle Readiness Standard

Done means every case status has allowed transitions, blocked transitions, UI next steps, notifications, permissions, and payment implications defined.

Critical requirements:

- Case lifecycle statuses are documented and used consistently.
- Draft, open, invited, assigned, awaiting funding, funded, in progress, submitted, revision requested, completed, disputed, paused, withdrawn, archived, and closed states have clear meaning.
- Attorneys and paralegals see different controls based on role and state.
- Invalid transitions are blocked server-side.
- Admin transitions are constrained, audited, and CSRF-protected.
- Paralegal access is revoked when business rules require it.
- Withdrawn paralegal and replacement/relist paths are safe.
- Completion cannot bypass required payment/payout logic.
- Dispute state freezes or modifies allowed actions correctly.
- File/message access follows lifecycle permissions.
- Notifications route users to the correct state/action.
- Case summary/details shown to attorneys reflect the case, not generic paralegal basics.
- Archive/delete behavior protects records needed for payment/dispute/audit.
- Paused/stuck states are visible to admin with recovery options.

Mildly critical requirements:

- Status labels are consistent across dashboard, case detail, admin, notifications, and emails.
- Empty active-case states explain the next business step.
- Case cards show enough information for scanning.
- Deadlines and overdue states are visually clear.
- Internal notes and user-visible notes are separated.
- Revision requests clearly distinguish requested changes from chat messages.
- Receipts and final documents are easy to locate after completion.
- Blocked or disputed user interactions are explained safely.
- Case list filters and tabs do not hide urgent work.
- Time/date formatting is consistent.

Verification:

- Lifecycle transition matrix.
- Tests for allowed and denied transitions.
- Manual attorney/paralegal/admin walkthrough of each major status.
- Screenshots of representative states.
- Permission tests for files/messages across lifecycle states.

Evidence before readiness:

- Case lifecycle matrix.
- Passing lifecycle and permission tests.
- Screenshot set.
- Known lifecycle risks list, none launch-blocking.

## 7. AI Implementation Standard

Done means AI reduces attorney/admin/paralegal friction without creating hidden authority, security, privacy, or trust problems.

Critical requirements:

- AI never bypasses role, case, file, payment, or admin permissions.
- AI-generated recommendations are distinguishable from user/admin decisions.
- AI can assist drafting, triage, support, summarization, or routing, but risky actions require explicit authorized confirmation.
- AI failure states degrade gracefully and do not block core workflows unless the workflow is explicitly AI-dependent.
- AI prompts/responses do not expose private case data to unauthorized users.
- AI-assisted control-room actions are logged and reviewable.
- AI classification/routing errors can be corrected by admin.
- AI does not fabricate payment, legal, or case status.
- AI-generated case summaries or support summaries cite the source fields or are clearly presented as summaries.
- AI routes that mutate state are CSRF-protected and role-gated.

Mildly critical requirements:

- AI copy should sound professional and restrained.
- AI should reduce form friction where it is helpful, such as case drafting or support issue triage.
- AI suggestions should be editable.
- AI should not overtake attorney decision-making.
- AI output should avoid legal advice positioning unless explicitly reviewed and approved.
- Admin should see when AI confidence is low.
- AI failures should give support/admin enough context to debug.
- AI-related test harnesses must be disabled or clearly gated in production.
- AI logs should avoid storing unnecessary sensitive content.

Verification:

- AI workflow inventory.
- Permission tests on AI routes.
- Manual review of AI-assisted attorney/admin flows.
- Tests for AI unavailable/fallback behavior.
- Review of production gating for AI harnesses.

Evidence before readiness:

- AI boundary document.
- Passing AI route/control-room tests.
- List of AI-enabled workflows and required human approval points.
- Remaining AI limitations documented.

## 8. Testing and Verification Standard

Done means critical behavior has automated coverage and a repeatable manual release checklist.

Critical requirements:

- Full relevant backend test suite passes.
- Attorney critical path browser tests pass or are manually verified with documented evidence.
- Paralegal critical path tests pass or are manually verified.
- Admin critical path tests pass or are manually verified.
- Security tests cover auth, CSRF, role boundaries, case access, file access, and admin-only operations.
- Payment tests cover funding, failure, duplicate webhook, refund, payout, and dispute settlement.
- Lifecycle tests cover allowed and denied transitions.
- Upload/download tests cover permissions and invalid files.
- Messaging/notification tests cover role access and read/unread behavior.
- Regression tests are added for bugs fixed during the premium-readiness push.
- No failing critical tests are ignored.

Mildly critical requirements:

- Test commands are documented.
- Local test warnings are classified as expected or fixed.
- Browser screenshots are captured for design/UX review.
- Accessibility smoke checks are run on attorney-facing screens.
- Performance smoke checks cover pages with large lists or dashboards.
- Tests use realistic role fixtures.
- Seed/test data cleanup is reliable.
- Known untested paths are documented with risk level.
- Manual QA checklist is versioned.

Verification:

- Run focused tests after each high-risk change.
- Run full relevant test suite before readiness signoff.
- Run browser/manual QA for attorney, paralegal, and admin paths.
- Compare readiness checklist against known issue list.

Evidence before readiness:

- Test command output summary.
- Manual QA checklist.
- Screenshot evidence.
- Known test gaps list with risk classification.

## 9. Mobile / Responsive Standard

Done means attorney, paralegal, and critical admin workflows are usable on mobile and desktop without broken layout, hidden controls, overlapping text, or unusable modals.

Critical requirements:

- Homepage, signup, login, browse, profile, dashboard, create case, payment, and case detail work on mobile.
- Filters are usable on mobile and do not trap focus or close unpredictably.
- Modals fit mobile viewports and preserve visible primary actions.
- Forms do not overflow horizontally.
- Tables/cards either adapt or offer usable mobile layouts.
- Text does not overlap buttons, cards, nav, or subsequent content.
- Primary CTAs remain visible and tappable.
- File upload controls are usable on mobile.
- Payment flows remain legible on mobile.
- Admin urgent actions are at least reviewable on mobile.

Mildly critical requirements:

- Tap targets are comfortably sized.
- Sticky nav/header elements do not cover content.
- Long names, long emails, long case titles, and long practice areas wrap cleanly.
- Empty/loading/error states look intentional on mobile.
- Dropdowns and chip lists work with touch input.
- Keyboard appearance does not hide essential form actions.
- Mobile typography remains professional and scannable.
- No viewport-width font scaling that creates unpredictable text sizing.
- Screens should avoid excessive decorative whitespace on mobile.

Verification:

- Manual responsive pass at representative mobile and desktop widths.
- Screenshots for critical pages.
- Browser checks for no obvious overlap/overflow.
- Mobile filter, modal, and payment interaction tests where feasible.

Evidence before readiness:

- Mobile screenshot set.
- Responsive issue checklist.
- Confirmation that no critical attorney/paralegal mobile path is blocked.

## 10. Production Operations / Monitoring Standard

Done means LPC can be operated professionally during attorney outreach: deploys are controlled, background jobs are safe, incidents are visible, payments are monitored, and recovery steps are documented.

Critical requirements:

- Production environment variables are documented.
- Secrets are stored outside git.
- Health check exists and reflects database readiness.
- Background schedulers are gated, single-runner safe, or protected by distributed locks.
- Production/staging/test mode behavior is clearly separated.
- Stripe webhook endpoint and signing secret are documented.
- Payment failures, refund failures, payout failures, and webhook processing failures produce admin-visible alerts or logs.
- Error logging captures enough context to triage without leaking sensitive data.
- Database backup and restore process is documented.
- File storage bucket, signed URL, and retention behavior are documented.
- Admin can detect stuck cases, stuck payments, and support escalations.
- Deployment rollback process is documented.
- Test harness/dev routes are disabled in production.
- Owner/admin escalation path exists for urgent attorney/payment issues.

Mildly critical requirements:

- Logs are structured enough to search by user, case, payment intent, transfer, dispute, or request id.
- Scheduled jobs expose last-run/failed-run visibility.
- Email delivery failures are visible.
- Rate limit settings are documented.
- CORS/static asset behavior is documented.
- Dependency versions and Node version are documented.
- Local setup and production setup are separate.
- Known operational warnings are either fixed or documented.
- Runbooks exist for user approval backlog, payment mismatch, failed payout, dispute escalation, disabled account, and broken upload/download.
- Admin support workflows link to relevant records.

Verification:

- Ops checklist review.
- Health check verification.
- Scheduler/worker review.
- Backup/restore documentation review.
- Production config review.
- Simulated incident walkthrough for payment failure or stuck case.

Evidence before readiness:

- Production readiness checklist.
- Runbook links.
- Monitoring/logging notes.
- Scheduler safety notes.
- Backup/recovery documentation.
- Remaining ops risks list, none launch-blocking.

## Final Readiness Rule

LPC is ready for attorney inflow only when:

- All critical requirements above are fixed, verified, or explicitly classified as not applicable.
- No known P0 issue remains.
- No known P1 issue remains in attorney trust, payment, security, case lifecycle, or admin recovery.
- Critical automated tests pass.
- Manual attorney, paralegal, admin, mobile, payment, and lifecycle checklists are complete.
- Evidence is attached for each category.
- Remaining known issues are documented as non-launch-blocking with owner, priority, and follow-up path.

