# LPC Role Capability Audit

Date: July 7, 2026

Standard: LPC must function like a premium legal-tech marketplace worth a $145,000-$500,000 build, not an MVP.

Scope: current source-level walkthrough of admin, attorney, paralegal, and unregistered visitor capabilities. Evidence is from route guards, page guards, and role-specific frontend scripts in the current workspace. This is not yet a full browser walkthrough with seeded production-like accounts.

## Evidence Reviewed

- App route mounting and global middleware: `backend/index.js`
- Shared frontend auth guard: `frontend/assets/scripts/auth.js`
- Admin dashboard and admin routes: `frontend/admin-dashboard.html`, `frontend/assets/scripts/admin-dashboard.js`, `backend/routes/admin.js`, `backend/routes/adminSupport.js`, `backend/routes/adminSales.js`, `backend/routes/adminMarketing.js`, `backend/routes/adminKnowledge.js`, `backend/routes/adminApprovals.js`, `backend/routes/adminEngineering.js`, `backend/routes/aiAdmin.js`
- Attorney dashboard and workflows: `frontend/dashboard-attorney.html`, `frontend/assets/scripts/attorney-tabs.js`, `frontend/create-case.html`, `backend/routes/attorneyDashboard.js`, `backend/routes/cases.js`, `backend/routes/caseDrafts.js`, `backend/routes/jobs.js`, `backend/routes/applications.js`, `backend/routes/payments.js`
- Paralegal dashboard and workflows: `frontend/dashboard-paralegal.html`, `frontend/assets/scripts/paralegal-dashboard.js`, `frontend/assets/scripts/browse-jobs.js`, `backend/routes/paralegalDashboard.js`, `backend/routes/paralegals.js`, `backend/routes/stripe.js`, `backend/routes/applications.js`, `backend/routes/cases.js`
- Public visitor surfaces: `frontend/index.html`, `frontend/signup.html`, `frontend/login.html`, `frontend/browse-paralegals.html`, `frontend/assets/scripts/browse-paralegals.js`, `frontend/assets/scripts/profile-paralegal.js`, `backend/routes/public.js`, `backend/routes/auth.js`, `backend/routes/waitlist.js`
- Route security tracker/inventory: `docs/LPC_PREMIUM_EXECUTION_TRACKER.md`, `docs/LPC_ROUTE_SECURITY_INVENTORY.md`

## Cross-Role Baseline

Current protections that exist:

- Protected API routes are generally behind token verification and approved-account checks.
- Frontend protected pages call session checks or role-specific session checks.
- Main dashboards are role-specific: attorney dashboard API requires attorney, paralegal dashboard API requires paralegal, admin routes require admin.
- Mutating browser-originated routes were inventoried; current route-security tracker shows 220 mutation routes, 206 verified protected, 14 exempt/exemption-review, and no open Critical/P0 or P1 route-security gaps.
- CSRF was added to several previously weak mutating routes in the current hardening pass.
- Public browse now excludes unavailable paralegals server-side.

Current cross-role concerns:

- The source-level route inventory is useful for CSRF coverage but not fully reliable for role labels on grouped case routes. Actual source review must remain the source of truth.
- Many premium-readiness requirements are still unverified in a browser with real role accounts.
- Payment, escrow, case lifecycle, mobile responsiveness, AI boundaries, and production operations still need their own matrices and evidence.
- Several high-risk admin/payment/case actions exist and are necessary, but they require stronger operational evidence: audit logs, confirmations, recovery paths, screenshots, and regression tests.

## Admin

### What Admin Can Do Now

- Access the admin dashboard when authenticated and approved as admin. Evidence: `frontend/admin-dashboard.html` calls `window.checkSession('admin')`; `backend/routes/admin.js` uses `verifyToken`, `requireApproved`, and `requireRole("admin")`.
- View and manage pending, approved, disabled, and deleted users.
- Approve, deny, enable, disable, delete, purge, edit email, and change role for users.
- Review and approve or reject profile photos.
- View audit logs.
- View platform metrics, payouts, income, finance, disputes, posts, support, approvals, AI/control-room, marketing, sales, knowledge, and engineering admin areas.
- View and manage cases from admin routes.
- Assign cases, change case status, and delete cases.
- Access admin-only dispute overview and dispute resolution routes.
- Access admin payment operations including reconcile/refund/payout/settlement-style routes where implemented.
- Access director/control-room adjacent admin tools where mounted under admin routes.
- Access authenticated messaging/case/file surfaces where admin is explicitly allowed by backend guards.

### What Admin Cannot Do Now

