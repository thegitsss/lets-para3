# Attorney V1 Authenticated Browser Baseline

Status: **Observed characterization, including failures; no V1 remediation authorized**

Recorded: September 4, 2026

## Test run

Command: `npm run test:playwright:support`

Environment:

- authenticated synthetic attorney and seeded synthetic Matter/profile data;
- local Playwright support harness and local test server;
- Chromium, Firefox, and WebKit;
- no production records or live Stripe calls;
- V1 runtime source left unchanged.

Result:

- Tests: **27 passed, 18 failed, 45 total**
- Logical scenarios: **9 passed and 6 failed in each of 3 browsers**
- Duration: approximately **7.1 minutes**
- Browser traces, videos, screenshots, and error contexts: `backend/test-results/playwright-support/` (generated/ignored test evidence)

## Cross-browser passes

The following passed in Chromium, Firefox, and WebKit:

1. Attorney sends a Matter invitation through the real candidate-profile action.
2. Stripe Checkout return presentation preserves Matter context and explains success/cancellation.
3. Legacy candidate-review URL preserves Matter context and opens canonical inquiries.
4. Legacy attorney Matter URLs preserve context and converge on canonical workflows.
5. Desktop sidebar grip collapses and restores attorney navigation.
6. Profile Settings uses mobile navigation instead of a top-stacked sidebar.
7. Attorney Assistant renders a concise manager answer, verified link, suggestions, and feedback.
8. Attorney Assistant validation fallback avoids noisy actions or inappropriate escalation.
9. Approved attorney first login lands on the guided dashboard experience.

These are V1 characterization facts. They do not prove V2 behavior.

## Cross-browser failures

The same six logical failures occurred in all three browsers, making them reproducible baseline findings rather than one-engine anomalies.

| Finding | Observed assertion | Classification |
|---|---|---|
| Mobile Home weekly-notes layout | Expected card width at least 132px; measured `0`; expected horizontally scrollable grid | Confirmed stale browser-test contract: the only `#weeklyNotesGrid` is in the hidden Tasks view while the assertion remains on Home; A-18 |
| Dashboard onboarding contrast | `.onboarding-attention-progress-copy` and `.onboarding-attention-text` are `#61788d` on `#eef5fb`, ratio 4.16:1; expected 4.5:1 | Confirmed automated WCAG 2 AA failure; A-19 |
| Create Matter primary action contrast | `#detailsNextBtn` is white on `#b6a47a`, ratio 2.44:1; expected 4.5:1 | Confirmed automated WCAG 2 AA failure; A-20 |
| Matter/profile detail seeded-record rendering | Expected Matter heading `Harness Contract Review` never appeared within 15 seconds; the Matter loaded and was selected, but its title was not rendered | Confirmed presentation/test-contract mismatch: current markup has no `#caseTitle` even though the renderer targets it; A-21 |
| Attorney Assistant docking | Main content right edge measured 1280 while drawer left edge was 861; expected main edge no farther than drawer + 1px | Confirmed layout contract failure; A-22 |
| Private Tasks primary action contrast | New task button uses `#162b3d` on `#557c9f`, ratio 3.29:1; expected 4.5:1 | Confirmed automated WCAG 2 AA failure; A-23 |

The private-task test stops at its accessibility assertion, so this run does not characterize create/complete/delete after that point. The Assistant send-message scenario likewise stops at the docking assertion before its later interaction assertions. These are coverage interruptions, not proof that the later actions fail.

## Source ownership and diagnosis

| Finding | Diagnosis | Current source owner | V2 treatment |
|---|---|---|---|
| A-18 | `support.spec.js` remains on `/dashboard-attorney.html#home` when it measures `#weeklyNotesGrid`. The sole grid is under `section.view-tasks[hidden]` in `dashboard-attorney.html`, so its bounding width is necessarily zero. The responsive width rules themselves target the Tasks grid. | Existing attorney browser harness plus attorney V1 dashboard; do not change either in this audit | Move the V2 acceptance assertion to the intended Tasks route/state. Preserve a separate Home responsive check; do not reproduce a hidden-element assertion. |
| A-19 | `attorney-home-layout.css` forces both onboarding copy selectors to `var(--lpc-text-secondary)` on the onboarding surface. The computed pair is `#61788d` on `#eef5fb` (4.16:1). | Attorney-specific Home stylesheet and design tokens | Require an attorney-owned AA-compliant semantic text token; shared token changes require separate compatibility approval. |
| A-20 | `create-case.html` uses the inline `.btn.primary { background: var(--accent); color: #fff; }` rule for `#detailsNextBtn`; `--accent` is `#b6a47a` (2.44:1 with white). | Attorney V1 Create Matter page | V2 action tokens must pass AA before the Create Matter slice is accepted. Any V1 fix is separately authorized. |
| A-21 | The seeded Matter and `/api/cases/:id` presentation data load: the switcher contains and selects `Harness Contract Review`, and Overview facts render. `case-detail.js` still resolves `document.getElementById("caseTitle")` and assigns the Matter title, but `case-detail.html` contains no `id="caseTitle"` node or equivalent Matter-name heading. This is not an API/bootstrap failure. | Shared attorney/paralegal Matter workspace markup and renderer | V2 must render the authoritative Matter title as a visible accessible heading. A shared V1 correction needs attorney/paralegal compatibility tests and separate approval. |
| A-22 | `support-drawer.js` correctly opens and pins the drawer. `support-drawer.css` reserves dock space only through `body.support-drawer-pinned > main` and `body.support-drawer-pinned > .main`; the attorney dashboard main is nested inside `body > .lpc-auth-page-shell`, so neither selector matches. | Shared Assistant CSS and authenticated shell structure | Use an attorney-local V2 host adapter initially, or obtain a separately reviewed shared-shell change with paralegal V1/V2 coverage. |
| A-23 | `attorney-home-layout.css` overrides the older dark-gold task button and applies `var(--lpc-accent-primary)` as the background with `var(--lpc-text-primary)` as text, yielding 3.29:1. | Attorney-specific Home/Tasks stylesheet and design tokens | Require an AA-compliant V2 task-action token; do not alter shared tokens inside an attorney slice. |

No source file listed above was modified during diagnosis.

## Phase 0 conclusions

- V1 is not currently a green browser baseline.
- V2 must not declare parity by reproducing the three confirmed contrast failures.
- A-18 is acceptance-harness drift, not evidence that visible Tasks content has zero width. Its gate remains invalid until the assertion enters the Tasks view.
- A-21 is not a data or route failure: it is a missing visible/accessible Matter-title binding in the current shared workspace markup.
- A-22 is a current shared-layout dependency because Assistant and shell infrastructure are shared.
- The nine passing scenarios provide compatibility requirements for legacy links, payment returns, onboarding, candidate invitation, navigation, and Assistant response presentation.
- No fix was attempted because the owner authorized audit/characterization, not V1 implementation changes.

## Required next evidence

1. Obtain owner confirmation that the Matter title must remain a visible heading and that Weekly Notes remain a Tasks feature.
2. Correct the existing browser gate only under separate test-maintenance authorization, then capture the visible Tasks mobile geometry.
3. After separately authorized V1 fixes or completed V2 slices, rerun all 45 checks on all three browsers.
4. Add dedicated attorney screenshots at 320, 360, 390, 768, 1024, 1366, 1440, and 1920; the current suite covers multiple responsive conditions but is not the complete required visual matrix.
