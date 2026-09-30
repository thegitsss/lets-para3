# Paralegal V2 Phase 8A — Matter messaging

## Scope completed

- Connected text-message sending inside the V2 Matter workspace to the existing `POST /api/messages/:caseId` authority.
- Connected explicit read acknowledgement to the existing `POST /api/messages/:caseId/read` authority.
- Preserved the existing approved-user, active-participant, funding, read-only, block, and Matter-access policies in the backend.
- Refetched the authoritative conversation after a successful send. No optimistic message record is fabricated in the client.
- Preserved a draft after validation, network, rate-limit, or server failure and guarded a pending submission against duplicate sends.
- Added Matter-event streaming with polling fallback and same-origin `BroadcastChannel` refresh signals for open-tab synchronization.
- Invalidated Home and My Matters projections after message/read changes so unread and activity values are refreshed from their existing APIs.
- Revalidated stale `401`, `403`, and `404` mutation responses. Authentication loss exits the protected shell; authorization loss removes the composer and refreshes the Matter authority before retaining content.
- Kept completed, archived, read-only, and server-closed message views non-mutable.
- Kept the persistent shell and Assistant mounted; message refreshes replace only the conversation content.

## Intentionally excluded

- File attachments
- Message editing or deletion
- Reactions
- Pinning
- Deadline, submission, revision, approval, or completion mutations
- Status, schema, payment, payout, refund, or Stripe changes
- Production access, deployment, or migration

## Verification

- Focused V2, policy, authorization, persistence, and backend messaging selections passed, including both cross-role directions.
- Combined Phase 7/8A Chromium Matter regression: 11 scenarios passed.
- Phase 8A Chromium, Firefox, and WebKit matrix: 18 scenarios passed.
- Complete Jest suite under Node 24.18.0: 202 suites and 1,536 tests passed.
- JavaScript syntax check: 647 files parsed successfully.
- Frontend hygiene: 37 HTML entry points, 500 local asset references, 83 reachable modules, and 42 reachable stylesheets passed.
- Performance budget: 196 files totaling 5,395.2 KiB passed.
- Required widths verified: 320, 360, 375, 390, 430, 768, 1024, 1440, and 1920 pixels.
- Assistant-open containment, draft preservation, duplicate-submit protection, server failure/retry, stale authorization, multi-tab refresh, historical closure, and WCAG A/AA checks passed.

## Audit correction

The first combined regression exposed a shared date/time formatter that had been moved out of `matter-view.mjs` while the History panel still used it. The formatter was restored to the workspace module, and the complete old/new Matter regression passed afterward.

The messaging accessibility scan also identified an existing shared-header mismatch: the search input used combobox ARIA state without the matching semantic role. Adding `role="combobox"` reconciled the semantics without changing search behavior or layout.
