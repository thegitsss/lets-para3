# Attorney V2 — Matter notes and status history

September 5, 2026. This continuation implements the notes and status-history portion of P4-03. P4-03 remains unchecked: saved-view create/delete/restore and the remaining management/flag actions still need implementation and acceptance. This is a local continuation, not completion of Phase 4 or the attorney rebuild.

## Available behavior

Posted-Matter previews link to `#/matters/:caseId/manage`. That page reads the selected Matter's existing status history and provides a notes editor. The current attorney dashboard's Matter menu exposes the same editor. Both show the Matter title, saved timestamp, character count, explicit save, and a saved-version check. Emptying an existing note requires confirmation. Paragraphs, indentation and trailing spacing survive saves. Historical notes longer than 10,000 characters stay readable and are never silently truncated; editing down to the existing limit is required to save.

Notes are visible to the owning attorney and platform admins under the existing permissions. They are private from paralegals, rather than personal notes hidden from admins: the existing record also holds admin feedback. Shared case summaries previously serialized internal notes for paralegal viewers; they now omit the entire internalNotes field for those viewers. Authorized note and history endpoints reject other attorneys and paralegals, including assigned participants.

The history page uses recorded status events and existing Matter date fallbacks. It does not claim to be the full activity log. Audit-source failures now return `complete: false`, and both dashboards identify the displayed events as incomplete. Notes and history have independent read/error boundaries.

## Concurrency and recovery

GET `/api/cases/:caseId/notes` returns the case ID/title, note, opaque revision and saved time with no-store caching. PUT requires the reviewed revision and expected signed-in account. Writes compare the raw note snapshot and ownership atomically, preserving unknown note metadata and unrelated Case fields. Legacy clients without account/revision fields fail closed and must refresh. The shared browser writer verifies `/api/auth/me` and obtains CSRF before sending a single save.

A failed initial read cannot enable an empty overwrite. Conflicts retain the draft and display the saved note for comparison. Keeping edits for review requires a separate save; using the saved note explicitly discards the draft. A failed or lost save response requires a read before an explicit retry, and never causes an automatic mutation retry. Recovery preserves typing made after submission, including deliberately undoing back to the original text while the save is in flight. Read results for a different Matter or malformed revisions cannot replace a draft.

Unsaved notes and uncertain submissions live only in page memory, keyed by Matter. They survive navigation within V2 and closing/reopening the current-dashboard modal. They never enter URLs or browser storage. Unverified sessions/account changes clear private state. Per-Matter access loss removes that Matter's note and blocks further writes. Full-page unload warns while unsaved work exists; closing the tab discards unsaved memory.

The three existing moderation writers append against the latest note with atomic snapshot checks. A concurrent attorney save is retained with the appended feedback; a changed moderation record produces a conflict. Unknown note metadata remains intact. An append that would exceed the note limit fails without changing moderation status or truncating old text. Requested-edits notifications happen only after persistence succeeds. These are bounded backend dependencies of preserving notes, not a new V2 flag-resolution interface.

Private note saves now update only the note's timestamp. They do not advance Case.updatedAt or falsely satisfy the existing requirement to edit a flagged public posting before requesting admin review. The broader historical use of Case.updatedAt for moderation eligibility remains for the later flag-management work.

## Verification and checkpoint

Verification is recorded in `backend/backups/attorney-v2-phase4-management-start/`. The checkpoint contains hashes for 1,383 pre-existing files, selected baseline source archives, a bounded change patch and verification logs. The recovered entry-HTML baseline was independently checked against its pre-edit hash. Concurrent changes outside the owned paths are retained.

- Focused Jest regression: **12 suites, 111/111 tests passed**, covering all attorney V2 contracts plus Matter notes, posting transactions, draft persistence and the phase-2 lifecycle. Earlier initial note/model checks exposed only test-expectation issues, corrected before this run.
- Full Jest attempt: **incomplete**. The known historical recommendation and paralegal Browse-link assertions failed. Incident release/verification tests also exceeded their default timeouts and continued work after environment teardown. The process was stopped after more than ten minutes without a final census. Those incident checks remain unresolved; this is not a passing full regression result.
- Browser batch: **113/114 passed** across Chromium, Firefox and WebKit for notes, weekly notes and shell foundations. One Firefox current/V2 conflict test timed out waiting for the second tab's full load event; the preserved screenshot shows the workspace already rendered. The helper now waits for DOM loading followed by the actual notes-ready assertion. The final notes recheck passed **39/39** in 2.9 minutes, including the previously timed-out scenario. Across these two runs, all **114 distinct scenarios** have a latest passing result; this was not one clean 114-scenario run.
- Visual review found a duplicate heading in the current dashboard's mobile note dialog. The scoped CSS removes it; Close-button geometry and automated WCAG AA checks passed. Final current-dashboard mobile/desktop screenshots were visually reviewed.
- Frontend hygiene, binding, API-contract, performance, no-theater and syntax checks passed. The route-security inventory still has 207 mutations: 200 protected, 7 documented exemptions, 0 open.

The final source check identified concurrent changes to unrelated file/submission projections in the shared cases route. The note/history sections were unchanged. A fresh combined-backend check passed **3 suites, 23/23 tests** in 21 seconds. A separately recorded earlier concurrent change added experience fields to the recent-Matter projection. Both changes are preserved and excluded from the attorney-owned patch.

The full-run interruption and concurrent local test activity are recorded separately from the passing targeted results. No unrelated incident or paralegal implementation was changed to make this continuation pass.

## Remaining work and release conditions

P4-03 remains open for saved-view create/delete/restore, remaining action-menu/preview parity, and the attorney flag-resolution review flow. Admin request-edits and clearing flags remain admin-only operations. P2-05 large-account pagination, the later attorney phases, cross-role/manual acceptance and all production release gates remain open.

The next saved-view continuation should characterize the existing account API before enabling V2 writes. Its POST/DELETE currently save a preferences snapshot, so concurrent preference or saved-view changes can be overwritten; the attorney filter normalizer also omits archiveStatus. Preserve other scopes and unknown preferences while adding create/delete/restore and explicit handling of matching names and interrupted writes. Keep that dependency bounded and preserve the current paralegal adapter.

The remaining flag interface must distinguish requesting admin review from clearing a flag, review current server eligibility, and resolve uncertain outcomes without automatic retries. Public-posting revisions should be distinguished from unrelated historical Case.updatedAt changes before claiming that flow accepted.

Ship the server and both attorney client updates together and refresh already-open legacy note editors. No database migration or new index is required for note revisions. Historical over-limit notes and full-note moderation appends must be explicitly reviewed rather than silently shortened. The local release remains disabled for remote cohorts. No commit, deployment, production-data operation, real payment or external message was performed.