- Use the attorney dashboard API as an attorney. Evidence: `backend/routes/attorneyDashboard.js` requires attorney.
- Use the paralegal dashboard API as a paralegal. Evidence: `backend/routes/paralegalDashboard.js` requires paralegal.
- Apply to jobs as a paralegal through paralegal-only application routes.
- Create normal attorney job posts through attorney-only job route unless the case route separately allows admin.
- Use paralegal Stripe Connect onboarding route, which is paralegal-only.
- Upload paralegal-only documents like resume/certificate/writing sample through the normal paralegal upload endpoints.

### What Admin Cannot Do But Should Be Able To Do

- See a production-grade operational command center for all money-risk states: failed funding, requires action, duplicate webhook, payout retry, refund pending, payout blocked, disputed, chargeback-like states, and stuck lifecycle states.
- See a complete case lifecycle recovery dashboard with reason, owner, next action, and deadline for every stuck or paused case.
- See clear evidence trails for attorney/paralegal-affecting admin actions directly in the UI, not only raw audit logs.
- Search/filter operational queues by risk severity, money impact, role, state, age, and owner.
- Export admin evidence bundles for disputes, payment reconciliation, and platform review.
- Preview attorney/paralegal views of a case without impersonation risk.
- See production monitoring status and scheduler status in a non-developer format.

### What Admin Can Do And Should Not Be Able To Do Without More Guardrails

- Change user roles. This is needed operationally, but it is high-risk and should require strong confirmation, audit detail, and ideally limited super-admin permission.
- Delete and purge users. This should have stricter irreversible-action language, audit evidence, and possibly staged deletion.
- Assign cases and change case statuses. This can affect money, access, and legal workflow; it should require structured reason codes and automatic notifications.
- Delete cases. This should be extremely restricted if any payment, file, message, dispute, or work history exists.
- Access broad user/case/payment data. Admin access is expected, but a premium system should separate routine admin, finance admin, support admin, and super-admin capabilities.
- Use AI/admin execution tools. These must be clearly separated from production user data actions unless approval, audit, and rollback are proven.

### Missing Or Not Yet Implemented To Premium Standard

- Fine-grained admin roles and least-privilege permissions.
- Complete payment-risk dashboard.
- Complete case-risk dashboard.
- Admin runbooks embedded or linked from operational queues.
- Immutable evidence timeline for user, case, payment, dispute, and AI/admin actions.
- Browser tests for admin approval, user status changes, profile photo review, dispute handling, and payment-risk actions.
- Mobile/tablet verification for urgent admin queues.

## Attorney

### What Attorney Can Do Now

- Sign up, log in, and route to attorney dashboard after approval.
- Access attorney dashboard API only as attorney. Evidence: `backend/routes/attorneyDashboard.js`.
- Browse public paralegal directory. The frontend supports visitor, attorney, paralegal, and admin viewing states; attorneys get invite actions.
- Filter browse paralegals by multiple states; results auto-refresh; unavailable paralegals are excluded server-side.
- View paralegal profiles. Attorneys can view attorney-facing profile sections and invite eligible paralegals.
- Create case drafts and cases. Evidence: `backend/routes/caseDrafts.js` allows attorney/admin; `backend/routes/cases.js` case creation requires admin/attorney and attorney payment method.
- Post jobs through attorney job route.
- View own cases, drafts, archived cases, applicants, invited paralegals, and billing/funds areas from the attorney dashboard.
- Invite paralegals to cases.
- Request pre-engagement items like confidentiality/conflicts check before hiring.
- Review pre-engagement submissions.
- Hire paralegals after required prerequisites.
- Add payment method, fund/hire through Stripe-related payment routes, view receipts, export receipts, and manage attorney billing flows where implemented.
- Message within case workspaces after case access is allowed.
- Upload, replace, view, and download case files when case participant access allows it.
- Mark work complete and release payment in the case detail flow when allowed.
- Initiate or participate in disputes/review flows.
- Block users from future interaction.
- Manage profile/account settings, password, preferences, 2FA, and account lifecycle actions.

### What Attorney Cannot Do Now

- Access admin dashboard/admin APIs.
- Access paralegal dashboard API.
- Apply to jobs or cases as a paralegal.
- Update paralegal availability.
- Use paralegal Stripe Connect onboarding.
- View jobs/open cases through paralegal-only job browse API unless using public/attorney-specific surfaces.
- View unrelated private cases, files, messages, applicants, or payments when backend ownership checks are applied.
- Hire without payment readiness and required case scope tasks.
- Invite/hire paralegals who are not approved or do not satisfy Stripe readiness unless bypass rules apply.

### What Attorney Cannot Do But Should Be Able To Do

