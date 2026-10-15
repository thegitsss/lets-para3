# Attorney V2 Phase 0 Baseline

Status: **Phase 0 characterization package; no V2 implementation is authorized by this record**

Recorded: September 4, 2026

## Authorization boundary

The owner authorized Attorney V2 Phase 0 after approving `ATTORNEY_APPLICATION_V2_MIGRATION_AND_V1_RETIREMENT_PLAN.md`. Phase 0 may add attorney-specific audit artifacts and non-mutating contract tests. It may inspect existing repository code and run local tests.

It does not authorize:

- an Attorney V2 entry, shell, component, route, feature flag, or user interface;
- edits to attorney V1 runtime files;
- edits to paralegal V1 or V2 files;
- edits to shared frontend or backend runtime infrastructure;
- lifecycle, authorization, payment, Stripe, schema, or API changes;
- production access, production-data inspection, migration, deletion, backfill, deployment, or traffic switching;
- V1 redirect or compatibility removal.

## Repository baseline

- Branch: `dashboard-redesign`
- HEAD: `6cecc07a72a74d4bffd9cd5fa061f738db29d00c`
- Local runtime observed: Node `v22.17.0`, npm `10.9.2`
- Pre-existing worktree entries before Attorney Phase 0: `289`
- Production or live Stripe access: none
- Database access during inventory: none; later executable characterization used only the repository's local ephemeral in-memory MongoDB fixtures

The worktree was already extensively modified by owner work, including the active paralegal V2 effort and shared frontend/backend changes. The 289-entry count is a scope warning, not a claim that those changes belong to one project. Attorney Phase 0 does not modify, stage, revert, or adopt them.

Before Phase 1, the owner must name either:

1. a clean commit containing the intended paralegal/shared baseline; or
2. this commit plus an explicit, immutable manifest of allowed working-tree dependencies.

Until then, `6cecc07a72a74d4bffd9cd5fa061f738db29d00c` is the comparison anchor, but the current dirty tree is the observed behavioral snapshot.

## Phase 0 owned files

- `ATTORNEY_APPLICATION_V2_MIGRATION_AND_V1_RETIREMENT_PLAN.md`
- `docs/attorney-v2/PHASE0_BASELINE.md`
- `docs/attorney-v2/protected-paths.json`
- `docs/attorney-v2/routes.json`
- `docs/attorney-v2/api-dependencies.json`
- `docs/attorney-v2/lifecycle-fixtures.json`
- `docs/attorney-v2/DEFECT_REGISTER.md`
- `docs/attorney-v2/TEST_TRACEABILITY.md`
- `docs/attorney-v2/V1_CHARACTERIZATION_EVIDENCE.md`
- `docs/attorney-v2/V1_BROWSER_BASELINE.md`
- `backend/tests/attorneyV2Phase0AuditContract.test.js`

No file outside this list is owned by Attorney Phase 0.

## Current V1 scale

The highest-risk attorney presentation sources are:

| Source | Observed lines | Risk |
|---|---:|---|
| `frontend/dashboard-attorney.html` | 6,232 | Inline shell/views/styles/scripts and dialog ownership |
| `frontend/assets/scripts/attorney-tabs.js` | 7,674 | Home, Matters, Applications, Tasks, Payments, onboarding, actions |
| `frontend/case-detail.html` | 3,782 | Shared role-conditional Matter workspace DOM |
| `frontend/assets/scripts/case-detail.js` | 6,566 | Shared A/P workspace, realtime, files, messages, lifecycle actions |
| `frontend/create-case.html` | 3,524 | Inline multi-step draft/edit/publish workflow |
| `frontend/profile-settings.html` | 5,828 | Shared, paralegal-first role-conditional settings DOM |
| `frontend/assets/scripts/profile-settings.js` | 7,400+ | Attorney/paralegal profile, security, preferences, account behavior |

These sizes are characterization facts, not targets for mechanical splitting.

## Binding artifacts

The master plan and its Section 3 sources remain binding. Phase 0 adds:

- `routes.json`: all identified authenticated attorney V1 entries, route state, producers, and proposed V2 responsibility;
- `api-dependencies.json`: endpoint families actually consumed or required by scoped attorney behavior, with guards and mutation safety;
- `protected-paths.json`: write boundaries for Attorney V2 work;
- `lifecycle-fixtures.json`: synthetic personas and scenario matrix required before mutation phases;
- `DEFECT_REGISTER.md`: defects and ambiguities kept separate from V2 design;
- `TEST_TRACEABILITY.md`: coverage requirements and Phase 0 exit evidence.
- `V1_CHARACTERIZATION_EVIDENCE.md`: focused synthetic test result and adopted lifecycle/cross-role evidence.
- `V1_BROWSER_BASELINE.md`: authenticated Chromium/Firefox/WebKit results, including reproducible V1 failures.

## Phase 0 decisions

- Attorney V2 will be isolated rather than converted in place.
- The current backend is fixed and authoritative for V2.
- V1 aliases, fallbacks, and redirects are retained until separately proven removable.
- Existing status disagreements are characterized, not normalized.
- All fixtures are synthetic and use reserved `.test` identities.
- All payment fixtures use provider doubles/test mode and must be unable to reach live Stripe.
- Phase 0 contract tests inspect files only and do not import application routes, connect to a database, or make network calls.

## Exit status

The technical Phase 0 package is complete when the focused audit contract passes. Phase 1 remains explicitly blocked until the owner decisions in `TEST_TRACEABILITY.md` are resolved and Phase 1 is separately authorized. Passing the audit contract does not authorize Phase 1.
