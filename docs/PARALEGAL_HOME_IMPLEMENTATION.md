# Paralegal Home implementation and verification

> Superseded visually by the user's subsequent Linear desktop request. See [the current desktop implementation](PARALEGAL_LINEAR_IMPLEMENTATION.md) and [live reference inspection](PARALEGAL_LINEAR_REFERENCE.md). The narrative below records the earlier white Home iteration and its original evidence; its horizontal-navigation and stylesheet-order statements are historical.

Implemented in the current development entry, `frontend/paralegal-v2.html#/home`, within the existing persistent V2 shell. This is local development work, not a release, V1 cutover, or deployment.

## Working-tree boundary and baseline

The checkout already contained substantial tracked and untracked work. The original Home renderer, shell controller, entry HTML and full working-tree status were captured at `/private/tmp/lpc-home-20260908-baseline/` before edits. No reset, checkout, cleanup, commit, push, account switch or production action was performed.

The unchanged existing Home browser suite passed **15/15 in Chromium** before implementation. The final migration preserves all 15 cases and their applicable behavior; revised assertions follow this brief's superseding composition, authorization fixtures, and prohibition on confidential Home enrichment reads. No test was deleted or skipped to obtain a pass.

## Completed behavior

- A single pure Home model normalizes the authorized sources, exclusions, readiness context, deadline dates, deterministic priority and stable record tie-breaks. Presentation categories do not change lifecycle statuses.
- Active work has one clear workspace destination and an ordered queue for multiple Matters. A verified pre-hiring request, overdue/today deadline, recorded update, invitation or application movement can lead. Future deadlines remain a concise date line; no new urgency window or response SLA is introduced.
- Opportunities preserve invitation, application and recommendation meanings. Populated groups precede compressed empty groups. Recommendations are disclosed quietly while active work dominates. Lightweight previews show authorized scope, posted amount and dates, then open the existing gated destination for actual business actions.
- Deadlines include unresolved past-due active work; private reminders are labeled separately. Communications distinguish unread awareness from a required reply. Home does not mark messages read.
- Readiness sits in the opportunity context it blocks. Matching fields, profile photo and payout readiness retain their different meanings. They do not displace permitted active work.
- Availability saves use the shared CSRF boundary, suppress duplicate submissions, retain recoverable input, apply only confirmed server state and reconcile shared data. Existing application/invitation/withdrawal/Stripe flows remain owners of their validations and confirmations.
- Independent source loading is local and bounded by a 10-second read timeout. Malformed, unavailable, restricted, partial and empty data are distinct. Home's 30-second cache is scoped to verified identity and revision. A profile identity or explicit account-state conflict fails closed.
- Existing lifecycle/subscription/cross-tab signals invalidate Home. Background rendering waits for a safe interaction boundary; dialogs and typing remain protected even during an explicit retry. Stale financial values are withheld. Session/access/identity loss clears protected state and invalidates late responses.
- Mobile retains work and attention first, then schedule/communication, with secondary opportunities reachable. When there is no active work, opportunities lead. DOM and focus order match this presentation.

## Visual system and actual inspection

All Home surfaces and Home-opened shell overlays use `#FFFFFF`. The final stylesheet is scoped to the existing committed Home route, with a requested-Home fallback for first paint; stored theme and font-size preferences and other destinations are retained. Operating-system forced colors are not disabled.

The existing V2 navy token is **`--v2-navy: #0B2947`**. The approved cornflower value is **`#6495ED`**, verified in the approved constellation implementation and mapped to the Home blue token. White/navy contrast is **14.76:1**. White/cornflower is only **2.97:1**, so navy supplies readable text, buttons and meaningful focus/selection boundaries. No substitute shade was introduced.

Operational text uses existing **`--v2-font-sans: "Sarabun", sans-serif`**, at real bundled 400/600 weights. The existing LPC wordmark retains its established serif role. Actual font loading and computed styles were checked in the browser, not inferred from declarations.

Public official product images/docs actually inspected, their URLs, and translated design principles are in [PARALEGAL_HOME_REFERENCES.md](PARALEGAL_HOME_REFERENCES.md). No private Stripe, Linear, Mercury or Ramp account was accessed.

