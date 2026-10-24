# Displayed document review across attorney screens

September 9, 2026. Local evidence: `backend/backups/attorney-v2-displayed-documents-start/`. This is another part of the active full owner-review preparation.

## Result

The current attorney Matter screen now uses the same reviewed-document POST as Attorney V2. The earlier list supplies an account-bound revision calculated from the persisted raw file and Matter fields before derived response history is added. Approving, reopening and requesting revisions send the revision actually displayed. Renaming replacement contents cannot bypass the check by resetting a filename-based version number to one. Raw older records without Mongoose defaults produce the same revision as the V2 read.

The returned record must identify the selected document, requested status and new review revision. Account changes, conflicts, malformed responses and lost acknowledgements leave the old controls disabled and offer a Files refresh. Feedback sits beside the document. A read can show the currently saved approval without resending it or claiming an exact-request receipt. The automatic draft attachment after a revision request downloads only that confirmed document revision; it does not fall back to an unbound key. No real messages were sent during verification.

Shared review eligibility and revision guards now include completion and hiring claim tokens as well as their status fields. The current screen's refresh comparison includes the full file presentation, so changes to contents, instructions, review or permissions are no longer missed when count, latest ID and creation time stay unchanged.

No current frontend callers of the older revision-request, by-key replacement or delete APIs were found. Those compatibility APIs retain their earlier Case-fenced contract; an already-cached old client does not acquire displayed-revision protection until its assets refresh. This is an explicit deployment/mixed-version acceptance consideration, not proof that an old client reviewed current bytes. V2 replacement and removal already have their separate reviewed confirmations.

## Verification and exact limits

- Candidate 1, four backend suites: **86/87 passed** (`attorneyMatterFiles`, `matterFileWrites`, `uploadsDownloads`, `attorneyMatterFileHistory`). The sole historical restriction assertion received a 404 denial instead of the expected 403. The same unchanged restriction group subsequently passed 4/4, and the entire unchanged history suite passed 16/16. No assertion was weakened. The original differing denial remains in the evidence; it did not return file bytes.
- Added backend checks cover matching V1/V2 revisions and fresh account checks, raw missing defaults, renamed contents with version still one, and token-only claims. Existing unknown-field, scanner, replacement, transaction and historical-byte checks remain included.
- Browser candidate 1 was stopped after two fixture failures: the synthetic Matter omitted the server-supplied section list, so the actual screen correctly exposed only Overview. Candidate 2 corrected that fixture and passed **15/15** across Chromium, Firefox and WebKit.
- Final-control candidate 5 passed **15/18**: the three added stream-interruption cases lacked a synthetic correspondence response; the fallback read received a real missing-Matter denial and correctly cleared Files. Candidate 6 completes that response and passes all **3/3** focused cases. This exercises real browser stream closure and refresh/poll fallback, not multi-instance production realtime.
- Candidate 6 runtime: `/private/tmp/lpc-attorney-review-20260909-displayed-6`, 1,521 manifest-verified files. Final source changes after the candidate 5 browser run are whitespace only; candidate 6 also corrects the test fixture. The final documentation-only candidate retains the full chain.
- API check: 454 literals resolve against 422 patterns. Supplemental owned frontend checks: one changed source, no issues, 93 reachable modules. Runtime checker retains only the earlier unowned Zoho parameter finding. Phone screenshots were inspected; the new Refresh Files control uses the existing readable document-button treatment.

The earlier presigned-upload checkpoint recorded 126 concurrent unowned changes, mainly paralegal source/tests and design evidence plus notification code. They were excluded from the private attorney candidate and preserved in the root workspace. This checkpoint also retains its own before/after manifest and source-integrity report.

Full earlier-file access, global conversations/unread, financial/account/global workflows, LPC editorial/layout acceptance and the populated owner walkthrough remain open. No rollout, deployment, migration, production provider operations or V1 retirement occurred.
