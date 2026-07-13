# LPC $145k-$500k Website Audit

Date: July 5, 2026

Scope: static review of the local repository, focused on production readiness for a legal-services marketplace handling user approval, case lifecycle, document uploads, messaging, escrow-like payment flows, disputes, and admin operations. This is not a penetration test, full accessibility audit, live browser QA pass, or production infrastructure review.

## Executive Assessment

LPC is not currently at the standard I would expect from a $145,000 to $500,000 production marketplace build.

It is more than a basic prototype: the repo has a substantial Express/Mongo backend, Stripe integration, S3 upload handling, approval workflows, role checks, admin tooling, and a meaningful Jest/e2e test surface. Those are real assets.

The problem is consistency and production discipline. A high-budget site in this category should feel boringly reliable: consistent interaction patterns, a maintained design system, complete role-boundary tests, consistent CSRF protection, hardened browser security headers, clean operational controls, and strong end-to-end coverage for every money and case lifecycle path. This codebase has strong pieces, but too many critical behaviors are implemented unevenly across large files and independent pages.

## Severity Key

- P0: launch-blocking risk for money, security, privacy, or core workflow integrity.
- P1: serious production-quality issue that should be fixed before a premium launch.
- P2: quality, maintainability, UX, or operational issue below high-budget standard.
- P3: polish or cleanup issue.

## Current Critical Findings

### P0: CSRF protection is inconsistent across authenticated mutation routes

The app uses cookie-based auth and has CSRF utilities, but CSRF is not applied consistently to all state-changing routes.

Evidence:

- Global CSRF exists only as a token route in `backend/index.js:232`; it is not mounted as a global mutation guard.
- `backend/routes/paralegals.js:17` updates paralegal availability with `verifyToken`, `requireApproved`, and `requireRole`, but no CSRF protection.
- `backend/routes/caseDrafts.js:113`, `backend/routes/caseDrafts.js:123`, and `backend/routes/caseDrafts.js:144` create/update/delete drafts without CSRF protection.
- `backend/routes/admin.js:2545` and `backend/routes/admin.js:2588` expose admin case assignment/status mutation routes without CSRF protection, even though many neighboring admin routes use `csrfProtection`.
- `backend/routes/payments.js:1797` updates case budget without CSRF protection.
- `backend/routes/payments.js:2103` exposes an admin-only release accounting route without CSRF protection.

Expected at $145k-$500k:

All authenticated browser-originated POST/PUT/PATCH/DELETE routes should have one centralized mutation guard or route-level proof. This should be enforced by tests that fail when new mutating routes are added without CSRF or an explicit machine-to-machine exemption.

### P0: Payment and case lifecycle code is too high-risk to ship without a full external reconciliation pass

There is real Stripe work and a dedicated webhook route, which is good. But the payment and case lifecycle surface is large enough that static review alone is insufficient for production confidence.

Evidence:

- `backend/routes/payments.js` is 3,416 lines.
- `backend/routes/cases.js` is 6,718 lines.
- Stripe webhook handling is present in `backend/routes/paymentsWebhook.js:129` and the webhook route is correctly mounted before JSON parsing in `backend/index.js`.
- Tests exist for payment-related paths, including escrow, payouts, refunds, and lifecycle transitions, but I did not run the full suite during this audit.

Expected at $145k-$500k:

Before launch, this needs a signed-off money-flow matrix covering every status transition: funded, payment failed, disputed, partial refund, full refund, paralegal withdrawal, attorney cancellation, completion, payout retry, Connect onboarding failure, duplicate webhook, and admin override. Each path should have automated tests and manual Stripe dashboard reconciliation evidence.

### P1: Security headers are not at a premium production standard

Helmet is enabled, but the CSP permits inline scripts.

Evidence:

- `backend/index.js:37` configures CSP.
- `backend/index.js:40-46` includes `scriptSrc` with `'unsafe-inline'`.
- Several frontend pages include inline scripts, such as footer `document.write` patterns and large page-local scripts.

Expected at $145k-$500k:

Inline scripts should be removed or nonce/hash based. A marketplace handling legal documents, identity, and payments should not normalize `'unsafe-inline'` as the default CSP posture.