- Move through a fully polished, verified attorney funnel from landing page to signup to browse to profile to invite/post to fund to workspace without unclear state changes.
- See clear, consistent next steps for every case state: draft, posted, applicant pending, pre-engagement requested, pre-engagement submitted, hired, funded, active, paused, disputed, completed, withdrawn, relisted, archived.
- Understand payment timing, platform fee, Stripe processing, payout release, dispute hold, and refund implications before confirming.
- See profile-quality signals for paralegals that feel premium and trustworthy, including verification status, availability, jurisdiction/state fit, and professional documents where appropriate.
- Save, compare, or shortlist paralegals from browse/profile during attorney evaluation.
- See a clean fallback when no paralegals match filters, with actionable options.
- Recover from failed funding/requires-action payment states without contacting support.
- See consistent empty/loading/error states across dashboard, browse, profile, case creation, billing, and case detail.
- Use fully verified mobile flows for browse, profile, case creation, hiring, billing, and case workspace.

### What Attorney Can Do And Should Not Be Able To Do Without More Guardrails

- Start money-impacting hire/fund/release flows. These are core platform actions, but they need complete test evidence and highly clear confirmation states.
- Archive/delete/cancel style case actions from dashboard flows. These should be blocked or heavily constrained when a paralegal, payment, file, message, or dispute exists.
- Request pre-engagement items and upload documents. This is appropriate, but needs file validation, retention, and clear privilege/confidentiality disclaimers.
- Block applicants/users. This is useful, but should have clear impact explanation and unblock/review paths.
- See paralegal documents and profile material. This is expected for attorneys, but exposure must remain limited to approved attorneys/admins and should be covered by tests.

### Missing Or Not Yet Implemented To Premium Standard

- Full attorney conversion QA report with screenshots.
- Full attorney payment and escrow readiness matrix.
- Full case lifecycle next-action matrix.
- Browser tests for create case, draft save, post, invite, apply review, pre-engagement, hire, fund, workspace access, complete/release, dispute, archive.
- Stronger browse/profile trust polish and paralegal comparison workflow.
- Production-ready attorney onboarding checklist tied to real gating.
- Verified responsive pass for all attorney critical pages.

## Paralegal

### What Paralegal Can Do Now

- Sign up, log in, and route to paralegal dashboard after approval.
- Access paralegal dashboard API only as paralegal. Evidence: `backend/routes/paralegalDashboard.js`.
- Manage paralegal profile details and profile settings.
- Upload paralegal resume, certificate, writing sample, and profile photo through paralegal-specific upload routes.
- Submit profile photo for admin review.
- Update availability. Evidence: `backend/routes/paralegals.js` requires paralegal, approved account, and CSRF.
- Browse open jobs/cases through paralegal-only job/open routes.
- Apply to jobs/cases if profile photo and Stripe readiness requirements are met.
- View own applications and revoke applications.
- Receive/respond to invitations.
- Respond to pre-engagement requirements.
- Accept/decline invitations when eligible.
- Access assigned case workspaces.
- Message, upload files, manage case files, complete/check tasks, and participate in disputes when case access allows.
- Connect Stripe through paralegal-only Stripe route.
- View payout/receipt-style paralegal payment routes where implemented.
- Manage account settings, password, preferences, 2FA, deactivation/deletion, and blocked users.

### What Paralegal Cannot Do Now

- Access admin dashboard/admin APIs.
- Access attorney dashboard API.
- Create attorney cases/jobs.
- Hire paralegals or fund matters as an attorney.
- Invite other paralegals to attorney cases.
- View unrelated attorney cases, applicant lists, private case files, messages, or payments.
- Apply without required profile photo.
- Apply or accept invitations without Stripe readiness unless a configured bypass applies.
- Edit another paralegal profile. Evidence: profile frontend only allows editing when viewer is the same paralegal.
- Appear in attorney browse when unavailable after the recent server-side public browse fix.

### What Paralegal Cannot Do But Should Be Able To Do

- Clearly see whether their profile is publicly visible to attorneys and exactly what is missing if not.
- See a premium profile-completion checklist tied to actual public directory eligibility.
- See Stripe payout readiness and payout blockers before applying or accepting work.
- See clear next actions for every case/application/invitation/pre-engagement status.
- Understand how availability affects browse visibility and when they will reappear.
- See clear, non-alarming explanations when profile photo is pending review or rejected.
- See consistent mobile flows for profile completion, applications, invites, availability, case workspace, and payout setup.

### What Paralegal Can Do And Should Not Be Able To Do Without More Guardrails

- Upload profile and work documents. This is necessary, but file type, size, virus/malware posture, signed URL scope, and retention policy need final verification.
- Withdraw from cases. This is necessary, but the money/lifecycle consequences must be fully tested and clearly explained.
- Reject payout / dispute payment-related outcomes. This requires a complete payment lifecycle matrix and admin recovery evidence.
- Mark/check tasks and participate in file review flows. These affect payment release readiness, so invalid transition blocking must be proven.

