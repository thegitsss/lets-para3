# Paralegal V2 Phase 7 — Matter workspace read-only foundation

Completed locally: September 3, 2026  
Deployment status: Not deployed  
Production access: None

## Scope completed

The authorized Matter workspace now opens as a routed view inside the persistent Paralegal V2 shell. Sidebar, header, Search, Notifications, Assistant, and the application document remain mounted while the Matter or its sections change.

The V2 workspace presents:

- Matter identity, exact server status, relationship, attention state, practice area, jurisdiction, attorney, deadline, start date, summary, and task progress;
- server-authorized work items in read-only form;
- safe file and submission metadata with status and version evidence;
- authorized message history without a composer or other send controls;
- the server-projected Matter activity record as History;
- role-filtered financial status and amounts from `matterExperience.financials`;
- completed and archived Matters as explicit read-only historical records;
- invalid, missing, forbidden, expired-session, and temporarily unavailable outcomes without disclosing prior Matter content.

Active and completed Matter links in My Matters & Applications now enter the V2 route rather than remounting `case-detail.html`. Existing legacy deep links continue to adapt into the equivalent V2 Matter route.

## Existing authority preserved

- `GET /api/cases/:caseId` remains the Matter identity, access, lifecycle, overview, task, safe-file, activity, and financial projection authority.
- `matterExperience.sections` remains the role-filtered allowlist for visible workspace sections. The browser does not invent section access.
- `matterExperience` remains the source of truth for status labels, relationship, attention, overview, task progress, activity, and financial values.
- `GET /api/messages/:caseId` remains the authorized message-read contract. Its existing server behavior records message viewing; Phase 7 does not add a separate read mutation or change unread policy.
- The browser renders only safe file metadata already returned by the Matter projection. It does not receive or reconstruct storage keys.
- A 401 response clears the V2 session and returns to sign-in with the Matter route preserved.
- A 403 or 404 response immediately replaces the workspace with a non-disclosing state and invalidates Home and Work projections.
- Visible-tab revalidation re-fetches the Matter before retaining confidential content.
- Leaving the Matter route aborts its active request, and the Matter view keeps no persistent confidential cache.

## Mutation boundary

Phase 7 adds no message composer, file upload/download action, task toggle, deadline editor, submission/revision action, approval, completion, withdrawal, dispute, block, payout, or payment control. The V2 Matter module calls only existing GET endpoints.

All workspace mutations remain in the current characterized implementation until separately authorized Phase 8 work migrates and verifies them one workflow group at a time.

## Verification

- Phase 7 and existing workspace authority Jest set: 4/4 suites and 28/28 tests passed under Node 24.18.0 before final documentation.
- Complete repository Jest suite: 201/201 suites and 1,530/1,530 tests passed under Node 24.18.0 and npm 11.16.0.
- Phase 7 browser matrix: 18/18 passed across Chromium, Firefox, and WebKit.
- Coverage includes authorized active work, direct section links, highlighted messages, no mutation requests, inaccessible and missing Matters, expired sessions, visible-tab access loss, completed/archived records, Assistant-open containment, and all required widths from 320px through 1920px.
- Automated WCAG A/AA scanning passed for the populated message state after correcting two small-text contrast defects.
- Integrated Chromium V2 regression: 27/27 checks passed after the shared mobile-to-desktop transition correction.
- No schema, backend route, lifecycle, status, recommendation, eligibility, payment, Stripe, production-data, or deployment change was made.

## Next gated phase

Phase 8 is the Matter workspace mutation migration. It remains unstarted and requires separate authorization. Messages, files, deadlines, submissions, revisions, approvals, completion, and cross-role reconciliation must be connected and verified incrementally rather than enabled as one uncharacterized group.
