# Attorney V2 Phase 0 Defect and Ambiguity Register

Status: Characterization register. No item authorizes a fix or redesign.

| ID | Evidence | Classification | Risk | Required owner/evidence | Blocks |
|---|---|---|---|---|---|
| A-01 | `DOMAIN_LIFECYCLE_INVENTORY.md` and `SCENARIO_COVERAGE_REPORT.md` identify attorney escrow total divergence from `/api/payments/summary` | Suspected existing defect | Incorrect financial presentation | Payments owner; one-record money projection test | Payments implementation and rollout |
| A-02 | Message unread count, summary, thread aggregation, and last-viewed predicates differ | Existing ambiguity | Badge/count disagreement | Messaging owner; S09 equivalence fixture | Messaging implementation |
| A-03 | Case edit/relist can leave incomplete Job discovery/matching mirrors | Suspected existing defect | Stale candidate discovery | Lifecycle owner; forced mirror-failure tests | Mutating Matter implementation if reproduced |
| A-04 | Application and `Case.applicants` are dual projections with reconciliation states | Known compatibility risk | Counts/actions may be stale | Lifecycle owner; S04 failure/convergence evidence | Applicant mutation acceptance |
| A-05 | No canonical unpublish or Matter-expiration transition was found | Documented absence | V2 copy could invent behavior | Product/lifecycle owner confirms indefinite-open/delete semantics | Create/Matters copy approval |
| A-06 | Case deadline, legacy deadline, Event, Case task, standalone Task, and ChecklistTask overlap | Existing ambiguity | Wrong visibility/date/task ownership | Product/lifecycle owner; S11 source matrix | Work/deadline design |
| A-07 | Case status/funded-workspace normalization is duplicated in V1 clients | Compatibility debt | Different actions by screen | Characterization across exact aliases | Capability selector acceptance |
| A-08 | `profile-settings.html` is shared and paralegal-first before role hydration | Architecture coupling | First-paint/privacy/regression risk | Attorney-owned replacement; no shared edit | Settings implementation approach |
| A-09 | Workspace falls back across `/api/cases/my`, `/api/cases`, upload routes, and embedded file paths | Compatibility ambiguity | Removing fallback may break records | API owner names canonical read contract after fixtures | Workspace/file retirement only |
| A-10 | Legacy redirect traffic and external bookmarks are unmeasured | Unknown dependency | Broken external links | Analytics/access-log owner; observation window | Redirect retirement only |
| A-11 | Job/Case, Application/mirror, and identity/profile/state/practice/status aliases have active callers and unclassified dependency | Unknown compatibility | Historical/active record breakage | Compatibility owner; caller and provenance evidence | Compatibility retirement only |
| A-12 | Mountain/mountain-dark preferences affect confirmed real users | Confirmed live dependency | Preference loss/visual regression | Separate reversible owner-approved migration | Settings compatibility retirement |
| A-13 | Historical recommendation exclusion is contradicted by current paralegal client behavior | Existing cross-role defect/ambiguity | Rejected/withdrawn Matter resurfaces | Paralegal/product owner; do not modify in attorney project | No attorney Phase 1 block; blocks related cross-role acceptance |
| A-14 | General Assistant and specialized withdrawn-paralegal evidence access differ | Named policy boundary not fully contracted | Overexposure or lost authorized history | Assistant/security owner; withdrawn evidence test | Assistant migration |
| A-15 | V1 uses both `openApplicant` and `openApplicants` query keys | Compatibility ambiguity | Candidate-review deep links can fail | Route characterization and link-producer census | Route canonicalization/retirement |
| A-16 | `returnTo` and multiple contextual IDs cross candidate/profile/workspace routes | Security-sensitive compatibility | Open redirect or confused-deputy navigation | Security owner; same-origin allowlist and ACL tests | Candidate deep-link implementation |
| A-17 | Current working tree has 289 pre-existing entries across attorney, paralegal, shared, and test files | Baseline ambiguity | Attribution and merge conflict | Owner selects clean baseline/manifest | Phase 1 start |
| A-18 | Authenticated browser suite measures the only `#weeklyNotesGrid` while its parent Tasks view is hidden and the browser remains on Home | Confirmed stale test contract | Invalid responsive signal; visible Tasks geometry remains uncharacterized | Attorney test owner confirms Weekly Notes ownership and updates the gate only under separate authorization | Tasks responsive acceptance |
| A-19 | Dashboard onboarding copy contrast is 4.16:1 rather than required 4.5:1 in all three browser projects | Confirmed accessibility defect | WCAG 2 AA failure | Accessibility/design owner approves V2 token and any separate V1 remediation | Accessibility acceptance |
| A-20 | Create Matter Next Step contrast is 2.44:1 rather than required 4.5:1 in all three browser projects | Confirmed accessibility defect | WCAG 2 AA failure on primary workflow | Accessibility/design owner approves V2 token and any separate V1 remediation | Create Matter acceptance |
| A-21 | Synthetic Matter loads, is selected, and renders its facts, but `case-detail.html` has no `#caseTitle` node while `case-detail.js` writes the authoritative title only to that optional binding | Confirmed presentation/test-contract mismatch | Visible/accessible Matter identity is absent from the workspace heading structure | Matter product owner confirms heading contract; shared frontend owner requires attorney/paralegal compatibility before any V1 fix | Workspace browser acceptance |
| A-22 | Assistant drawer pins, but docking CSS targets only `body > main` or `body > .main`; attorney main is nested in `.lpc-auth-page-shell`, leaving main edge 1280 while drawer begins at 861 | Confirmed shared-shell selector mismatch | Drawer overlays or obscures attorney work area | Shared frontend/Assistant owner; document paralegal V1/V2 compatibility before any fix | Assistant/shell acceptance |
| A-23 | Private Tasks New task button contrast is 3.29:1 rather than required 4.5:1 | Confirmed accessibility defect | WCAG 2 AA failure; later task assertions do not execute | Accessibility/design owner approves V2 token and separate V1 remediation decision | Tasks accessibility acceptance |

## Classification rules

- **Confirmed defect:** reproducible mismatch against an owner-approved authoritative behavior.
- **Suspected defect:** repository evidence suggests a mismatch but the expected behavior is not yet executable.
- **Ambiguity:** two current sources or paths disagree and neither is approved as sole authority.
- **Compatibility dependency:** behavior may be awkward but active/historical consumers prevent removal.
- **Desired enhancement:** excluded from this register until separately proposed; it is not parity work.

Security, authorization, privacy, or money defects are stop-ship. Other confirmed defects may be reproduced temporarily for parity only with an owner-recorded decision and a separate remediation plan.