### P1: Sensitive API cache headers are mounted after API routes

The global `no-store` middleware is defined after all API routers. That means successful API responses from earlier routes do not receive this global no-cache policy unless each route sets its own headers.

Evidence:

- API routers are mounted in `backend/index.js:179-230`.
- `Cache-Control: no-store` middleware is mounted later in `backend/index.js:253-258`.

Expected at $145k-$500k:

Sensitive authenticated API responses should be no-store by default, mounted before API routes, with explicit exceptions only for safe public assets.

### P1: Operational schedulers start unconditionally in the web process

Background workers/schedulers start directly after `app.listen`.

Evidence:

- `backend/index.js:300-308` starts purge, agent, director mail import, director follow-up, and incident schedulers.

Risk:

If the app runs in more than one production process/container, duplicate schedulers can create duplicate emails, duplicate automated actions, duplicate imports, or race conditions unless each scheduler has strong distributed locking. That locking may exist deeper in services, but this entry point does not make single-runner ownership obvious.

Expected at $145k-$500k:

Schedulers should be explicitly gated by environment role, separate worker process, leader election, or distributed locks with tests and runbook documentation.

### P1: Route ownership is confusing for `/api/paralegals`

Two separate routers are mounted under the same `/api/paralegals` prefix.

Evidence:

- `backend/index.js:216` mounts `paralegalsRouter`.
- `backend/index.js:227-229` conditionally mounts `usersRouter.paralegalRouter` at the same path.

Expected at $145k-$500k:

One clear owner per route namespace. Duplicate mounting makes behavior harder to reason about, test, secure, and document.

## Product and UX Findings

### P1: The frontend architecture is too fragile for a premium marketplace

Many critical screens are large standalone HTML files plus large imperative scripts. This makes state, accessibility, shared behavior, and regression prevention harder than it should be.

Evidence:

- `frontend/assets/scripts/attorney-tabs.js`: 8,667 lines.
- `frontend/assets/scripts/profile-settings.js`: 6,478 lines.
- `frontend/admin-dashboard.html`: 6,346 lines.
- `frontend/assets/scripts/case-detail.js`: 6,025 lines.
- `frontend/dashboard-attorney.html`: 5,716 lines.
- `frontend/profile-settings.html`: 5,609 lines.

Expected at $145k-$500k:

Shared components, predictable page state, reusable form controls, a design-token system, and browser tests for critical flows. Large standalone files can work temporarily, but at this size they become regression-prone.

### P1: UX consistency is below the price tier

The filter problems you noticed are evidence of a broader issue: controls behave differently across the site because interaction patterns are implemented page by page.

Current correction:

- `frontend/browse-paralegals.html:1037-1043` now has a multi-state filter with selected chips.
- `backend/routes/public.js:507-510` now filters public paralegals by approved, visible, public-ready, and available profiles.
- `backend/routes/public.js:214-230` now excludes unavailable paralegals from the public browse results.

Remaining standard:

Every filter/search/sort/list view should follow one shared pattern: immediate vs applied filtering, clear-all behavior, selected chips, keyboard accessibility, loading state that does not cause content jumps, and mobile parity.

### P2: Heavy use of `innerHTML` increases XSS review burden

The frontend uses `innerHTML` in many places. Some are escaped; some require deeper review.

Evidence:

- Search found many `innerHTML` and `insertAdjacentHTML` patterns across dashboards, profile settings, case detail, admin dashboard, help, and create-case flows.

Expected at $145k-$500k:

A clear rendering rule: use DOM APIs or vetted template helpers by default, require escaping for any server/user-controlled value, and add lint/test checks for unsafe rendering.

### P2: Client session data is stored in localStorage/sessionStorage in multiple places

The app appears to use cookies for auth, but frontend pages also read/write user/session data in storage.

Evidence:

- `frontend/login.html:18`, `frontend/index.html:2051`, `frontend/dashboard-attorney.html:7`, `frontend/dashboard-paralegal.html:14`, and other pages reference `localStorage` user/session data.

Expected at $145k-$500k:

Keep auth authority server-side/cookie-based and treat local storage as non-authoritative display cache only. Document that rule and audit every page using storage.

## Engineering Quality Findings

### P1: Critical backend files are too large

