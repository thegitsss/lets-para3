# Payment card setup and selected-application return

Active final-review prerequisite. The complete Payments screen, billing portal, hiring/funding and P8 financial workflows remain separate unfinished work.

Checkpoint: `backend/backups/attorney-v2-phase5-payment-setup-start/`, with 1,876 initial hashes and exact before sources. Existing files added to ownership were compared to that initial manifest before editing.

## Implementation

The isolated card page is addressable at `#/payments/setup`. It uses the existing Stripe.js loader and Payment Element, with a specific same-origin return address. Card entry remains in the provider element; client secrets do not enter browser storage. Provider callback parameters are removed before the page makes authenticated API requests. Only the non-secret SetupIntent identifier remains in tab memory, and the server checks its actual customer, owner metadata, status and attached card. The query's reported status cannot establish a saved card.

Setup verification and changing the default card are separate explicit actions. A returned or verified card is never automatically made the default. Saving a default does not hire a paralegal or fund a Matter. Failed provider reads show unavailable, not an empty card. Account/version/customer checks guard reads, setup and default changes; interrupted results lead to a fresh read without automatic resubmission. Default-card writes using the V2 contract require a succeeded, owned SetupIntent and its exact attached card. Existing clients retain their contract.

Pending hiring return now stores the paralegal identifier alongside the existing fields. Saving and clearing use the displayed context revision and an atomic compare of current user facts; one tab cannot erase a newer saved return. The server builds the return to the exact owned Matter/application. Earlier stored addresses and names cannot infer a candidate or produce an external redirect. Earlier or removed applications remain explicit unavailable contexts that can be cleared. Unknown stored evidence is retained when replacing an object-shaped record. No bulk migration is performed.

The browser exposes the saved return beside card setup and within V2 application details. Opening the return does not automatically clear it. The application is reviewed again under current eligibility before any later hiring action. Card form state and uncertain operations are confined to tab memory and erased by account protection. Provider waits are bounded, and route changes destroy mounted card elements.

The provider integration follows [Stripe's SetupIntent confirmation contract](https://docs.stripe.com/js/setup_intents/confirm_setup) and [server-side SetupIntent retrieval](https://docs.stripe.com/api/setup_intents/retrieve). Local tests use synthetic provider objects and never establish real-card or bank-authentication acceptance.

## Local verification

- Candidate 1 passed 33 backend checks: pending context/card guards (24) and existing escrow consumers (9).
- Candidate 2 passed 40 checks across pending context/card guards, client model/API contracts (7), and escrow consumers (9).
- Final backend candidate 5 passed **43/43** checks across pending return/card guards (25), client models/API (7), existing escrow (9) and the complete cross-role lifecycle suite (2).
- **30/30 browser scenarios** passed on candidate 3 across Chromium, Firefox and WebKit, one worker, no retries. Three additional executions of the complete return scenario on candidate 4 verify the actual link click reopens the exact applicant, followed by clearing the return. These are strengthened repeat scenarios, not three new scenarios.
- The initial 18/21 browser result had the same test-observation defect in all engines: the cleanup counter was read after the redirect loaded a fresh page and reset the synthetic counter. The corrected observation captures destruction synchronously with account protection, before navigation. No runtime change was required for that failure. Additional scenarios cover late responses after account loss, closing incomplete entry, and stopping an unconfirmed setup.
- All 1,403 source files remained unchanged during candidate 3 verification. Candidate 4 changed only the strengthened return test. Candidate 5 adds the backend check that a removed provider customer is unavailable instead of a missing card, and its regression test; browser behavior and UI source are unchanged.
- Narrow (320px) and wide (1366px) card-confirmation screenshots were visually inspected. Card identity, expiry and explicit default choice fit without horizontal overflow, with keyboard focus, touch targets and no scoped Axe violations. The full page editorial/brand pass remains a separate final-review requirement.
- API contract: **419 frontend literals / 401 mounted route patterns** passed. Frontend hygiene retains 19 independently owned admin/paralegal-preview findings and no attorney finding. The current fixed snapshot also carries the separately recorded runtime binding and LpcEvent index findings; this slice does not resolve them.

P5-05 is locally implemented and verified. P8-01/P8-02 remain open for the complete Payments screen, billing portal and broader hosted-return/settings integration. No real provider authentication, release, cohort enablement, commit, deployment or real financial operation is included. The server checks only verify synthetic provider behavior in these tests; operational acceptance remains required.
