# Attorney document history

This slice exposes retained earlier contents and explicit revision-response links within Files. Replacement and removal controls remain open. It does not change file approval, financial eligibility, storage retention or historical records.

## Source and behavior

The source is `CaseFile.history` and the recorded `revisionOfFileId`/`revisionOfVersion`/`revisionRequestAt` fields. Existing history entries commonly retain only a storage key and replacement date. The interface does not invent their original filename, size, MIME or version number from today's document. Separate paged lists show earlier contents and documents submitted in response. Responses retain their own review status, with links to the exact document. An approved response does not rewrite the earlier document's approval record.

GET `/api/cases/:caseId/files/:fileId/history` returns 25 history entries and up to 25 responses per page, with independent continuation controls. Account, Matter, current file/history and response reads are verified before returning metadata. The file review fingerprint now includes history, so earlier content changes invalidate stale selections. The API reveals no storage keys.

GET `/api/cases/:caseId/files/:fileId/history/:index/download` binds the exact retained entry with a fingerprint. It uses the existing individual-file access policy, checks the earlier object's current malware tags, and rechecks owner/Matter/history before and after storage retrieval. Earlier contents are delivered only as an attachment; unrecorded MIME is not given an inline preview. Scanning a historical object does not overwrite the current file's security result. Download audit metadata identifies the historical index.

The lazy history component has no listener stream or polling loop of its own. Selection changes and route disposal abort its requests and release local object URLs. Failed/conflicted history reads remain errors; access denial clears the loaded Files list and details. The existing seven-tab workspace retains stream ownership.

## Local verification

Checkpoint: `backend/backups/attorney-v2-phase7-document-history-start/`, with 2,262 initial source hashes and 12 owned paths. Candidates derive from the verified upload candidate and exclude unrelated working-tree changes.

- Candidate 1: **79/80** backend/client/consumer checks passed. The sole failure was a new assertion expecting 403 for a nonowner; the existing Matter access middleware deliberately returns 404. The corrected assertion preserves exact 404/nonowner and 403/paralegal behavior.
- Candidate 2: **50/50** history/client/download checks passed, including history paging, response links, old-object scanning, changed historical references during storage, owner revocation, closed/purged Matter denial, foreign keys and inline-preview rejection.
- Candidate 3 adds the final Matter recheck after the response join. Its expanded history suite passed **16/16**, including ownership changing during that join. API contract checks resolve **438 frontend literals against 409 mounted patterns**. Runtime bindings retain the unrelated Zoho unused-parameter finding. Final supplemental owned frontend checks pass for all three reachable frontend sources, with no findings and an 82-module entry graph.

Candidate 3 passed **57/57 browser scenarios** across Chromium, Firefox and WebKit: 18 history scenarios plus the 39 existing document-review checks. This includes earlier-content paging/downloads, response status and exact links, conflict states, discarded late responses, clearing Files on denied history access, and automated layout/accessibility checks at 320/390/768/1366 widths. Populated Chromium screenshots at 320px and 1366px were visually inspected. All manifested upload/history candidate sources remain unchanged; bounded patch and final hashes are retained in the checkpoint. This read-only history slice is locally verified. Full attorney review preparation, final LPC wording/layout, product-wide release gates and operational storage reconciliation remain open.
