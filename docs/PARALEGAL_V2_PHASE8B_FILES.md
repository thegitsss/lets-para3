# Paralegal V2 Phase 8B — Matter files

## Scope completed

- Connected the active V2 Files & submissions section to the existing authorized `GET /api/uploads/case/:caseId?presentation=matter` projection.
- Connected one-file upload to the existing `POST /api/uploads/case/:caseId?presentation=matter` authority.
- Connected scan-state refresh to the existing `GET /api/uploads/case/:caseId/:fileId/security-status` authority.
- Connected download to the existing `GET /api/uploads/case/:caseId/:fileId/download` authority.
- Preserved the existing approved-user, Matter-participant, assigned-paralegal, funded-workspace, active-status, block, revoked-access, S3, and malware-scan policies in the backend.
- Preserved the existing 20 MB limit and server-side MIME, extension, and signature validation. The browser accept list mirrors the existing permitted PDF, Office, text, CSV, and image formats but does not replace server enforcement.
- Refetched the authoritative file list after upload and scan checks. No optimistic file record is fabricated in the client.
- Preserved the selected local file after validation, network, rate-limit, or server failure and guarded an in-flight upload against duplicate submission.
- Kept pending, blocked, and scan-error files unavailable for download. The server rechecks the stored object before streaming every download.
- Added Matter `documents` event refresh, polling fallback, and user-agent-local `BroadcastChannel` refresh signals for open-tab synchronization.
- Invalidated Home, My Matters, and notification projections after server-confirmed file changes.
- Revalidated stale `401`, `403`, and `404` outcomes. Authentication loss exits the protected shell; authorization loss purges the file panel and revalidates Matter access; a missing individual file refreshes the list without treating the entire Matter as missing.
- Preserved completed, archived, and read-only Matter file metadata without presenting active upload, scan, or download controls that the existing backend does not authorize.
- Preserved `fileId` deep-link highlighting and focus inside the persistent shell.

## Intentionally excluded

- File deletion
- Message attachments
- Submission-state changes
- Revision requests or replacement workflows
- Approval actions
- Deadline or completion mutations
- Status, schema, storage, notification, payment, payout, refund, or Stripe changes
- Production access, deployment, migration, or user-data changes

## Verification

- Focused V2, policy, authorization, persistence, and backend file selections: 6 suites and 49 tests passed.
- Integrated Phase 7/8A/8B Matter workspace matrix: 54/54 scenarios passed across Chromium, Firefox, and WebKit.
- Complete Jest suite under Node 24.18.0/npm 11.16.0: 203/203 suites and 1,541/1,541 tests passed.
- JavaScript syntax: 649 files parsed successfully.
- Frontend hygiene: 37 HTML entry points, 500 local asset references, 84 reachable modules, and 42 reachable stylesheets passed.
- Performance budget: 197 files totaling 5,417.6 KiB passed without a threshold increase.
- Required widths verified: 320, 360, 375, 390, 430, 768, 1024, 1440, and 1920 pixels.
- Assistant-open containment, retry preservation, duplicate-submit protection, scan-state gating, authorized download, stale authorization, deep links, multi-tab refresh, historical closure, and WCAG A/AA checks passed.

## Audit corrections

- The deep-linked file highlight reduced 11 px metadata contrast below WCAG AA. The file metadata now uses the existing darker small-text token, and the accessibility check passes.
- The Phase 7 browser fixture still sourced active files from the embedded Case snapshot. It now stubs the authoritative Phase 8B file-list endpoint while retaining its Overview read-only assertion.
- An initial complete-suite invocation used the Node 24 installation's `npm` executable while the shell resolved its `env node` shebang to Node 22.17.0. That invalid run was stopped. The final reported suite was rerun with the process path pinned to Node 24.18.0/npm 11.16.0 and passed completely.
