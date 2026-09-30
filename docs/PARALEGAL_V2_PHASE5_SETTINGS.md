# Paralegal V2 Phase 5 — Profile Settings

Completed locally: September 2, 2026  
Deployment status: Not deployed  
Production access: None

## Scope completed

Profile Settings is now a routed view inside the persistent Paralegal V2 shell. Profile, Security, and Preferences switch in place without replacing the sidebar, header, search, notifications, Assistant host, or page document.

The visual system is isolated in `paralegal-v2-settings.css`, uses the existing white LPC workspace, contains no shadows, and leaves `.v2-view` as the only vertical scroll owner.

## Existing authority preserved

- Profile data continues to load from and save through `/api/users/me`.
- Profile edits use an 850 ms debounced autosave with an explicit `Save now` fallback.
- Draft recovery is session-scoped, expires after 24 hours, and is offered only when its recorded server revision still matches the current profile.
- Photo crop, upload, review, original-image editing, and removal continue through the protected profile-photo endpoints.
- Résumé, certificate, and writing-sample actions continue through the protected document endpoints.
- Pending email, pending/approved/rejected profile-photo states, readiness, and the attorney-visible profile preview remain represented.
- Security data loads only after the Security category opens. Password, two-step verification, authenticator enrollment, backup codes, passkeys, sessions, blocks, Stripe Connect entry, and deactivation continue through their existing endpoints.
- Sensitive mutations remain explicit and require the existing password and/or confirmation gates.
- Preferences save independently through the existing notification and account-preference endpoints.
- Only Light and Dark are exposed. Older theme values are normalized for presentation without deleting unrelated account data.
- No backend status, schema, lifecycle, eligibility, payment, or authorization behavior changed in Phase 5.

## Audit corrections

The post-implementation audit found and corrected:

1. legacy profile copy that narrowly missed AA contrast on warm backgrounds;
2. a corrected avatar-initial color that had been left in an obsolete, unloaded stylesheet instead of the active stylesheet;
3. legacy experience and education aliases that needed normalization before safe round-trip saves;
4. pending-email presentation that needed to remain authoritative while verification is outstanding;
5. a retry loop risk in Security deep links;
6. an upload-size mismatch, corrected to the established 5 MB photo limit;
7. missing password visibility controls and the approved Stripe payout-timing guidance.
8. a cross-tab logout race in which an in-flight session refresh could repopulate local identity during sign-in navigation.
9. a profile-save status phrase that collided with LPC's guard against invented payment-verification states.

The broader browser run also produced one Firefox navigation timeout. The same shell test passed on focused retry without a code or timeout change, so it is classified as a transient test-infrastructure event.

## Focused verification

- Phase 5 Jest contract: 1 suite, 7 tests passed.
- V2 Settings browser matrix: 15/15 passed across Chromium, Firefox, and WebKit.
- Legacy Profile Settings accessibility retry: 3/3 passed across Chromium, Firefox, and WebKit.
- Firefox V2 shell stability retry: 1/1 passed.

## Closing verification

- Complete Jest suite under Node 24.18.0: 199/199 suites and 1,515/1,515 tests passed.
- Complete paralegal browser matrix: all Phase 5 and V2 checks passed across Chromium, Firefox, and WebKit. The run finished 194/195 because Firefox stalled once before `DOMContentLoaded` on the unrelated public Help page; that exact test then passed 10/10 without a code or timeout change.
- Cross-tab logout race stress test: 10/10 passed in WebKit after the session-generation correction.
- JavaScript syntax: 641 files parsed.
- Frontend hygiene: 37 entry points, 496 local assets, 77 reachable modules, and 40 reachable stylesheets passed.
- Frontend bindings: 65 scripts passed with no unused bindings or silently discarded awaited failures.
- API contract: 238 frontend API literals resolved to 356 mounted route patterns.
- No-theater gate: 488 production/operator files and 6 governed historical records passed.
- Performance: 188 files totaling 5,293.9 KiB passed the unchanged repository budgets.
- No new skips were introduced.

The audit also removed orphaned local Playwright and MongoMemoryServer processes from prior runs while preserving the required development server on port 5050. No production system, production data, Stripe account, or deployment target was accessed.

## Known boundary after Phase 5

The backend profile update endpoint remains last-write-wins and does not expose an optimistic-concurrency version. V2 limits stale local recovery and serializes its own autosaves, but simultaneous edits in separate tabs can still race at the server boundary. Changing that contract would be backend behavior work and is not part of this visual/application migration phase.

Phase 6 remains separately gated: authenticated Help, complete Search destinations, notification reconciliation, and full Assistant context integration.