### Missing Or Not Yet Implemented To Premium Standard

- Paralegal visibility/readiness checklist.
- Full payout readiness dashboard and messaging.
- Browser tests for profile completion, document upload, photo review state, availability, browse visibility, apply, revoke, invite accept/decline, pre-engagement response, workspace file/task/message flows, withdraw, dispute.
- Better paralegal professionalism polish across dashboard/profile/settings.
- Verified responsive pass for paralegal critical pages.

## Unregistered Visitor

### What Visitor Can Do Now

- View public pages such as landing, signup, login, forgot/reset password, terms, privacy, accessibility, FAQs/help, contact, paralegal admission, unsubscribe, and public browse/profile surfaces.
- Browse the public paralegal directory.
- Use the State filter on browse paralegals.
- View public paralegal profiles through public routes where an approved/visible profile exists.
- Sign up as attorney or paralegal.
- Log in.
- Request password reset.
- Submit contact form. Evidence: `backend/routes/public.js` contact route uses CSRF.
- Join waitlist/public lead capture.
- See signed-in nav adjustments on some public pages if a session exists.

### What Visitor Cannot Do Now

- Access admin dashboard/admin APIs.
- Access attorney dashboard, paralegal dashboard, protected case pages, protected payment routes, messages, files, uploads, account settings, or applications.
- Invite, hire, apply, message, upload documents, fund a case, release payment, or dispute.
- View unavailable paralegals in public browse after the server-side availability exclusion fix.
- View protected private profile details requiring approved attorney/admin access.

### What Visitor Cannot Do But Should Be Able To Do

- Understand the attorney value proposition, trust posture, payment model, and approval process at a premium standard before signing up.
- See polished no-results and limited-access states that convert rather than confuse.
- Understand why an invite/hire action requires attorney signup/login.
- See public credibility content that supports premium platform fees: vetting, professionalism, payment safety, support process, and platform limitations.
- Submit a support/contact request with clear confirmation and expected response timing.

### What Visitor Can Do And Should Not Be Able To Do Without More Guardrails

- Public auth and waitlist/contact flows are necessarily public, but they remain exemption-review items for auth-flow hardening and spam/abuse review.
- Public paralegal browse/profile exposes marketplace supply. That is expected, but field exposure must stay limited and should be reviewed against privacy expectations.
- Public AI/chat-style routes appear in the route inventory as protected by auth/CSRF, but AI boundaries and public exposure still require a dedicated AI implementation review.

### Missing Or Not Yet Implemented To Premium Standard

- Full public conversion QA pass.
- Trust-grade landing/sign-up content review.
- Visitor-to-attorney conversion instrumentation and monitoring.
- Public route field-exposure test coverage.
- Public spam/abuse hardening review beyond current rate limits.
- Responsive screenshot pass for public pages.

## Current Priority Gaps By Severity

### Critical/P0

- No current source-confirmed P0 role-access bug found in this pass.
- Still not launch-ready because payment/escrow, case lifecycle, and browser walkthrough evidence remain incomplete.

### P1

- Payment/escrow readiness is not yet fully proven across all money states.
- Case lifecycle readiness is not yet fully proven across all attorney/paralegal/admin transitions.
- Attorney conversion flow has not yet been browser-verified end to end with screenshots.
- Admin operational control is not yet proven at premium launch standard.
- Mobile/responsive behavior is not yet verified for critical role workflows.
- Public/auth exemption-review items need auth-flow hardening review.

### P2

- Admin permissions are too broad for a mature premium platform; fine-grained roles should be added.
- User-facing empty/loading/error states need consistency audit.
- Paralegal visibility/readiness needs a clearer self-service experience.
- Public paralegal field exposure needs explicit privacy review.
- AI/admin/control-room surfaces need a dedicated permission and fallback audit.

### P3

- Route inventory generator role labels need improvement for grouped case routes.
- Some legacy redirect pages remain and should be checked for polish and clarity.
- Documentation/runbooks need to be linked to operational screens.

## Bottom Line

LPC has real role separation and many core marketplace capabilities implemented. It is not just a static MVP. However, it is not yet proven ready for attorney inflow at the $145,000-$500,000 premium legal-tech standard because the most important launch evidence is still incomplete: end-to-end browser walkthroughs, payment/escrow matrix, case lifecycle matrix, admin operations proof, mobile screenshots, and production monitoring/readiness evidence.

The immediate next execution order should remain:

1. Complete attorney end-to-end browser walkthrough with seeded attorney/paralegal/admin accounts.
2. Complete payment/escrow readiness matrix and tests.
3. Complete case lifecycle readiness matrix and tests.
4. Complete admin operational control walkthrough.
5. Complete mobile/responsive screenshot pass.
6. Complete public/auth/AI exposure hardening review.