## Correction record

Rendered review found and corrected:

1. A closed Assistant backdrop incorrectly made opaque by the initial white rule.
2. Initial notification hydration aborting the new progressive Home load without a follow-up render.
3. A closed Assistant identified as open by `hidden`, although its controller uses `aria-hidden`.
4. Empty Active work / invitation / application groups pushing real recommendations below the fold.
5. Desktop stacking and CSS order causing an inappropriate mobile reading/focus order.
6. Availability reopening against the pre-save snapshot.
7. Explicit retry allowing late data to replace an open input/dialog.
8. Tablet backdrop cascade, a colored notification badge, and disabled Assistant send opacity.
9. Nested Assistant composer boundaries; retained one field boundary and a clear keyboard focus indicator.
10. Home keeps its white surface while an outgoing destination loads; committed-route scope prevents a premature cream flash.

The corrected screenshots and complete browser results are indexed in [PARALEGAL_HOME_BROWSER_EVIDENCE.md](PARALEGAL_HOME_BROWSER_EVIDENCE.md).

## Source and test artifacts

- Model/source/state matrix: [PARALEGAL_HOME_STATE_CONTRACT.md](PARALEGAL_HOME_STATE_CONTRACT.md).
- Implementation: `frontend/assets/scripts/paralegal-v2/home-view.mjs`, new `home-model.mjs`, new `frontend/assets/styles/paralegal-home-workspace.css`.
- Necessary shared integration only: `frontend/assets/scripts/paralegal-v2/app.mjs` (identity clearing and interaction-safe refresh), `frontend/paralegal-v2.html` (last Home stylesheet).
- Tests: new `backend/tests/paralegalHomeModel.test.js`, new `backend/tests/playwright/paralegal-support/home-redesign.spec.js`; migrated existing Home, deadline and realtime integration assertions, existing `v2-home.spec.js`, and the Home-specific focus/scroll assertions in `v2-foundation.spec.js`.
- No backend route, schema, security, payment, business policy, router, Assistant permission or other destination implementation was changed.

## Regression evidence and limits

Required local runtime: Node **24.18.0**. Local listener checks were rerun with permitted localhost access after sandbox `listen EPERM`; no source code was changed to accommodate that sandbox limitation.

The final Home model, Home integration, deadline integration and realtime checks passed **52/52 tests in 4 suites** (3.464 seconds). A broader 15-suite run covered Home ownership, V2 foundation, realtime, Work, Browse, Settings, messaging, deadlines, parity, workflow policy, availability, notification presentation, recommendation projection, pending-hire context and released-payment evidence. Eleven suites passed immediately. Two Home source-characterization assertions were migrated to the new model and cancellation boundary without weakening their behavior. The unrelated pending-hire suite initially timed out in database setup and passed unchanged on a focused rerun. That follow-up passed **44/44 tests in 3 suites**.

One broader static assertion remains inherited: `paralegalV2FoundationContract.test.js:60` requires a “Collapse sidebar” control that the pre-existing horizontal shell no longer contains. The captured original HTML also lacks it; the entry HTML change in this assignment is only one stylesheet link. Its browser equivalent is verified against the actual retained horizontal/mobile navigation. This existing test/implementation mismatch is reported, not hidden by changing another agent's shell work.

No bank-receipt event, user-specific last-visit comparison, document/page progress, reliable new-file timestamp/read receipt or revision-request summary is supplied by the Home projections. The implementation therefore uses exact supplied “Latest file” / “Latest update” labels and “Open workspace.” A richer revision alert requires a small authorized dashboard summary extension; no confidential per-Matter fetch expansion or backend change was made. Existing event/thread feeds are bounded previews, not a claim of a complete global calendar or inbox archive.

Final browser correction reruns passed **9/9** across Chromium, Firefox and WebKit; the final outgoing/incoming Home transition check passed **3/3**. Existing Home workflows passed **15/15** in Chromium. The browser evidence index records the full and focused run history rather than implying one subsequent full-suite rerun.

Automated browser/axe checks are evidence for the tested states, not a blanket WCAG certification or production-readiness claim.
