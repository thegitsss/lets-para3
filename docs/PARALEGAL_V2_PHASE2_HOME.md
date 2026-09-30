# Paralegal V2 Phase 2 — Home

Status: implemented locally for owner review; not cut over, committed, deployed, or exposed to production users.

## Why the legacy pages still blink

`dashboard-paralegal.html`, `browse-jobs.html`, `profile-settings.html`, and the other current paralegal documents still use cross-document links. A browser must recreate their sidebar, header, styles, scripts, and page data after each navigation. Phase 1 intentionally created an isolated application shell at `paralegal-v2.html`; it did not change those links or claim to make the legacy documents persistent.

The legacy routes must remain available until each real V2 view has been implemented and verified. Redirecting them to placeholder content would remove working functionality and is not an acceptable anti-blink fix.

## Phase 2 implementation

- Home is now a real route inside the persistent V2 shell.
- The sidebar, header, application frame, Assistant drawer, popovers, and overlay hosts remain mounted while routes change.
- The first Home render waits for session verification and then commits one composed projection instead of revealing a sequence of partially hydrated states.
- Home reads the existing authoritative endpoints for the dashboard, profile, Stripe Connect readiness, recommendations, invitations, events, messages, unread count, applications, and authorized Matter detail.
- Recommendation eligibility remains server-authoritative through `/api/jobs/recommended`; the Home view does not recalculate eligibility.
- Availability continues to use `/api/paralegals/update-availability` through the shared V2 CSRF-aware API boundary and updates in place.
- A short-lived in-memory Home projection prevents a second loading surface when a user returns to Home during ordinary same-document navigation.
- Request failures remain local to the affected Home region and do not turn unknown data into a false empty state.

## Preserved Home states

- Incomplete payout setup
- Incomplete matching profile
- Active Matter work surface
- Empty desk with recommendations held only in Matter folios
- Empty desk without recommendations
- Seven-day deadline calendar
- Office inbox priorities
- Active-application progress strip
- Compact no-active-application row
- Released-work compensation summary
- Available and unavailable scheduling states

## Verification boundary

The no-reload guarantee currently applies to navigation within `paralegal-v2.html`. It does not yet apply to the legacy routes. User-facing cutover is intentionally blocked until Browse Matters, My Matters & Applications, Profile Settings, Help, and required deep links have real V2 implementations and pass their preservation gates.
