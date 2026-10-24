# Attorney V2 — invited paralegals

September 5, 2026. This continuation implements the invited-paralegal list portion of P4-03 in both attorney dashboards. The checklist remains open for archive/restore, file and receipt download entries, and the dependent Phase 5–8 workflows. Invitation sending, withdrawal/revocation, application decisions and hiring have not been rebuilt in this continuation. The local preview remains enabled only on localhost; the remote cohort remains empty and disabled.

## Viewing invitations

V2 Matter actions now link to a dedicated invited-paralegal page, including Matters with no invitations. The current dashboard's existing invited-paralegal menu mounts the same read component in its modal. Both load a fresh, account-verified list, identify the Matter and display recorded invitation status, invitation date and response date. The view explains that accepting an invitation does not confirm a hire. V2 links to the existing applications destination for hiring, and profile navigation preserves the Matter and a return to its invitations.

The current list previously fell back to cached invitations when its detail read failed or returned an empty list. The shared component has explicit loading, empty, failed and incomplete states. A failed refresh removes old names and links. Refresh is an explicit read operation; no cached result substitutes for a failed request. Malformed account/Matter projections are rejected. Each refresh verifies the session and supplies the expected account to the endpoint.

Unavailable profiles retain their recorded response with a neutral name and no profile link or photo. Available profile links are built from validated IDs. Photos are restricted to approved same-origin paths, and failed photos use a neutral avatar. Names are rendered as text. Current dialogs cancel their requests on close, discard their contents, ignore late results and reload on reopening. Account changes and access loss clear the invitation surface; no invitation contents are written to localStorage or sessionStorage.

## Read-only backend corrections

GET `/api/cases/:caseId/invites` keeps its existing owner/admin access and invitation array response, and adds `caseId`, verified actor `ownerId`, `caseTitle` and `complete`. It returns `Cache-Control: private, no-store`. A mismatched expected account fails closed. Ownership is checked against a fresh database projection and again after the profile lookup. Other attorneys, applicants and assigned paralegals cannot read the owner's invitation list.

The endpoint uses raw records rather than calling legacy invitation seeding. Missing legacy dates stay missing instead of becoming the current date. A pending legacy invite is included once alongside recorded invites. Unknown statuses remain explicitly unavailable; malformed records yield an incomplete indication instead of a fabricated empty list. Archived and completed Matters retain readable invitation history.

The response is an explicit projection of profile identity and recorded invitation response. It excludes email, payment data, private notes, raw photo storage keys and unrelated Matter data. Deleted, disabled, missing and unapproved profiles do not expose names or active profile links. Reading the list does not save a Matter, normalize stored legacy records, send a notification or change an invitation response.

## Remaining lifecycle work

Archive/restore remains open. Inspection found that the current restore client can issue a general status PATCH before the archive PATCH, followed by a fallback write. Its server path and Case/Job discovery effects need a dedicated lifecycle review before V2 parity can be accepted. Receipt and archive downloads likewise depend on financial and archive readiness; they are not asserted complete by adding invitation navigation.

## Verification

The checkpoint is `backend/backups/attorney-v2-phase4-invitations-start/`. It records a pre-edit manifest of 1,428 files and a selected archive of 39 source files, including the affected stylesheet and existing HTML. Final source ownership is limited to 20 paths (13 existing and seven new). The bounded patch and test artifacts are recorded with the checkpoint.

Targeted backend/model regression: **53/53 across seven suites**. This covers invitation ownership and transfer during a read, privacy, legacy missing dates, no-write behavior, incomplete records, final/archive history, unavailable profiles, client projection and safe navigation, plus existing attorney foundation/read and Matter notes/moderation model checks. An initial model-test helper returned a Buffer to Jest; correcting that test helper produced the clean final run.

The initial invitation browser run passed 21/24. The three failures were the same test mistake: after accepting an invitation, the current Matter had moved to Applications, while the test opened Active Matters. The test now follows that existing category behavior. The corrected combined invitation, notes and Matter-list regression passed **93/93** across Chromium, Firefox and WebKit in 6.4 minutes. This includes accessibility scans, mobile and desktop layout, failed refreshes, profile return navigation, delayed reads and account changes. Mobile/desktop invitation screenshots were visually inspected.

A final compatibility test then reproduced a 404 for an owner whose legacy reference was stored as text. The raw ownership filter now supports both text references and BSON ObjectIds, retaining owner-only access and making no record migration. The final 53-check backend run includes that case. Only this ownership-filter correction changed application source after the 93-check browser run; the final focused invitation recheck passed **24/24** across all three browsers in 3.3 minutes. There are 93 distinct browser scenarios with passing latest results: the clean 93-scenario run plus a clean recheck of its 24 invitation scenarios after the final correction.

Static syntax, runtime/frontend bindings, frontend hygiene, API contract, route security and performance checks pass. Application source was frozen during each browser run, and no pre-existing file outside the 20 owned paths changed during this continuation. Full repository regression and production release gates remain open. No deployment, commit, production migration or live-data changes are included.

Release identifier: `attorney-v2-invitations-20260905`.
