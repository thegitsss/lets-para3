# Shared Matter Work — local implementation

September 7, 2026. Checkpoint: `backend/backups/attorney-v2-phase7-shared-work-start/`, with 2,140 initial hashes and 18 bounded owned paths. This completes the authorized Case scope review controls under P7-05; private checklists and standalone paralegal Task records retain their distinct contracts.

## Behavior and authority

The Work tab reads the actual Case scope, including earlier string entries and completion aliases. Attorneys can mark the selected item complete or reopen it when the existing funded, assigned, active-work policy permits. Scope creation/editing uses the rebuilt posting editor before hire. Completed work remains locked after withdrawal and replacement hire. Closed, archived, read-only, unfunded and pending-decision Matters offer no work changes. Duplicate titles are addressed by position and a fingerprint of the displayed scope and Matter authority; the interface never invents missing task IDs.

The strict `GET/POST /api/cases/:caseId/work-review` checks the fresh approved attorney, token/session, raw ownership, assignment, funding and lifecycle. The write matches the raw Case snapshot, changes only the selected task, and increments retained task and Case revisions. Unknown task metadata remains intact. The current dashboard sends its displayed task revision; its existing task-list write now preserves raw metadata and rejects intervening assignment, scope or lifecycle changes. Earlier mixed string/alias scopes are serialized from raw records for authorized participants rather than appearing empty through hydration. Nonparticipant/admin presentation keeps its existing source.

No work review releases money. Existing financial completion eligibility and all task-model distinctions remain authoritative. Fresh account reads and a Case compare-and-set are not a cross-collection account transaction.

The screen retains keyboard focus, preserves uncertain review state in account-scoped tab memory, and offers a fresh saved-status check after conflicts or lost responses. It never automatically repeats a work decision or claims that a fresh matching value proves which request saved it. Background reads cannot overwrite a newer user decision. Route/access cleanup uses the common workspace stream and abort ownership.

## Verification and retained failures

Runtime candidate: `/private/tmp/lpc-attorney-review-20260907-shared-work-7`; hashes are recorded in `isolated-candidate-7.json`. Candidate 7 changes only the conversation account-switch test from candidate 6, using a real sibling-tab storage event. Candidate 8 adds the access-loss fixture initialization correction described below; application runtime is identical.

- Initial backend run: 54/57; corrected a hidden-record status expectation and added required practice-area/state fields to withdrawal fixtures. Candidate 2 passed 57/57 affected checks.
- Candidate 3 passed 29/29 focused checks. A separate characterization then demonstrated an actual earlier-format scope read failure. The raw participant read/round-trip correction passed 45/45 across Work, model, boundary, Matter presentation and permissions suites on candidate 5.
- Candidate 7's broader final backend run passed 79/80 across eight suites. The single application rejection failure reported MongoDB `LockTimeout` at the unchanged application-decision review. The unchanged repeat passed 9/10 with the same lock timeout. The test fixture awaited only the decision index while other collections read by its first transaction were still initializing. Candidate 8 waits for those six required models before requests; that suite passed 10/10. Runtime code and assertions are unchanged. The broader run is not described as uninterrupted green.
- Candidate 6 browser run passed 92/93 across Chromium, Firefox and WebKit: all 30 Work scenarios and all 24 workspace scenarios passed. The remaining conversation account-switch check lost its automation execution context during the protective redirect. Candidate 7 delivers the event from a real sibling tab and passed that exact case 3/3. No confidential-data or redirect assertion was removed.
- Browser coverage includes duplicate titles, completion/reopen, withdrawal locks, conflict/lost-response recovery, read-only and pending decisions, failed reads, access loss, late background reads, keyboard focus, unknown task links, 320/390/768/1366 widths and automated accessibility. Chromium Work screenshots at 320 and 1366 were visually inspected. Full shell typography/palette and complete owner visual acceptance remain open.

API-contract verification covers 430 literal endpoints and 403 route patterns. The normal Git-dependent frontend hygiene check could not execute after the local Command Line Tools installation became unavailable during this slice. Earlier 19 admin/paralegal findings are historical evidence, not a current pass. No developer-tool installation or global configuration change was made. Final repository hygiene and product-wide checks remain required.

Logs, browser traces/screenshots, original and final source archives, owned hashes, unowned-file integrity report and bounded patch are retained in the checkpoint. The source freeze identifies exact local evidence; it does not authorize production release or retire V1.
