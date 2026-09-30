# Paralegal V2 Phase 3 — Browse Matters

## Scope

Phase 3 moves Browse Matters into the isolated persistent V2 shell. It does not change backend business rules, schemas, legacy pages, production routing, or the public entry point.

The V2 Browse route is `paralegal-v2.html#/browse`. Sidebar, header, Assistant, authenticated session boundary, and scroll owner remain mounted while Home, Browse, Browse details, and browser history change in the same document.

## Authoritative behavior preserved

- `GET /api/jobs/open` remains the source of authorized open listings and each listing's server-projected `applicationEligibility`.
- Browse remains intentionally broader than Home recommendations. It does not recalculate state, practice-area, or experience recommendation eligibility.
- `GET /api/applications/my` supplements the listing projection so active prior applications stay out of Browse results.
- The server remains authoritative for duplicate applications, profile-photo readiness, approved-account status, blocks, open/assigned state, and live Stripe payout readiness.
- `POST /api/jobs/:jobId/apply` and the existing Case fallback `POST /api/cases/:caseId/apply` remain the only application mutations.
- `POST /api/cases/:caseId/flag` remains the Matter-reporting mutation.
- A successful application invalidates the V2 Home projection and publishes the existing recommendation-history event so another recommendation surface cannot retain the Matter as current.

## Browse experience

- The existing practice area, state, minimum compensation, deadline, date-posted, and sort controls are retained.
- A paralegal's state remains the initial filter only when an authorized open listing matches it. State abbreviations and full names resolve to the same state.
- Clear exposes the broader authorized open catalog.
- Filter state is represented in the V2 hash URL without causing a document navigation.
- Details use `#/browse?matterId=...` and can be opened, refreshed, copied, or reached through browser history without leaving the shell.
- Missing or no-longer-authorized deep links fail closed and do not fetch or reveal a separate record.
- Application and reporting forms use bounded, accessible native dialogs and the shared CSRF-aware API client.
- Successful applications are removed immediately, followed by an explicit confirmation; navigation to applications is optional rather than forced.

## Visual and responsive contract

- The page keeps LPC's white canvas, editorial typography, navy actions, restrained gold labels, and no-shadow treatment.
- Desktop uses a quiet filter rail and an aligned result register.
- At narrow widths the filters become a bounded drawer without remounting the global shell.
- Browser coverage checks 320, 360, 375, 390, 430, 768, and 1440 pixel widths.

## Rollout boundary

Legacy `browse-jobs.html` remains available and unchanged. No route cutover should occur until Work, Settings, Help, Profile, and Matter workspace views have equivalent V2 behavior and the final compatibility gate is approved.
