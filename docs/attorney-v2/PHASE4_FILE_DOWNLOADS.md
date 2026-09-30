# Attorney V2 — individual Matter file downloads

September 6, 2026. This continuation implements the individual file-download portion of P4-03 in both attorney dashboards. Receipts, archive exports and dependent lifecycle workflows remain open. The checklist stays at 22 of 99 checked items. The release identifier is `attorney-v2-file-downloads-20260906`; the remote cohort remains disabled and empty.

## Current and V2 behavior

The current dashboard's Download Files action opens a fresh file list in its existing modal. V2 Matter actions open Files for download at `#/matters/:caseId/files`. Both surfaces use the same controller. The action is available for every non-draft Matter instead of depending on cached attachment counts. Opening it does not start a download.

The previous current-dashboard action selected only the first cached `downloadUrl` or first cached attachment key. The replacement lets the attorney select an exact file from canonical CaseFile records. Lists load 50 records at a time using a keyset cursor, offer explicit refresh, name partial paging failures, and retain the earlier pages after a failed Load more request. A failed fresh read clears prior private names rather than presenting stale content as a successful empty result. Missing size, version and upload date remain explicitly unavailable.

Every selected file is checked again before bytes are requested. A pending, blocked or failed scan does not produce a browser download. Changed or missing files require a fresh list before another attempt. Only one transfer runs at a time; cancellation, navigation, closing the current dialog, account changes and access loss suppress late private data. No failed transfer automatically retries. Private file names, bytes and list state are not persisted to browser storage.

The client verifies the signed-in attorney before each list request, before a selected-file transfer and after the binary body finishes. API generation changes invalidate the whole operation, including the gap before the final identity check. Only a successful `application/octet-stream` response can become a Blob download. The chosen filename is sanitized and the temporary object URL is revoked. Successful feedback says the file was handed to the browser and directs the user to its downloads list; it does not claim that a file was saved to disk.

## Backend authority and preservation

GET `/api/cases/:caseId/downloads` and GET `/api/cases/:caseId/downloads/:fileId` run behind the existing verified-session, approved-account, role and Case-access middleware. These new endpoints further require the current Matter attorney and an exact expected actor. Admin archive access and paralegal file access remain in their existing endpoints.

The service reads raw Case and CaseFile records with support for historical text owner/Case references as well as ObjectIds. Contradictory owner aliases are rejected. List responses expose only the Matter title, access state and necessary file metadata; they omit storage keys, uploader identities and private revision notes. A list read does not update the database, contact storage, scan or sign URLs. Ownership and lifecycle are reread after querying the files so a concurrent transfer or closure cannot return the earlier private list.

Individual download eligibility preserves the current attorney signed-file authority: payment release and completed, closed or disputed status prevent individual downloads. Manual archive, paused status and read-only presentation alone do not close this authority. Purged and unsupported states are unavailable. This differs from the assigned/funded workspace guard on the upload API; the new owner-only endpoint does not change that guard or grant its capabilities to another role.

The selected-file request contains an exact file ID and a SHA-256 revision of its recorded identity, name, storage key, MIME type, size and version. Scan timestamps/status are excluded so a fresh scan does not itself invalidate the review. The server requires a document key under the same Matter, refreshes the existing malware-scan authority, and rereads ownership, lifecycle and revision both after scanning and after object storage responds. A changed, deleted, transferred or newly closed record blocks delivery and destroys an already acquired stream.

Binary responses use private/no-store caching, attachment disposition and nosniff. Content length comes from the actual storage response rather than potentially stale recorded metadata. Canceled/closed responses destroy the upstream stream; stream errors fail the request. A successful source-stream completion requests the existing file-download audit entry as a best-effort effect, not proof that the user saved the file. Aside from existing scan metadata and the audit effect, downloads do not mutate the Case, financial state, files, versions or unknown fields.

These are repeated database and scan checks, not an atomic transaction with external storage. Revocation after delivery begins cannot recall bytes already sent. The browser buffers an individual file as a Blob, consistent with the existing paralegal downloader; large archive streaming remains separate work.

## Legacy disposition and remaining download work

Legacy `Case.files` entries without matching CaseFile records are not rewritten, fabricated or deleted. The list identifies that older attachments may require the archive. Historical `Case.downloadUrl` values also remain unchanged. The source census found no active producer beyond clearing that array in completion/purge, and a synthetic legacy archive URL in test fixtures. The new action does not follow arbitrary cached URLs or silently substitute the first legacy entry for the user's chosen file. Archive compatibility remains an explicit acceptance dependency.

