# LPC Premium Execution Tracker

Date started: July 5, 2026

Purpose: track execution against the premium readiness standard before attorney inflow. This is the operational tracker, not just an audit. Every item should move through `Not started`, `In progress`, `Blocked`, `Needs verification`, or `Done`, with evidence.

Working product standard: `docs/LPC_PREMIUM_PRODUCT_UPGRADE_SPEC.md` defines what "better," "stronger," "more polished," "cleaner," "professional," "highly amenable," "incredibly reliable," and "keeps users coming back" mean in measurable terms. Use that spec as the acceptance standard for UX/product upgrades.

## Status Summary

| Area | Status | Launch Risk | Current Focus | Evidence |
| --- | --- | --- | --- | --- |
| Attorney-facing UX | In progress | High | Stabilize browse/profile/case creation/case detail | Browse state filter and availability fixes completed; more attorney flow review pending |
| Paralegal-facing UX | In progress | Medium | Availability/profile visibility/case work clarity | Availability exclusion from browse completed |
| Admin/control room | In progress | High | Admin mutations, payment risk visibility, recovery controls | Some admin CSRF gaps fixed; wider admin audit pending |
| Security hardening | In progress | Medium | Route security inventory complete; remaining exemptions documented | 220 mutating routes inventoried; 206 verified protected; 14 exempt/exemption-review; 0 open |
| Payment/escrow readiness | In progress | High | Money-flow matrix and high-risk route verification | Focused payment/lifecycle tests passed after first hardening pass |
| Case lifecycle readiness | In progress | High | State transition matrix and attorney/paralegal next actions | Case summary fix completed; lifecycle tests passed in focused run |
| AI implementation | Not started | Medium | Permission boundaries and fallback review | Pending |
| Testing/verification | In progress | High | Focused tests after each high-risk fix | `securityEdgeCases`, `lifecycleTransitions`, `jobEscrow` passed |
| Mobile/responsive | Not started | Medium | Attorney critical screens first | Pending screenshot pass |
| Production operations | In progress | High | Scheduler safety, monitoring, runbooks | API no-store fixed; scheduler review pending |

## Completed Work

### Attorney-Facing UX

- Done: `browse-paralegals.html` state filter changed to a multi-select state control.
- Done: State selections auto-refresh results without requiring Apply.
- Done: Removed confusing helper sentence: "State selections update results automatically."
- Done: Removed Availability filter from attorney browse.
- Done: Unavailable paralegals are excluded server-side from public browse results.
- Done: State filter label changed to "State."
- Done: Case detail summary now prefers actual case details instead of generic paralegal basics.
- Done: Added attorney dashboard "Needs Attention" queue using existing live signals for payment readiness, applicants, unread messages, file reviews, overdue tasks, profile readiness, and first-matter creation.

Evidence:

- `frontend/browse-paralegals.html`
- `frontend/assets/scripts/browse-paralegals.js`
- `backend/routes/public.js`
- `frontend/assets/scripts/case-detail.js`
- `frontend/dashboard-attorney.html`
- `frontend/assets/scripts/attorney-tabs.js`
- `node --check frontend/assets/scripts/attorney-tabs.js` passed.
- Syntax checks previously passed for changed frontend/backend files.

### Security Hardening

- Done: Added CSRF protection to paralegal availability mutation.
- Done: Added CSRF protection to case draft create/update/delete mutations.
- Done: Added CSRF protection to admin case assignment mutation.
- Done: Added CSRF protection to admin case status mutation.
- Done: Added CSRF protection to payment budget mutation.
- Done: Added CSRF protection to payment release accounting mutation.
- Done: Added CSRF protection to upload attachment, paralegal certificate, writing sample, resume, profile photo, and case file upload mutations.
- Done: Added CSRF protection to admin payment payout, dispute settlement, and refund mutations.
- Done: Updated raw frontend resume/profile-photo upload calls to use `secureFetch` so CSRF headers are sent in production.
- Done: API no-store headers now run before API route handlers.
- Done: Added route security inventory generator.
- Done: Generated full mutating route security inventory for every backend `POST`, `PUT`, `PATCH`, and `DELETE` route.
- Done: Added CSRF protection to account preferences mutation.
- Done: Added CSRF protection to admin enable-user mutation.
- Done: Added CSRF protection to dispute create/comment/update/admin-notes/resolve mutations.
- Done: Added CSRF protection to authenticated incident intake mutation.
- Done: Added CSRF protection to message summary mutation.
- Done: Added CSRF protection to task create/update mutations.
- Done: Added CSRF protection to legacy user approve/reject mutations.