Large route files are not automatically wrong, but for money, cases, disputes, and admin operations they raise the cost of safe change.

Evidence:

- `backend/routes/cases.js`: 6,718 lines.
- `backend/routes/payments.js`: 3,416 lines.
- `backend/routes/admin.js`: 2,750 lines.
- `backend/routes/users.js`: 1,480 lines.
- `backend/routes/uploads.js`: 1,260 lines.

Expected at $145k-$500k:

Split business logic into services with small route handlers. Route files should mostly validate, authorize, call a service, and serialize.

### P2: Test coverage exists, but browser coverage does not appear broad enough

The backend has a meaningful test suite, which is a strength.

Evidence:

- `backend/tests` contains 71 entries.
- `backend/package.json:20-39` defines Jest, e2e node scripts, and Playwright scripts.
- Playwright scripts are currently focused on control-room and support surfaces, not the full attorney/paralegal marketplace journey.

Expected at $145k-$500k:

Automated browser coverage for signup, approval, login, attorney browse, invite/hire, case creation, funding, messaging, completion, dispute, refund/payout, profile settings, and admin moderation.

### P2: Workspace hygiene is below premium delivery standard

The local workspace contains generated/developer artifacts.

Evidence:

- `.DS_Store` files exist in multiple directories.
- `backend/node_modules` exists in the workspace.
- `backend/.env` exists locally.
- These were not tracked by git according to `git ls-files`, which is good.

Expected at $145k-$500k:

Clean handoff, verified `.gitignore`, documented environment setup, no accidental local artifacts in delivery packages, and secret handling instructions.

## Current Strengths

These are worth preserving:

- JWT verification checks the current database user and blocks disabled/deleted users: `backend/utils/verifyToken.js:155-172`.
- There is a central case-access helper with participant checks and revoked paralegal access handling: `backend/utils/authz.js:61-160`.
- Public paralegal profiles have a quality gate requiring bio, resume, skills, practice areas, and approved photo: `backend/utils/paralegalProfile.js:46-65`.
- Stripe webhook handling is mounted before JSON parsing and uses raw body verification.
- Rate limiting exists for auth, messages, uploads, cases, public directory, and general API traffic.
- There is a substantial backend test suite and explicit e2e scripts in `backend/package.json`.
- The browse paralegal availability/state filter issue you raised has been corrected in current code.

## What This Needs To Meet The $145k-$500k Standard

1. Security hardening pass:
   - Central CSRF protection for every browser mutation route.
   - CSP without `'unsafe-inline'`.
   - API no-store middleware mounted before authenticated APIs.
   - Route inventory with auth, role, CSRF, rate-limit, and audit-log columns.

2. Money-flow certification:
   - Payment lifecycle matrix.
   - Stripe webhook duplicate/retry tests.
   - Connect onboarding failure tests.
   - Refund/payout reconciliation.
   - Manual production-like Stripe test evidence.

3. Frontend stabilization:
   - Shared component/control patterns.
   - Shared filter/list behavior.
   - Reduced monolithic scripts.
   - Accessibility and keyboard testing.
   - No layout jumps on loading/filtering.

4. Role and permission audit:
   - Attorney, paralegal, admin, director, unauthenticated role matrix.
   - Automated tests proving unauthorized users cannot read or mutate cases, files, messages, payments, applications, drafts, blocks, or admin records.

5. Production operations:
   - Separate worker/scheduler process or leader election.
   - Observability: structured logs, error tracking, payment alerts, job health.
   - Backup/restore drill.
   - Incident runbook.
   - Staging environment matching production.

6. QA release gate:
   - Full Jest suite.
   - Critical Playwright suite.
   - Payment sandbox run.
   - Accessibility scan.
   - Mobile/responsive pass.
   - Regression checklist signed off before deployment.

## Bottom Line

The current product looks like a serious MVP with real backend investment, not a throwaway site. But if the expectation is a $145,000 to $500,000 finished legal marketplace, the current state is not there yet.

The largest gap is not one visual bug. It is uneven production discipline: some routes and flows are hardened, others are not; some UI patterns are thoughtful, others are brittle; some test coverage exists, but not enough browser and money-flow proof for a premium launch.