The following findings are recorded for the next bounded continuation; their implementations are unchanged in this slice:

- **Attorney receipts:** `backend/routes/payments.js` currently permits the owning attorney's receipt route without a funding-eligibility gate, while `buildAttorneyReceiptPayload` labels its output Total paid and Paid in full. Characterize funded, unfunded, failed, refunded, partial and historical records before accepting this entry point. Existing funded-receipt tests include historical fee snapshots that must remain accurate.
- **Archive retention and contents:** the archive-download projection in `backend/routes/cases.js` omits `purgedAt` even though readiness checks use it; it also omits `purgeScheduledFor` and `preEngagement`, while the generator includes pre-engagement documents. Verify retention boundaries and exact archive contents before accepting exports.
- **Concurrent archive generation:** on-demand exports use a shared `archive-v2.zip` key and delete the generated object after streaming. Concurrent generation, stream completion and deletion need explicit characterization and a safe implementation.

Individual downloads do not complete the read-only workspace, file upload/preview/review/replacement, financial receipt, completion, purge or archive-export features in Phases 6–8. P4-03 remains unchecked.

## Verification and checkpoint

The checkpoint is `backend/backups/attorney-v2-phase4-downloads-start/`: 1,443 pre-existing file hashes, exact baselines for 48 selected files, and 19 owned source/document paths including seven new files. Before browser testing, no pre-existing file outside those owned paths had changed. All 685 application files in the source snapshot are frozen during each browser run.

The final targeted backend/model run passed **113/113 across eight suites**. Coverage includes owner/role restrictions, legacy references and absent metadata, projection privacy and no-write reads, 55-record paging, exact binary bytes/headers, file revisions, storage/scan failures, malformed keys, ownership/completion/replacement/deletion races, destroyed streams and API cancellation/account-generation boundaries. Existing upload/download, archive, private/read-model and read-source tests pass in the same run. An initial fixture omitted its Stripe constructor stub; the fixed fixture uses an empty provider mock and the final run is clean.

The first combined browser run passed **101/105** across Chromium, Firefox and WebKit. All 39 notes scenarios, 32 of 33 archive scenarios and 30 of 33 file-download scenarios passed. The three download failures came from one overly broad test assertion: it rejected the words handed to your browser even in the failure message Nothing was handed to your browser. The test now rejects the complete affirmative success sentence while retaining its error-state, zero-download-event and exact-request-count checks. No application source changed for this correction.

The remaining failure was the existing WebKit admin archive scenario reaching the aggregate 45-second test limit after cancellation and the first confirmed archive, while starting its second archive sequence. Its trace shows the overall sequence timing out rather than a failed product assertion. The focused recheck used a 90-second overall allowance and retained all individual expectations. The other two browsers passed this scenario in the first run.

The final focused browser recheck passed **6/6**, covering the download-error and admin archive scenarios in all three browsers. WebKit's admin sequence completed in 35.2 seconds. All **105 distinct browser scenarios now have passing latest results** across these sequential runs; this is not a claim of one clean 105-test batch. All application source remained unchanged between runs and frozen throughout them. The sole browser-test edit tightened the download feedback assertion.

The Chromium mobile and desktop file screenshots were visually inspected. Long names wrap within the viewport, and the last current-dialog download control scrolls above the visible Close footer. All three browsers passed those geometry checks, automated WCAG accessibility checks, keyboard refresh and Escape. Syntax, runtime/frontend bindings, frontend hygiene, API-contract, route-security and performance checks pass; the final API generation change also passed a focused syntax/binding recheck.

The browser harness uses synthetic accounts and an ephemeral local Mongo database. Empty file lists exercise the actual new API. Nonempty file metadata and binary successes/errors are browser-route fixtures; backend tests separately exercise the real route with mocked object storage. No real S3 objects, payments, email, production records or production accounts are used.

No pre-existing file outside the 19 owned paths changed. Additional admin-audit scripts and evidence appeared concurrently under `docs/audits/admin-2026-09-06/`; their observed paths/hashes are recorded in the integrity report, and they remain untouched and excluded from this continuation's source patch/archive. The checkpoint includes exact baselines, source hashes, a bounded source patch and archive, initial and final test logs, preserved browser artifacts, screenshots and `acceptance.json`. Individual file downloads are accepted locally within this scope.

No deployment, commit, migration or cohort activation is part of this continuation. Full repository regression, owner visual acceptance, production release and retirement remain open.
