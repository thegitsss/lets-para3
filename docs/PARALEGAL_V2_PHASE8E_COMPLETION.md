# Paralegal V2 Phase 8E — Approval and completion handoff

## Scope completed

- Connected the existing task-review and Matter-completion evidence to the paralegal V2 Work section without adding a paralegal mutation.
- Kept each scope task read-only. An unfinished Matter states that the Matter attorney marks work items complete as they are reviewed.
- When every saved scope task is complete but the Matter remains in progress, the Work section changes to a compact final-review handoff. It does not claim the Matter is completion-eligible, because funding, disputes, payout setup, and other attorney-side requirements remain authoritative.
- Added Matter-level event revalidation for existing `tasks` and `case` events. An open V2 workspace refetches the authorized Case projection rather than manufacturing a new client state.
- Preserved the existing completion boundary: after completion revokes live paralegal access, a stale workspace is removed and the Matter remains available through the existing completed-history projection.
- Kept file-review evidence from Phase 8D exact: `pending_review`, `approved`, and `attorney_revision` remain the only presented CaseFile review states.
- Added no schema, status, route, notification, email, payment, payout, refund, transfer, dispute, chargeback, or Stripe behavior.

## Exact authority retained

- Only the Matter attorney or an administrator may update Case scope-task completion through `PATCH /api/cases/:caseId`.
- Only the Matter attorney may complete a Matter through `POST /api/cases/:caseId/complete`.
- Matter completion remains the existing payment-release workflow. The paralegal V2 client does not call that endpoint and does not expose a completion or release control.
- Only the Matter attorney may change a CaseFile review status. The paralegal V2 client presents the saved result and exposes no approval or revision-request control.
- The server remains authoritative for task progress, Matter state, payment-release evidence, live workspace access, and completed-history visibility.

## State presentation

- One or more unfinished tasks: `Attorney review` — the attorney marks work items complete as they are reviewed.
- All saved tasks complete while the Matter remains active: `With the Matter attorney` — final review and Matter completion remain attorney-controlled.
- Completed record, where an authorized projection is supplied: `Matter completed`, with a separate distinction between recorded release evidence and a current non-released financial record.
- Completed production access: the existing Case route returns `403` or `404` to the paralegal after live access is revoked; the stale V2 workspace is purged and completed history remains the authorized surface.

## Synchronization and failure behavior

- Existing server `tasks` events refresh task progress and the completion handoff without reloading the application shell.
- Existing server `case` events revalidate access from Overview, Work, Deadlines, History, and Financials. Files and Messages retain their characterized controllers for the same Case event so duplicate refreshes are avoided.
- Repeated events remain read-only refetches and cannot create duplicate writes.
- A `401` leaves the protected shell. A `403` or `404` replaces confidential Matter content with the existing access-loss state.
- The active event stream is closed on route leave and before Matter rerender, preventing stale subscriptions from surviving navigation.

## Notification determination

- The existing attorney task update records audit evidence and publishes a `tasks` Matter event; it does not create a new LPC notification or email.
- Existing Matter completion behavior, including its audit, notification, archive, access-revocation, and financial effects, is unchanged and remains covered by the established lifecycle/payment suites.
- Phase 8E does not fabricate a paralegal notification for task review or completion handoff.

## Verification

- Focused authority, workflow-policy, Matter-experience, submission, and Phase 8E contracts: 5/5 suites and 24/24 tests passed under Node 24.18.0.
- Phase 8E Matter browser matrix: 24/24 scenarios passed across Chromium, Firefox, and WebKit.
- Integrated Phase 7/8A/8B/8C/8D/8E Matter-workspace browser matrix: 99/99 scenarios passed across Chromium, Firefox, and WebKit.
- Complete Jest suite: 209/209 suites and 1,567/1,567 tests passed under Node 24.18.0.
- JavaScript syntax, frontend hygiene, frontend API-contract, and performance checks passed. The measured frontend payload is 5,456.6 KiB within the existing budget.
- Coverage includes cross-role mutation denial, server-owned task progress, live task refresh, completion access loss, completed history, repeat-event safety, no document reload, Assistant-open containment, Axe, and required responsive widths.

## Intentionally excluded

- Paralegal task checkboxes, file approval, final approval, Matter completion, or payment-release controls
- Changes to attorney or administrator interfaces
- Changes to completion eligibility, payment release, payout timing, notifications, email, or archive policy
- New workflow states or client-authored completion claims
- Production access, migration, deployment, or user-data changes
