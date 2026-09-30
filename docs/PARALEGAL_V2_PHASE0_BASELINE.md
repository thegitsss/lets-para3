# Paralegal V2 Phase 0 Baseline

Status: Phase 0 characterization record

Recorded: September 2, 2026

## Authorization boundary

The owner approved beginning the Paralegal Application V2 rebuild on September 2, 2026. Under `PARALEGAL_APPLICATION_V2_REBUILD_PLAN.md`, the current authorization covers Phase 0 and the isolated Phase 1 foundation only.

This authorization does not include:

- production access or production-data inspection;
- deployment or release configuration changes;
- replacement or retirement of a current paralegal route;
- schema, lifecycle, payment, Stripe, recommendation, or eligibility changes;
- migration, deletion, backfill, or compatibility-layer removal;
- connection of Matter-workspace mutations.

## Repository baseline

- Branch at baseline: `dashboard-redesign`
- HEAD at baseline: `6cecc07a72a74d4bffd9cd5fa061f738db29d00c`
- Required runtime: Node `24.18.0`, npm `11.16.0`
- Complete Jest result: `194/194` suites and `1,473/1,473` tests passed
- Complete rerun duration: `249.786 s`
- Production or Stripe access: none

The first complete run had one isolated failure: the public paralegal profile projection in `profilePhotoDelivery.test.js` received `401` instead of `200`. The suite then passed `18/18` tests in isolation, and the unchanged complete suite passed `194/194` and `1,473/1,473` on immediate rerun. This is recorded as a transient/order-sensitive test-state event. No production behavior or timeout was changed in response.

## Existing worktree ownership

The worktree was already extensively modified before V2 foundation work began. Those modifications remain owner work and must not be overwritten, staged, reverted, or attributed to Phase 1.

Phase 1 therefore uses new, isolated files. Its owned-file list is maintained in this record and in the Phase 1 test contract.

## Binding behavior authority

V2 must preserve the behavior captured by:

- `DOMAIN_LIFECYCLE_INVENTORY.md`
- `DASHBOARD_VISIBILITY_MATRIX.md`
- `SCENARIO_COVERAGE_REPORT.md`
- `DUPLICATED_RULES_AND_RISKS.md`
- `PARALEGAL_TEST_CHECKLIST.md`
- `PARALEGAL_V2_CLEANUP_CHECKLIST.md`
- `PHASE6_COMPATIBILITY_RETIREMENT_REPORT.md`
- `docs/PARALEGAL_ASSISTANT_HARDENING_CHECKLIST.md`
- `docs/paralegal-assistant/DATA_PERMISSION_MATRIX.md`
- `docs/paralegal-assistant/RESPONSE_CONTRACT.md`
- `docs/paralegal-assistant/RISK_REGISTER.md`
- `docs/paralegal-assistant/SOURCE_OF_TRUTH_MATRIX.md`
- `docs/paralegal-assistant/WORKFLOW_POLICY_INVENTORY.md`

The current code, schemas, routes, services, jobs, webhooks, queries, and green tests remain authoritative where documents and implementation differ.

## Current paralegal entry points to preserve

| Current destination | Current entry | Phase 1 V2 route |
|---|---|---|
| Home | `dashboard-paralegal.html#home` | `paralegal-v2.html#/home` |
| My Matters & Applications | `dashboard-paralegal.html#cases` | `paralegal-v2.html#/work` |
| Browse Matters | `browse-jobs.html` | `paralegal-v2.html#/browse` |
| Profile Settings | `profile-settings.html` | `paralegal-v2.html#/settings` |
| Paralegal Help | `paralegalhelp.html` | `paralegal-v2.html#/help` |
| Profile preview | `profile-paralegal.html?paralegalId=…` | `paralegal-v2.html#/profile/:profileId` |
| Matter workspace | `case-detail.html?caseId=…` | `paralegal-v2.html#/matter/:matterId` |

The V2 routes are isolated, provisional foundation URLs. No current link redirects to them, and no current deep link has been changed.

## Phase 1 architecture decisions

- One static HTML entry contains the complete shell before hydration.
- Hash routes are used for the isolated foundation so direct refresh works without changing server fallback behavior.
- Only the route outlet is replaced during navigation.
- The sidebar, header, account cluster, search host, notification host, Assistant, toast region, and dialog host remain mounted.
- The route outlet is the only application scroll owner.
- Wheel and trackpad gestures over the fixed sidebar are forwarded to that scroll owner. A genuinely non-scrollable route receives a four-pixel visual response, disabled when reduced motion is requested.
- Search and notifications use anchored overlays that do not resize the header.
- The Assistant is narrow and docked by default when opened; it has no pin control and no shadow.
- Desktop sidebar collapse is not part of Phase 1.
- Current `light` and `dark` appearances are supported; retired Mountain variants are normalized and are not restored.
- Session cache is presentation-only. `/api/auth/me` is the authorization authority.
- Phase 1 reads only session identity. It does not retrieve Matter, application, message, file, deadline, notification, or payment records.
- Sign out remains an explicit shell-level authenticated action using the existing CSRF contract.

## Phase 1 owned files

- `frontend/paralegal-v2.html`
- `frontend/assets/styles/paralegal-v2.css`
- `frontend/assets/scripts/paralegal-v2/first-paint.js`
- `frontend/assets/scripts/paralegal-v2/shell-prime.js`
- `frontend/assets/scripts/paralegal-v2/api-client.mjs`
- `frontend/assets/scripts/paralegal-v2/session-boundary.mjs`
- `frontend/assets/scripts/paralegal-v2/router.mjs`
- `frontend/assets/scripts/paralegal-v2/app.mjs`
- `backend/tests/paralegalV2FoundationContract.test.js`
- `backend/tests/playwright/paralegal-support/v2-foundation.spec.js`
- `docs/PARALEGAL_V2_PHASE0_BASELINE.md`

## Deferred owner decisions

These remain intentionally deferred because Phase 1 does not depend on them:

- final clean-path production URL structure;
- which professional profile fields autosave and the save delay;
- Browse filter submission behavior;
- V2 canary cohort and rollout thresholds;
- legacy-route retirement timing.

No deferred decision may be silently converted into production behavior during Phase 1.
