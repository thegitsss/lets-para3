# LPC Premium Remediation Plan

Date: July 5, 2026

This plan converts the audit standard into the working priority order for LPC. The goal is not to add random features. The goal is to make LPC feel and operate like a premium legal-tech marketplace before attorney outreach ramps up.

## Operating Standard

Every attorney-facing and money-adjacent workflow must feel complete, polished, secure, and professionally operated. LPC should not expose experimental behavior, unclear next steps, inconsistent controls, brittle layouts, or shortcuts in payment/security flows.

The detailed definition of "complete" is maintained in `docs/LPC_PREMIUM_READINESS_DEFINITION.md`. That document is the acceptance bar for attorney inflow and should be used alongside this remediation plan.

## Priority Order

1. Attorney trust and conversion flows.
2. Payment, escrow, case lifecycle, and security hardening.
3. UX/design consistency across every page.
4. AI-assisted workflow improvements that reduce attorney friction.
5. Admin visibility and operational control.
6. Codebase maintainability and regression prevention.

## Immediate Release Gate

Before attorney outreach is treated as production-ready, LPC should pass these checks:

- Browse paralegals feels stable, filters are predictable, unavailable paralegals are hidden, and empty states guide the attorney.
- Attorney signup/login/profile/dashboard/case creation flows have clear next steps and no dead-feeling screens.
- Payment, escrow, dispute, refund, payout, and case completion paths have test coverage and operational visibility.
- Every browser-originated authenticated mutation has CSRF protection or an explicit documented exemption.
- Attorney-facing pages share consistent controls, spacing, loading states, empty states, and responsive behavior.
- Admin has enough visibility to approve users, monitor money-risk issues, manage disputes, and recover from workflow problems.
- Critical workflows have regression tests before further visual or feature work is layered on top.

## Active Workstream

### 1. Security Hardening

Current action:

- Add CSRF protection to authenticated mutation routes identified in the audit.
- Keep tests/dev stable by using existing environment-gated CSRF behavior.

Next:

- Produce a full route inventory with auth, role, CSRF, rate-limit, and audit-log columns.
- Move API no-store cache headers before authenticated API routes.
- Plan CSP cleanup to remove inline script dependency.

### 2. Attorney Trust and Conversion

Next:

- Audit attorney-facing first impressions: `index.html`, `signup.html`, `login.html`, `browse-paralegals.html`, `profile-paralegal.html`, `dashboard-attorney.html`, `create-case.html`, and `case-detail.html`.
- Fix inconsistent empty states, unclear CTAs, loading jumps, and workflow dead ends.
- Make case creation and paralegal selection feel guided and intentional.

### 3. Payment and Lifecycle Reliability

Next:

- Build a money-flow matrix for funding, failed payment, dispute, partial settlement, full refund, completion, payout retry, paralegal withdrawal, attorney cancellation, and admin override.
- Map each path to tests and admin visibility.
- Add missing tests before making broad behavior changes.

### 4. UX System Consistency

Next:

- Establish shared patterns for filters, chips, dropdowns, modals, loading states, empty states, pagination, and destructive confirmations.
- Apply those patterns to attorney-facing pages first.

### 5. Admin Control

Next:

- Identify admin screens that are operationally necessary during attorney outreach.
- Make money-risk, case-risk, approval, support, and dispute actions easy to find and verify.

### 6. Maintainability

Next:

- Reduce risk in large files by extracting shared helpers only where it directly supports stability.
- Add regression tests around fixed workflows.
