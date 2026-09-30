# Paralegal V2 Phase 4 — My Matters & Applications

## Scope

Phase 4 moves the paralegal’s active Matters, pending invitations, current applications, and completed/withdrawn Matter history into the isolated persistent V2 shell. It does not change backend lifecycle rules, schemas, legacy pages, production routing, or payment behavior.

The V2 Work route is `paralegal-v2.html#/work`. Sidebar, header, Assistant, session boundary, and scroll owner remain mounted while the central Work view changes.

## Existing authority preserved

- `GET /api/paralegal/dashboard` remains authoritative for active assigned Matters.
- `GET /api/applications/my` remains authoritative for the paralegal application projection. V2 preserves the current active-queue rule: only `submitted`, `viewed`, and `shortlisted` applications attached to an open Job are shown.
- `GET /api/cases/invited-to` remains authoritative for pending invitations.
- `GET /api/cases/my-completed` remains authoritative for completed and withdrawn Matter history, payout-detail availability, withdrawal-review eligibility, and interaction-block eligibility.
- `GET`, `POST`, and `DELETE /api/account/dashboard-views` remain authoritative for scoped application saved views.
- No browser code introduces, renames, or repairs lifecycle statuses.

## Existing mutations retained

- Invitation accept/decline: `POST /api/cases/:caseId/invite/:decision`.
- Accepted-invitation revoke: `POST /api/cases/:caseId/invite/revoke`.
- Canonical application revoke: `POST /api/applications/:applicationId/revoke`.
- Pre-engagement response: `POST /api/cases/:caseId/pre-engagement/respond` with the existing multipart fields.
- Withdrawal review: `POST /api/disputes/:caseId` only when the completed projection reports `canDispute`.
- Future-interaction block: `POST /api/blocks` only when the completed projection reports `blockStatus.canBlock`.

Every mutation waits for the server response before changing the rendered state. Successful mutations invalidate the V2 Home and Browse caches and reload the Work projection. Failed or stale actions leave the current projection visible and show the server error.

## Experience

- A compact index exposes authoritative counts for Active, Applications, Invitations, and History.
- Pending invitations become a focused response band only when real invitations exist.
- Active Matters and applications use aligned, ruled work registers rather than large generic cards.
- Applications retain status, practice-area, date-range, sort, search, three-item pagination, and custom saved-view behavior.
- Pre-engagement requirements remain available from application details, including confidentiality review/acknowledgment, optional signed-document upload, conflicts response, and resubmission after changes are requested.
- Completed and withdrawn Matter history retains payout-detail downloads, the exact 24-hour review eligibility from the server projection, and block/settings actions.
- Empty and unavailable states remain local to each section.

## Deep-link and rollout boundary

The Work route accepts existing highlighted Case, Application, and Job identifiers through its hash query. Application details stay inside the V2 shell. Active Matter workspace links continue to the existing authorized `case-detail.html` entry until the dedicated Matter workspace phase is complete; V2 does not present a nonfunctional workspace substitute.

Legacy `dashboard-paralegal.html#cases` remains available and unchanged. No production cutover or deployment is part of Phase 4.
