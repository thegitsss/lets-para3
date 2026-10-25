# Attorney document replacement

This slice adds reviewed replacement to the existing Files detail. The attorney reviews the current filename and version, the selected replacement, and the effects on prior contents, approval, revision instructions and security checks. The selected file and exact request ID remain private to the current tab until the operation is confirmed or discarded.

## Source and behavior

GET `/api/uploads/case/:caseId/replacement-review/:fileId` and POST `/api/uploads/case/:caseId/reviewed-replacement/:fileId` use the existing active, funded, assigned Matter and fresh account authority. Both the displayed Matter revision and current file revision bind the confirmation. The existing `MatterFileUpload` request evidence now distinguishes ordinary uploads from replacements; each storage attempt has its own object key. A lost response is checked by request ID. A retry requires an explicit action and retains the original bytes and target. There is no automatic storage or transaction retry.

The transaction preserves the CaseFile ID, original creation date, upload request ID, prior history, revision-response lineage and unknown metadata. It retains the previous encrypted storage reference in history, then applies the existing replacement semantics: attorney uploader, attorney_revision status, filename-based version, cleared approval/instructions and a new security check. Stale preview metadata is cleared; its private reference is retained with the operation for later storage reconciliation. Existing encryption helpers remain authoritative. Legacy string CaseFile references are read and preserved without normalization.

Case and file guards serialize concurrent replacements and lifecycle changes. A possibly committed transaction is never compensated by deleting its bytes. A recorded request remains recorded after a later replacement or deletion; it cannot recreate a removed file. Recovery explicitly distinguishes a recorded earlier operation from the document's newer current contents. The existing replacement audit and participant refresh events remain in use.

## Local evidence

Checkpoint: `backend/backups/attorney-v2-phase7-document-replacement-start/`, with 2,275 initial hashes and 16 owned paths. Private candidates derive from the accepted history candidate and exclude unrelated working-tree changes.

- Candidate 1 passed **78/78** checks across replacement, upload, client models, document history, existing uploads/downloads and paralegal file contracts.
- Candidate 2 passed **15/15** replacement checks after adding string-reference preservation and recovery.
- Candidate 3 passed **15/16** expanded replacement checks. Its new competing-replacement test correctly observed one successful save and one conflict, but asserted the stored encrypted filename as plaintext. Candidate 4 corrects only that assertion through the existing decryption helper and passes **16/16**.
- API checks resolve **441 frontend literals against 411 mounted patterns**. Supplemental owned frontend checks report no findings across five owned frontend sources and an 82-module entry graph. The runtime checker still reports the unrelated Zoho unused parameter.

Candidate 4 passed **72/72 browser scenarios** across Chromium, Firefox and WebKit: 27 replacement, 27 ordinary upload and 18 document-history checks. This includes native same-origin multipart byte delivery, lost-response recovery without resending, explicit same-request retry, stale target review, tab-private selection retention, account restriction, accessible narrow-width confirmation and leaving an active transfer. All four manifested candidate sources remain unchanged. Populated Chromium replacement confirmations at 320px and 1366px have been visually inspected. The final LPC typography/color/context pass remains open.

Document removal, unsuccessful-attempt and retired-preview storage cleanup, and mixed-version recovery of a paralegal upload after its uploader field changes remain separate open work. This slice does not settle retention policy, certify production storage operations, or make the complete attorney experience ready for owner review.
