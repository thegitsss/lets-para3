# Attorney V2 Phase 0 Test Traceability and Exit Gates

Status: Required evidence map; Phase 0 does not implement the V2 tests listed for later phases.

## Executed repository characterization

On September 4, 2026, the 12 attorney-relevant suites mapped in `V1_CHARACTERIZATION_EVIDENCE.md` passed 125/125 tests against synthetic in-memory data. This is adopted as existing lifecycle, payment, ACL, messaging, file, search, notification, settings, and cross-role evidence. Complete route, accessibility, responsive, performance, and the specifically listed ambiguity tests remain outstanding.

The authenticated Playwright support baseline then ran 45 checks across Chromium, Firefox, and WebKit: 27 passed and 18 failed. The same nine scenarios passed and the same six failed in every browser. Exact findings A-18 through A-23, source ownership, and diagnosis are recorded in `V1_BROWSER_BASELINE.md`. This is a successful characterization run with a failing V1 acceptance result; it must not be described as a green browser baseline. A-18 is confirmed harness drift, while A-19 through A-23 are current presentation/layout contract failures or mismatches.

## Artifact contract

`backend/tests/attorneyV2Phase0AuditContract.test.js` must prove that:

- every Phase 0 owned artifact exists and parses where machine-readable;
- the baseline commit/branch and authorization boundary are recorded;
- protected paralegal/shared paths are disjoint from Phase 0 owned paths;
- every route has authentication, responsibility, V2 disposition, and retirement treatment;
- known query/hash compatibility keys are present;
- every API endpoint has method, path, purpose, mutation classification, guards at family level, error classes, and characterization requirements;
- money-critical endpoints are mutations and explicitly require safe retry treatment;
- every mutation that the ledger marks as currently CSRF-protected records that fact;
- lifecycle fixtures contain the full exact status axes and core cross-role scenarios;
- every defect has a classification, owner/evidence requirement, and phase gate;
- the Phase 0 test imports no application route, model, service, database, network, or Stripe client.

## Coverage traceability

| Scope | Route IDs | API families | Fixture scenarios | Existing evidence to preserve | Required new characterization before implementation |
|---|---|---|---|---|---|
| Access/session | all protected routes | session, current-user | S00, S18 | auth/security/ACL tests | browser stale-tab, BFCache, account-switch matrix |
| Home/onboarding | attorney-home | attorney-dashboard, current-user, messages, payments | S01 | dashboard/onboarding tests | one fixture comparing all summary sources |
| Matter draft/create | attorney-create-matter | case-drafts, cases-lifecycle-workspace | S02, S03 | lifecycle/job escrow tests | publish/cleanup failure, two-tab draft, double submit |
| Matters/applications | attorney-matters, attorney-applications-redirect | cases-lifecycle-workspace, applications | S03–S06 | case-flow/application tests | cross-role movement and mirror failure |
| Candidate/hire | attorney-paralegal-directory, attorney-candidate-profile | candidate-presentation, cases-lifecycle-workspace, payments | S05–S07 | readiness/block/hire tests | browser pending-hire, race and unknown payment recovery |
| Workspace | attorney-workspace | cases-lifecycle-workspace | S08 | ACL/matter experience tests | direct-link alias/access-loss matrix |
| Messages | attorney-workspace | messages, notifications | S09 | messaging/notification tests | unread equivalence and two-tab browser test |
| Files | attorney-workspace | files | S10 | uploads/downloads/ACL tests | scan/mirror/replacement races and local-storage audit |
| Work/deadlines | attorney-workspace, attorney-private-tasks | private-checklist, events-deadlines, cases-lifecycle-workspace | S11 | task/deadline lifecycle tests | authoritative source/visibility contract |
| Completion/withdrawal | attorney-workspace | cases-lifecycle-workspace, payments | S12, S13 | payout/withdrawal tests | full browser cross-role terminal movement |
| Disputes | attorney-workspace | disputes, payments | S14, S15 | dispute/refund tests | money and access projection after each allocation |
| Payments | attorney-payments | payments | S07, S12–S15 | payment/ledger/receipt tests | all-record equivalence and client duplicate prevention |
| Profile/settings | attorney-profile, attorney-settings-* | current-user, account-security-preferences, files, blocks | S00, S01, S16 | profile/account/passkey tests | role-first paint, draft/partial payload, browser support |
| Search/notifications/Assistant | all shell routes | notifications, assistant-support, cases search | S17 | authenticated search/notification/support tests | safe links, >100 unread, withdrawn evidence boundary |
| Help/incident | attorney-help | incident-intake | S17 | incident/support tests | privacy, rate-limit, error/retry browser states |
| Retirement/rollback | all routes | all families | S18 | release/rollback documents | mixed V1/V2 drill and traffic/link evidence |

## Accessibility baseline to capture before Phase 1

- Acceptance target: WCAG 2.2 AA.
- Automated WCAG scan and keyboard pass for every V1 route/state in `routes.json`.
- VoiceOver/Safari and NVDA/Firefox or Chrome on Home, create Matter, candidate review/hire, workspace, Payments, and Settings.
- 200%/400% zoom, text spacing, reduced motion, forced colors, and focus restoration for all dialogs/drawers.
- Viewports: 320, 360, 390, 768, 1024, 1366, 1440, and 1920 CSS pixels.
- Record existing failures as baseline defects; do not waive them as V2 parity.

## Performance and browser baseline to capture before Phase 1

- Current/previous Chrome, Edge, Firefox, Safari; current iOS Safari and Android Chrome.
- Per-route JS/CSS bytes, request count, LCP, INP, CLS, long tasks, and memory after ten route/Matter transitions.
- Counts of session/user/dashboard/notification/search/Assistant calls, active EventSources, polls, timers, and listeners.
- Synthetic high-volume profiles: 100+ Matters/applications/notifications, long message/file/task lists.
- Slow network, offline/reconnect, 429, partial API failure, and SSE-to-poll behavior.

## Blocking owner decisions before Phase 1

- [ ] Select a clean baseline commit or immutable allowed-change manifest (A-17).
- [ ] Approve the V2 URL strategy; proposed prefix remains null in `routes.json`.
- [ ] Approve the Phase 1 attorney-owned namespace in `protected-paths.json`.
- [ ] Name the decision owners for lifecycle, payments, security, accessibility, shared frontend compatibility, support/Assistant, and rollout.
- [ ] Confirm whether Phase 1 may wrap current shared session/search/notification/Assistant code without modifying it, or must initially use attorney-local adapters.
- [ ] Approve supported browsers and quantitative performance budgets.

## Phase 0 exit checklist

- [x] Focused audit contract passes: 1 suite, 23 tests, September 4, 2026.
- [x] JSON artifacts parse and contain no duplicate route IDs, family IDs, or endpoint method/path pairs within a family.
- [x] Git status confirms only Phase 0-owned additions were made by this phase.
- [x] No runtime, paralegal, shared backend, production, database, Stripe, deployment, or migration action occurred.
- [ ] All blocking owner decisions are answered or Phase 1 remains explicitly blocked.
- [ ] Owner reviews Phase 0 and separately authorizes or declines Phase 1.

Passing the first four checks completes the technical Phase 0 package. Phase 1 remains blocked until the last two checks are satisfied.
