# Earlier Matter files

Recorded September 9, 2026. This continues the owner's instruction to finish the full attorney experience for final review. The complete sequence remains in [FINAL_REVIEW_PREPARATION.md](FINAL_REVIEW_PREPARATION.md).

## Implemented behavior

The Files tab has an Earlier Matter files section for attachments stored under earlier formats, older contents outside the current document listing, and history retained after a document was removed. Opening the section reads 50 records at a time. Exact `earlierFileId` links can select a record beyond the first page; the count includes that extra visible record. A missing selection has an explicit unavailable result. The section does not request storage until a file is selected for download.

Retained history identifies the document to which the contents were linked. It does not invent an original filename, version number, size or date. Unsafe or incomplete storage references have explanations instead of download controls. Successful reads with no separate history are distinguished from failed reads, changed pages and the 4,000-record review limit. Closed Matters direct the attorney to the retained archive; purged records remain unavailable.

The browser checks the current account before and after byte delivery, offers cancellation, discards late responses after navigation, and clears stale selections on access loss or changed file records. Quiet Matter refresh preserves already loaded pages only while the inventory remains consistent. Download feedback directs the attorney to the browser's downloads list without claiming a successful disk save.

## Authority and compatibility

The new read service projects raw Case attachments, earlier CaseFile keys/history and retained removal history. Current document keys already available through Files and Document history are deduplicated. The removed document's last current copy is not reintroduced by its removal snapshot. Storage keys, private removal metadata and unrendered source fields are excluded from the response.

Reference IDs are stable hashes of the Matter and retained key, independent of array ordering or authentication-secret rotation. Separate HMAC revisions bind every page and download to the fresh persisted inventory. Listing rechecks account, ownership and source records; downloads use the existing scan and byte-stream pipeline, rechecking authority after security tags and the provider read. Mixed owner aliases, an altered account, an unavailable source or a stale revision cannot authorize delivery.

The new download route permits verified older keys only within this exact Matter prefix. It rejects external URLs, other Matters, path traversal, encoded separators, previews and reserved platform receipt/archive keys. Original payment, payout, paralegal and withdrawal receipt filenames remain behind their financial controls. Existing current-file and generic download validators are unchanged. The final source inspection added the actual historical `receipt-withdrawal-…pdf` pattern to this exclusion and its regression fixture.

These are read-only controls. No metadata repair, storage deletion, provider upload, lifecycle action, financial mutation or notification was added.

## Verification

Checkpoint: `backend/backups/attorney-v2-earlier-files-start/`, with 3,731 initial hashes and 12 owned paths. Each runtime candidate is isolated from concurrent unowned admin/paralegal edits and has an exact source manifest. Candidate 5 has 1,528 manifested files; the final documentation candidate is recorded alongside it.

The first backend run passed **101/101 across five suites**: earlier files, its client model, generic Matter downloads, document history and reviewed removal. The subsequent service/client run passed **24/24**, adding exact selected-reference validation. The final expanded receipt-exclusion run also passed **24/24**, recorded in `logs/backend-final-5.log`. Providers were synthetic, with temporary local Mongo data. Tests exercise actual HTTP bytes, owner and source changes during storage reads, scan denial, missing objects, retained removal history, source caps, deduplication, paging and stale revisions.

The first combined browser run passed **63/66** across earlier-file and current-file scenarios. Its three failures were the same fixture timing error in each engine: the test changed the sample revision before waiting for the first page, so both pages correctly received that new revision. The corrected test waits for the first page to be ready before changing the source. All **27 earlier-file scenarios then passed** across Chromium, Firefox and WebKit, with one worker and no retries. The 39 unchanged current-file scenarios passed in the combined run. This is separate evidence across two runs, not one clean 66-test batch.

Browser checks include the actual download stream and suggested filename, exact older links, changed pages, failed reads, unavailable keys, terminal access, account switches, cancellation/navigation, safe long labels, accessibility checks and widths of 320, 390, 768 and 1366 pixels. Chromium phone and desktop screenshots were inspected. The existing shared shell still needs the whole-experience LPC visual and persistent Matter-context pass.

Source checks resolve **456 frontend API literals against 424 mounted route patterns**. Supplemental owned-source frontend checks cover four modules, report no issues and find all new modules reachable in the 95-script entry graph. The runtime binding checker retains its pre-existing unowned `services/support/zohoMailbox.js:34` unused parameter finding. These bounded checks do not certify the full root working tree or production providers.

## Remaining work

P7 remains open for global conversation/unread integration and whole-experience, mixed-version convergence. Payment history, withdrawal decisions, account and global tools, inventory, copy/layout and the populated owner walkthrough remain in the active sequence. Live storage/CORS/versioning, deployment and V1 retirement are separate operational gates. This file does not mark the full attorney experience ready for final review.
