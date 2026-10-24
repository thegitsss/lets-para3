# Résumés recorded with applications

September 7, 2026. This follows [application reading](PHASE5_APPLICATION_REVIEW.md) and remains a bounded part of P5-01/P5-02. Release `attorney-v2-application-resumes-20260907` is disabled with an empty remote cohort. Application decisions and hiring remain open.

## Behavior and wording

Both dashboards use the same application résumé component. An application with a recorded résumé has **Check recorded résumé**, followed by **Download recorded résumé** after a successful check. Opening the application list does not request document storage for every applicant. The component names absent references, removed objects, unsupported references, unfinished or failed security checks, blocked files, oversized files and changes during review. A failed check never becomes an empty document list or a successful download.

The control opens the file reference stored on the Application, or the earlier Case applicant entry when no separate Application exists. It never replaces that reference with `User.resumeURL`. When the Application and Matter entry disagree, the application reader's existing warning remains visible and the canonical Application reference takes precedence. The client also verifies that the document review belongs to the exact application being displayed.

This is access to the **file recorded with an application**, not certification that the bytes are unchanged since submission. Applications currently store a reference without a submission-time object version or content digest. Upload keys are normally unique, but that does not establish historical immutability. Replacing a personal résumé can queue its older object for deletion; an application may therefore retain a reference to a file that no longer exists. This slice preserves that deletion policy and reports missing files honestly. Durable application-document retention and immutable submission snapshots require separate product and lifecycle work.

A recorded LinkedIn reference is still identified as an inclusion; this slice does not open that saved external reference. Certificates and writing samples are not captured as application document snapshots. The current-profile link remains distinct, subject to existing profile visibility and block rules.

## Authority and transfer

Two read-only routes are added:

- `GET /api/cases/:caseId/application-review/:applicantId/resume?expectedOwnerId=…`
- `GET /api/cases/:caseId/application-review/:applicantId/resume/download?expectedOwnerId=…&revision=…`

They reuse the application reader's current attorney/admin ownership, approved account, JWT `av`, tracked session, linked Job, duplicate-record and legacy-alias checks. No request-provided URL or object key is accepted. Only a locally parsed, configured storage reference under the applicant's résumé prefix is eligible. No arbitrary URL is fetched and no signed storage URL or raw object key is returned.

Historical rejected, withdrawn and archived applications retain document access under their Matter's ownership. A blocked interaction or unavailable current profile does not erase that existing application evidence. This follows the existing personal-document relationship authority; it does not grant current-profile access or permit a new interaction. Neither reads nor downloads mark an application viewed, change decisions, repair mirrors, send notifications or alter stored documents.

Review fingerprints bind the application source and current object metadata. Downloads require the reviewed fingerprint and use the object's ETag as an S3 `IfMatch` condition, with its version when available. Metadata, security results and application/account authority are checked again before bytes are sent. A 30-second operation deadline, 10 MB bound, exact content-length checks, PDF MIME/signature checks and stream cancellation prevent incomplete or invalid responses from being offered as a résumé. Malware checks follow the existing `S3_MALWARE_SCAN_REQUIRED` configuration; a disabled scanner is not described as a clean scan.

Responses use `private, no-store`; downloads are PDF attachments with `nosniff`. The browser verifies the account before and after each response, rejects a foreign or malformed review, checks the PDF response and its reviewed size, and retains no résumé content or metadata in browser storage. Cancel, application refresh/pagination, navigation, dialog close and account loss abort the active request. Object URLs are revoked after handoff or cancellation. The confirmation says the résumé was handed to the browser and asks the attorney to check its downloads list; it does not claim a file was saved to disk. There are no automatic retries.

## Verification and remaining gates

Checkpoint: `backend/backups/attorney-v2-phase5-application-resumes-start/`, with 1,693 initial file hashes and exact baselines for six existing owned files. This slice owns 13 paths, including seven new files. Concurrent admin and paralegal work is preserved.

The focused backend/model suite passed **92/92 across four suites**. It covers exact recorded bytes despite a newer profile résumé, canonical and earlier-only references, private projections, ownership/admin boundaries, rejected/withdrawn/archived/blocked/unavailable-profile history, malformed queries, unsafe references, missing objects, scanner states, conditional and versioned reads, metadata/byte mismatches, cancellation, renewed token versions, tracked-session logout and access loss during transfer. Existing application reader/model tests also pass.

The initial run exposed a missing local route middleware binding and a test helper returning a Buffer; both were corrected before acceptance. One later full run had a reference-validation assertion receive no expected public code after an earlier pass. The unchanged-source focused reference diagnostic passed 5/5, and the complete confirmation run passed 92/92. The original response body was not captured, so its cause is unconfirmed; the assertion now retains status/body details if it recurs. This is recorded rather than attributed to infrastructure without evidence.

There are **33 distinct browser scenarios with passing latest results** across Chromium, Firefox and WebKit: 30 résumé scenarios and three existing real application/withdrawal journeys. They cover lazy checks, absent-reference fixtures, exact downloaded bytes and filename, explicit failures without retries, malformed or mismatched responses, delayed review/transfer cancellation, application refresh, leaving the page, dialog close, account changes, keyboard use, AA accessibility and 320px/1366px layouts. Four Chromium screenshots covering both dashboards at both widths were visually inspected. The final wording directs a changed or mismatched review back to an application refresh; the existing five model checks passed again after this small copy correction.

The first browser run passed 24/27 in 2.9 minutes. Its three failures came from an incorrect fixture assumption: the synthetic paralegal already has a résumé reference. The follow-up passed 7/9 in 1.8 minutes, including all delayed-check cancellation and real application/withdrawal journeys. Chromium and Firefox retained the already-open page when the test navigated to the same address, so its changed fixture had not been read; the test now explicitly refreshes applications. The final acceptance run passed 9/9 in 1.5 minutes, covering the corrected scenario, exact downloads, missing/security/changed outcomes and malformed responses in all three engines. No assertion was removed, no automatic retry was enabled, and application source remained fixed during each run. Tests use a documented 90-second maximum for multi-step browser journeys.

The browser suite uses real synthetic Matters and applications and reads their recorded-reference flags from the actual application endpoint. Absent-reference variations, document-review metadata and PDF transfer bytes are explicitly intercepted fixtures because the browser harness has no live document bucket. The backend suite independently exercises the actual route/service authority against mocked S3 metadata, object bodies and scan tags. Neither suite certifies production storage configuration or deletion-worker behavior.

Syntax, runtime/frontend bindings, API contract and route-security checks pass. Global frontend hygiene still reports 17 unowned admin/paralegal-preview findings; the global performance check reports the unowned paralegal preview entry without Core Web Vitals measurement. Full repository acceptance remains open.

The checkpoint retains original and final source archives, the bounded patch, exact hashes, logs, synthetic browser artifacts, visual review and per-run source integrity. All 681 files frozen for the final acceptance run remained unchanged. The upload route, personal storage deletion service, Application/User models and existing file-reference/security helpers still match their initial hashes. The checklist remains at 22 of 99 checked items.

P5-01/P5-02 and all release/retirement gates remain open. Next work includes reviewed star/shortlist/reject decisions, stale eligibility and assignment races, recorded external references, intentional viewed effects, application counts/reconciliation, pre-engagement and cross-role hiring/funding acceptance. No deployment, commit or cohort activation is included.