Evidence:

- `backend/routes/paralegals.js`
- `backend/routes/caseDrafts.js`
- `backend/routes/admin.js`
- `backend/routes/payments.js`
- `backend/routes/uploads.js`
- `backend/routes/account.js`
- `backend/routes/disputes.js`
- `backend/routes/incidents.js`
- `backend/routes/messages.js`
- `backend/routes/tasks.js`
- `backend/routes/users.js`
- `backend/index.js`
- `backend/scripts/route-security-inventory.js`
- `frontend/assets/scripts/profile-paralegal.js`
- `frontend/assets/scripts/profile-settings.js`
- `docs/LPC_ROUTE_SECURITY_INVENTORY.md`
- `node --check` passed for touched backend files.
- `npm test -- securityEdgeCases.test.js lifecycleTransitions.test.js jobEscrow.test.js` passed: 3 suites, 13 tests.
- `npm test -- uploadsDownloads.test.js disputesRefunds.test.js jobEscrow.test.js securityEdgeCases.test.js lifecycleTransitions.test.js` passed: 5 suites, 25 tests.
- `node backend/scripts/route-security-inventory.js` passed: 220 total mutating routes, 206 verified, 14 exempt/exemption-review, 0 open.
- `npm test -- accountPreferences.test.js disputesRefunds.test.js uploadsDownloads.test.js messagingNotifications.test.js securityEdgeCases.test.js lifecycleTransitions.test.js jobEscrow.test.js` passed: 6 suites, 32 tests.
- `npm test -- incidentRoutes.test.js` passed: 1 suite, 6 tests.

Route inventory status:

- Critical/P0 route-security gaps: none open.
- P1 route-security gaps: none open.
- P2 route-security items: public auth and public lead/intake routes remain in exemption-review and should receive a later auth-flow hardening review.
- P3 route-security items: inventory generator is heuristic and should be rerun/reviewed when route declarations change.
- Fixed but not covered by a dedicated behavioral route test in this pass: account preferences CSRF, admin enable-user CSRF, message summary CSRF, task create/update CSRF, legacy users approve/reject CSRF. These are statically verified by the inventory and syntax checks; dedicated behavioral tests should be added during regression-prevention work.

CSRF exemptions / exemption-review items:

- Stripe webhook: exempt because it requires raw-body Stripe signature verification and is not a browser-originated route.
- Control-room E2E harness routes: exempt because they are dev harness routes gated by harness enablement and shared secret, not normal production browser surfaces.
- Public auth routes: exemption-review because they are public auth flows protected by auth-specific validation/rate limits; logout/session CSRF remains a lower-severity review item.
- Waitlist route: exemption-review because it is public lead capture with app-level rate limiting.

### Readiness Documentation

- Done: Created full audit.
- Done: Created premium remediation plan.
- Done: Created detailed premium readiness definition.
- Done: Created this execution tracker.
- Done: Created premium product upgrade spec with concrete acceptance criteria for the formerly vague upgrade language.

Evidence:

- `docs/LPC_145K_500K_AUDIT.md`
- `docs/LPC_PREMIUM_REMEDIATION_PLAN.md`
- `docs/LPC_PREMIUM_READINESS_DEFINITION.md`
- `docs/LPC_PREMIUM_EXECUTION_TRACKER.md`
- `docs/LPC_PREMIUM_PRODUCT_UPGRADE_SPEC.md`

## Active Critical Backlog

### P0/P1 Security

Status: Verified for Critical/P1 route-security gaps

- Done: Inventory all backend mutation routes for auth, role, CSRF, rate limit, audit logging, and exemption status.
- Done: Fix or explicitly exempt every browser-originated mutation route missing CSRF.
- Confirm API no-store behavior with a running server/header check.
- Review duplicate `/api/paralegals` route ownership.
- Review CSP inline-script dependency and define removal path.
- Review public route field exposure.
- Review upload/download permission boundaries.
- Review local/session storage usage as non-authoritative display cache only.
- Confirm test/dev harness routes are gated out of production.

Evidence required before done:

- Route security matrix.
- Passing security regression tests.
- Header verification output.
- List of remaining security risks, none P0/P1.

### P0/P1 Payment and Escrow

Status: In progress

