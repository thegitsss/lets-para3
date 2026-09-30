# Paralegal V2 Phase 8D — Submissions and revisions

## Scope completed

- Reframed the existing active-Matter file upload as a paralegal submission without changing its route, storage behavior, validation, or authoritative state transition.
- Added an explicit confirmation before `POST /api/uploads/case/:caseId?presentation=matter`; a selected file is not sent until the paralegal confirms.
- Continued to refetch the authoritative server file list after submission. The client does not manufacture a successful submission or advance a file status.
- Presented the existing CaseFile states exactly: `pending_review`, `approved`, and `attorney_revision`.
- Distinguished attorney-shared files from paralegal submissions so an attorney upload is not mislabeled as work awaiting that same attorney's review.
- Added the existing `revisionNotes` field to the minimized participant Matter-file projection. Storage keys, raw uploader IDs, and private URLs remain excluded.
- Presented attorney revision notes and a direct file-picker action for the paralegal's updated response. The existing upload authority remains the response mechanism.
- Preserved existing version behavior: a later upload with the same original filename receives the next version number; the V2 client does not rewrite the earlier file record.
- Kept all attorney review decisions out of the paralegal client. V2 does not call a file-status, revision-request, replacement, approval, completion, payment, or payout mutation.
- Synchronized changed server file evidence across open Matter tabs and invalidated/refreshed already-open Home and My Matters views without reloading the application shell.
- Kept historical evidence read-only wherever the existing Matter authority returns it.

## Exact authority retained

The current source of truth uses these records and states:

- `CaseFile.status`: `pending_review`, `approved`, or `attorney_revision`.
- A participant uploads through `POST /api/uploads/case/:caseId`; the server creates a `CaseFile` with `pending_review`, a server timestamp, and the next filename-based version.
- Only the Matter attorney may mutate review state through `PATCH /api/cases/:caseId/files/:fileId/status`.
- The assigned paralegal cannot approve a file, request a revision, or use the attorney-only replacement route.
- Both listing and mutation authority recheck approved-account, Matter-participant, assigned-paralegal, funded/in-progress workspace, block, read-only, archive, and revoked-access rules already enforced by the routes.

## Existing inconsistencies preserved and isolated

The repository contains two additional routes that do not match the established legacy attorney review path:

- `POST /api/cases/:caseId/files/:fileId/revision-request` is attorney-only but writes `pending_review`, not `attorney_revision`.
- `POST /api/cases/:caseId/files/:fileId/replace` is attorney-only and writes `attorney_revision` after replacement.

The manually exercised attorney interface uses the general status route and writes `attorney_revision` when revisions are requested. Phase 8D does not call, remove, rename, or reinterpret either contradictory route. Their reconciliation requires separate lifecycle authorization.

There is no separate Submission aggregate and no explicit paralegal revision-response link in the current schema. A revised paralegal file is another `CaseFile` creation with its own timestamp and version; using the same filename advances its version. Phase 8D shows that evidence without inventing a submission or supersession state.

## Notification and history determination

- A successful file upload retains the existing `file_uploaded` audit entry, `case_file_uploaded` notification behavior, workspace-presence suppression, and `documents` Matter event.
- The existing attorney file-status route records `case.file.status.update` and publishes the `documents` event, but it does not create an LPC Notification or send email.
- V2 therefore refreshes an open Matter and other V2 surfaces from confirmed server evidence, but does not fabricate a notification for an attorney review decision.
- Existing attorney messaging remains the only current path that can separately notify the paralegal about requested changes.

## Stale, retry, and historical behavior

- Duplicate submits are blocked while a submission is pending.
- A rejected submission retains the selected local file for an explicit retry.
- `401` leaves the protected shell; `403` and Matter-level `404` purge the inaccessible file content and revalidate Matter authority.
- External `documents` events and Matter-specific BroadcastChannel messages trigger a server refetch; only a changed server fingerprint is propagated to Home and My Matters.
- Historical Matter presentation never exposes submit, revision-response, download, scan-refresh, or attorney-review controls. Historical access remains limited to whatever the existing Case authority returns; Phase 8D does not expand authorization.

## Intentionally excluded

- Attorney approval or revision-request controls
- Reconciliation or removal of the contradictory named revision/replacement routes
- File deletion
- A new Submission model, new status, supersession link, or schema migration
- Matter completion or task approval
- Notification/email changes
- Payment, payout, refund, dispute, chargeback, or Stripe behavior
- Production access, migration, deployment, or user-data changes

## Verification

- Focused Phase 8B/8D contracts and cross-role lifecycle tests: 3/3 suites and 14/14 tests passed.
- Phase 8D browser matrix: 21/21 scenarios passed across Chromium, Firefox, and WebKit.
- Integrated Phase 7/8A/8B/8C/8D Matter-workspace browser matrix: 93/93 scenarios passed across Chromium, Firefox, and WebKit.
- Complete Jest suite: 207/207 suites and 1,560/1,560 tests passed under Node 24.18.0.
- Coverage includes explicit confirmation, duplicate-submit protection, server refetch, exact status presentation, attorney/paralegal authority, revision notes, stale access, multi-tab refresh, already-open Home reconciliation, historical read-only behavior, Assistant-open containment, Axe, and widths 320, 360, 375, 390, 430, 768, 1024, 1440, and 1920.
