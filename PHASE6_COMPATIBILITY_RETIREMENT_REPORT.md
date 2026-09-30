# Phase 6 Compatibility Retirement Report

## Scope and safety

The production audits ran on 2026-09-01 through `backend/scripts/audit-phase6-compatibility.js` in aggregate-only mode. The utility uses the raw MongoDB client with majority read concern, retryable writes disabled, no application models, no Stripe imports, and no mutation methods. No record identifiers, user content, email addresses, or personal data were exported. Database fingerprint: `9ce764ef47ec`.

No database write, deletion, migration, Stripe request, deployment, commit, or compatibility removal occurred.

## Phase 6A provenance method

Phase 6A does not infer provenance from titles, statuses, amounts, dates, lifecycle shape, or the absence of a marker.

A user is classified as `known_test` only when its exact identity appears in a repository E2E script or development-only bypass allowlist, or its email uses an explicitly reserved LPC harness/test domain (`lets-paraconnect.dev`, `lets-paraconnect.local`, `.test`, or `.invalid`). Related Jobs, Cases, and Applications inherit test provenance only through those identified test actors.

The current schema has no machine-readable `real_customer` marker. Therefore, every account and related record without affirmative test evidence remains `unknown`; it is not automatically called real production data.

## Provenance results

| Record | Known test | Confirmed real by machine marker | Unknown |
| --- | ---: | ---: | ---: |
| Users | 28 | 0 | 125 |
| Jobs | 32 | 0 | 1 |
| Cases | 32 | 0 | 1 |
| Applications | 36 | 0 | 1 |

The repository/database evidence supports the owner’s correction: almost all Matter and Application records are known test-generated data, not customer workflow history.

## Test-data cleanup issues

These findings are fully attributable to explicitly identified test workflows:

- All 5 Applications that reference missing Jobs.
- All 3 submitted Applications missing Case applicant mirrors.
- All 3 embedded Case applicants without canonical Applications.
- 29 of 30 `Job.applicantsCount` mismatches, including the single mismatch on an open Job.
- 36 of 37 Applications, 32 of 33 Jobs, and 32 of 33 Cases.

These are test-environment hygiene issues. They do **not** establish that customer history requires the dual models or application mirrors, and they should not drive a customer-data migration plan. They remain untouched because Phase 6A authorizes no deletion or cleanup.

## Real production migration blocker

### Mountain themes — genuinely blocked

Production contains 101 `mountain` and 9 `mountain-dark` preferences. Seven `mountain` preferences belong to known test accounts. The remaining unclassified population is 94 `mountain` plus 9 `mountain-dark` accounts.

The product owner has affirmatively identified the 100+ stored mountain preferences as real user data. That owner evidence, combined with the database counts, is sufficient to treat mountain-theme compatibility as a genuine live-user dependency. Mountain theme CSS and preference handling must remain until a separately approved, reversible theme migration exists.

## Unknown or unmeasured dependencies

### Job / Case compatibility — unknown, not proven blocked by customers

- One linked Job/Case workflow is not tied to a known test identity.
- It is correctly linked in both directions, with no orphan or backlink mismatch.
- The audit cannot classify it as real or test without an affirmative marker.
- Active code still reads and writes both models.

Conclusion: raw record volume is test residue, but removal remains unproven because one workflow and active callers are unknown. Retain compatibility; do not build a large historical migration around the 32 known test workflows.

### Application / `Case.applicants` mirroring — test residue with one unknown workflow

- Every missing-Job, missing-active-mirror, and embedded-without-canonical defect is known test data.
- The one unknown Application has no orphaned-Job or missing-active-mirror defect.
- One non-open applicant-count mismatch belongs to an unknown Job.
- Active attorney, paralegal, admin, notification, search, Assistant, count, and deep-link consumers still use both projections.

Conclusion: the observed reconciliation defects are test cleanup, not a real-customer migration blocker. Mirror retirement remains an architectural/caller-migration question plus one unknown workflow, not a 37-record customer-history project.

### Identity, state, profile, practice-area, and status aliases — unknown

- Case attorney/paralegal and state aliases have no stored mismatches.
- Among unknown users, 48 store both profile-image aliases, 58 use `practiceAreas`, and 50 use `stateExperience`.
- No affirmative customer/test marker classifies those 125 users, and active code still reads compatibility aliases.

Conclusion: no stored inconsistency proves a migration is needed, but real-user dependency is not measurable from current markers. Retain aliases until callers are characterized and provenance is known.

### Legacy redirects — unmeasured

The database has no route-usage evidence, and the repository has no analytics source for legacy Applications, Assigned, or Invitations URLs. External emails, bookmarks, and notifications may still contain them.

Conclusion: retain redirects and their query/hash preservation until access-log or analytics evidence supports a deprecation decision.

## Independent compatibility conclusions

| Compatibility layer | Classification | Reason |
| --- | --- | --- |
| `Job` / `Case` | Unknown | 32/33 workflows are known test data; one is unclassified and active callers still use both |
| `Application` / `Case.applicants` | Primarily test residue; retirement still unknown | All material mirror defects are test-generated; one clean Application workflow and one non-open count mismatch are unclassified |
| Identity/state/profile/practice/status aliases | Unknown | No Case mismatches, but unclassified users and active callers still use the fields |
| Mountain theme CSS/preferences | Genuine real-user blocker | Owner confirms the 100+ stored preferences are real; production contains 103 non-test-classified mountain preferences |
| Legacy redirects | Unknown/unmeasured | No route analytics or access-log evidence |

## Current conclusion

Phase 6A corrects the earlier interpretation: the Matter/Application anomaly counts are overwhelmingly test residue and must not be treated as customer-history migration evidence. Mountain themes are the only compatibility layer currently proven to be blocked by real users. Job/Case, mirrors, aliases, and redirects remain intact because their remaining dependency is unknown or architectural—not because the raw test-generated counts prove a live-customer requirement.

No compatibility behavior should be removed or migrated until each unknown is independently resolved.