- Build money-flow matrix for funding, failed funding, requires action, canceled payment, duplicate webhook, dispute, partial refund, full refund, completion, payout, payout retry, Connect incomplete, paralegal withdrawal, attorney cancellation, and admin override.
- Map every money-flow scenario to test coverage.
- Confirm attorney-visible funding states.
- Confirm paralegal-visible payout readiness states.
- Confirm admin reconciliation for stuck/mismatched money states.
- Verify duplicate webhook idempotency.
- Verify payout cannot double-release.
- Verify refund and payout settlement math.

Evidence required before done:

- Money-flow matrix.
- Passing payment tests.
- Stripe sandbox notes or local mocked equivalent where sandbox is unavailable.
- Admin reconciliation screenshots/checklist.

### P0/P1 Case Lifecycle

Status: In progress

- Build case state transition matrix.
- Confirm attorney next action for every status.
- Confirm paralegal next action for every status.
- Confirm admin recovery path for stuck/paused/disputed states.
- Verify invalid transitions are blocked server-side.
- Verify lifecycle affects file/message/payment access correctly.
- Verify withdrawn/relisted/reassigned case behavior.

Evidence required before done:

- Lifecycle matrix.
- Passing lifecycle tests.
- Screenshots of representative attorney/paralegal/admin states.

### P1 Attorney Trust and Conversion

Status: In progress

- Apply the Phase 1 standard from `docs/LPC_PREMIUM_PRODUCT_UPGRADE_SPEC.md`.
- Add attorney dashboard "Needs attention" and first-time checklist.
- Redesign matter cards around status, next action, money state, paralegal/applicant state, and last activity.
- Improve case posting guidance, save/resume clarity, and preview confidence.
- Improve browse/profile trust signals and saved/favorite paralegal path.
- Normalize attorney payment language across dashboard, case detail, billing, and confirmation states.
- Review and polish `index.html`.
- Review and polish `signup.html`.
- Review and polish `login.html`.
- Review and polish `browse-paralegals.html`.
- Review and polish `profile-paralegal.html`.
- Review and polish `dashboard-attorney.html`.
- Review and polish `create-case.html`.
- Review and polish `case-detail.html`.
- Ensure every attorney-facing empty state gives useful next steps.
- Ensure every attorney-facing loading state is stable and professional.
- Ensure every attorney-facing error state is actionable.
- Ensure filters, chips, selects, modals, tabs, and pagination use consistent behavior.

Evidence required before done:

- Attorney UX checklist.
- Desktop/mobile screenshot set.
- Browser/manual walkthrough notes.
- Passing browser tests where feasible.

### P1 Admin Operations

Status: In progress

- Confirm user approval queues are reliable.
- Confirm profile photo review visibility.
- Confirm dispute queue clarity.
- Confirm payment-risk and case-risk visibility.
- Confirm destructive/admin override actions are audited and confirmed.
- Confirm support/incident routing has actionable context.
- Confirm production admin surfaces are not mixed with test harness behavior.

Evidence required before done:

- Admin readiness checklist.
- Passing admin workflow tests.
- Screenshots of operational queues.

## Mildly Critical Backlog

### UX Consistency

Status: Not started

- Define shared filter/list behavior.
- Define shared empty/loading/error state behavior.
- Define shared modal/destructive confirmation behavior.
- Define shared status-label language.
- Normalize attorney and paralegal dashboard cards.
- Normalize forms and validation messaging.
- Normalize mobile dropdown/chip behavior.

### AI Boundaries

Status: Not started

- Inventory AI-assisted workflows.
- Confirm AI cannot bypass role/case/payment/admin permissions.
- Confirm risky AI actions require authorized human confirmation.
- Confirm AI fallback behavior when unavailable.
- Confirm AI logs do not store unnecessary sensitive data.

### Mobile/Responsive

Status: Not started

- Screenshot attorney critical screens on mobile and desktop.
- Screenshot paralegal critical screens on mobile and desktop.
- Check mobile filters/modals/payment/case detail.
- Fix overlap, hidden CTA, overflow, unusable table, and tap-target issues.

### Production Operations

Status: In progress

- Review scheduler single-runner safety.
- Document production environment variables.
- Review health checks.
- Review logging/monitoring for payment, dispute, upload, and support failures.
- Review backup/restore documentation.
- Review incident runbooks.

## Next Execution Order

1. Finish route security inventory for high-risk routes.
2. Fix remaining missing CSRF or document exemptions.
3. Build payment and case lifecycle matrices.
4. Start attorney UX walkthrough and fix launch-blocking trust issues.
5. Add or run focused tests after each risk-area change.
6. Update this tracker after every completed fix or verification pass.
