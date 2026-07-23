# Paralegal Assistant Package 1 Implementation

Status: complete

Date: July 23, 2026

## Outcome

Package 1 established an independent paralegal capability, evidence, permission, workflow, response, evaluation, and risk baseline. It deliberately made no runtime behavior change and did not enable the manager for paralegals.

## Findings

- P01–P32 are now defined independently from attorney capabilities.
- Seven tools are currently allowlisted to the paralegal role, but only `get_payout_snapshot` is paralegal-specific.
- Current paralegal chat still depends heavily on legacy phrase routing and generated replies.
- The attorney planner, capability IDs, validators, safe fallback, reliability metrics, and rollout controls cannot be safely reused without role-specific replacements.
- Application/invitation/pre-engagement state spans multiple stores.
- Payout setup, LPC release, Stripe transfer/payout, and bank receipt require separate evidence.
- Assigned, withdrawn, completed, archived, read-only, and revoked-access matter rules need one shared evaluator.

## Safety verification

- `getEnabledManagerRoles()` remains hardcoded to `attorney`.
- `OPENAI_SUPPORT_MANAGER_ROLES` cannot enable paralegal manager execution.
- Existing regression coverage asserts paralegal/admin remain on the legacy path during attorney rollout.
- No source, route, model, frontend, or runtime configuration changed in Package 1.

## Package 2 boundary

Package 2 begins with executable paralegal workflow/capability definitions and least-privilege tools. Manager execution remains disabled until Packages 2–8 pass and Package 9 rollout gates are implemented.
