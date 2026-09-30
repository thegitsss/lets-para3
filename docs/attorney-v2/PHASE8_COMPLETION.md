# Reviewed Matter completion

September 8, 2026. Local completion controls are implemented in Financials. P8-05 remains open for the earlier file writers and whole-experience financial convergence described below.

The attorney reviews the actual Matter, assignment, agreed/remaining cents, paralegal fee and payment, completed work count, document-review counts and six-month archive retention before confirming. Document approval is not a new completion prerequisite: the existing work policy remains authoritative, while actual document status is visible and archive security checks still apply. Existing paid evidence offers finishing the Matter without a new transfer. Unresolved, reversed, failed or pending payment attempts cannot offer another money action in V2.

`GET /api/cases/:caseId/completion-review` reads fresh account/ownership, Case/work/document revisions, payout/operation evidence, the assigned paralegal and administrative payment holds. Counts cover all recorded documents through a bounded-time cursor, without exposing storage keys. Normal unassigned postings are not mislabeled as payout disagreements. Stale claims require review rather than claiming to be processing indefinitely.

The existing completion route accepts an optional strict V2 contract: expected owner, UUID and the exact reviewed Matter/recipient/mode/cents/currency. Its claim and started-action audit record commit together. The final Case closure, paid-payout/operation guards and exact completion audit record commit in another transaction. There is no standalone fallback or automatic money resubmission. Same-request recovery returns the recorded outcome; altered confirmations cannot reuse it. Unrendered Case/task fields and earlier raw reference formats are preserved.

Before transfer, the server rechecks account, assignment, Matter and documents. After transfer, negative payment projections or account revocation retain reconciliation evidence without fabricating a paid completion. A matching positive transfer-created projection may arrive before the transfer response; its recorded payment timestamp is preserved. The final transaction cannot overwrite a competing payout reversal. A lost final transaction acknowledgement is recovered through the exact committed audit record. Earlier V1 completion remains callable; the strict transaction is used by the new V2 controls.

The page retains a pending request in tab memory across Matter tabs, clears it at the account boundary, and checks its outcome through reads. Stopping the wait explicitly does not cancel an in-flight payment. It has no automatic retry. Review/cancel choices, refreshed amounts, archive links, errors and retained outcomes are covered in browser checks.

## Evidence

Checkpoint: `backend/backups/attorney-v2-phase8-completion-start/`, 2,713 initial file hashes, 13 owned paths. Final runtime candidate 10 has 1,494 verified source files; candidate 11 adds the final documentation only.

- Candidate 1: **87/88** backend/consumer checks; a test reused one storage key for three different documents and correctly hit the retained unique storage-key index. The fixture now creates distinct keys; that index is present in the private manifested source.
- Candidate 2: **68/68** completion/client/work/document checks.
- Candidate 3 browser run: **48/51**. All 24 Matter-workspace scenarios passed. The three completion failures were the same plain test assertion reading `state.writes[0]` before the asynchronous guarded write arrived. The test now waits for the visible recorded result.
- Candidate 5: **97/97** completion/payout evidence/existing payout/client checks; **27/27** completion browser scenarios across Chromium, Firefox and WebKit.
- Final candidate 10: **45/45** completion/client checks, including matching/negative payment projections, account revocation after transfer, unknown claim/final commit acknowledgements, concurrent final reversal, stranded claims, unexplained earlier attempts, existing work/dispute/completion blockers and a withdrawal that began before later work approval and completion.
- Earlier interlock test failures are retained: changing the agreed task title is forbidden (403), and withdrawal after all work is complete is rejected by the existing rule (400). The tests now exercise completion-only edits and the actual in-flight withdrawal boundary. The first failure also let a pending mocked archive request outlive test teardown; the fixture now always awaits it in `finally`.
- API contract: **450** frontend literals / **418** mounted patterns. Supplemental owned-source checks: 5 frontend modules, zero issues, all 89 entry-reachable modules accounted for. Runtime bindings still report only the unowned `services/support/zohoMailbox.js:34` parameter.
- Automated layout/accessibility checks cover 320, 390, 768 and 1,366 pixels; Chromium phone and desktop screenshots were inspected. The existing white/blue styling and missing sticky Matter context remain for the coordinated LPC editorial/design pass.

All provider, storage, email and transfer activity was synthetic or mocked. Browser confirmation requests use controlled fixtures; backend checks exercise the actual handlers and transactions. No production money, database, storage, cohort, V1 retirement, deployment or public preview was involved.

## Remaining shared dependencies

The earlier file create/attach/status/replacement/deletion writers still need the same Case transaction interlock as V2 file writes. Final file-digest checks detect observed changes, but do not serialize a legacy file insertion with completion or make physical deletion safe. Document-removal storage cleanup and original-upload identity after replacement remain open. Do not close P8-05 or call the full attorney experience ready while these dependencies remain.

P8-09 still includes the shared transfer webhook's broad pending-operation update, earlier V1 final-save behavior, complete payment/ledger/receipt reconciliation and all financial histories. The conservative V2 gate treats an earlier failed attempt without authoritative provider evidence as requiring administrator review. It does not infer a safely retryable payment from a stored error message.
