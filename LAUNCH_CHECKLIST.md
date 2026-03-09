# Launch Checklist (Target: Tuesday, Feb 17, 2026)

## Must‑Do Before Tuesday
- [x] MongoDB reliability verified (no `ETIMEDOUT`, no `PoolClearedError`) under typical load (`npm run test:load:cases`).
- [x] SSE + polling fallback verified in `case-detail.html` (messages, documents, tasks).
- [x] Non‑Stripe E2E suite re‑run (auth, profile, validation, messaging, matching, error‑handling, realtime, admin, onboarding, paralegal tour).
- [x] Message email suppression window set to 2 hours (`MESSAGE_EMAIL_SUPPRESS_MINUTES=120`).
- [ ] Stripe live keys confirmed in production environment.
- [x] Full escrow lifecycle test completed end‑to‑end.
- [x] Payment failure handling verified in fund flow and case completion flow.
- [x] Role separation validated (attorney‑only vs paralegal‑only views).
- [x] Client access pages removed (`case-dashboard.html`, `case-invoices.html`).
- [x] Platform disclosures shown in `create-case.html` review step.
- [x] Terms updated to explicitly state no clients on platform and attorney supervision.
- [x] Notification dropdown verified on attorney + paralegal dashboards.
- [x] Notifications verified for: paralegal applies, attorney hires, payout released.
- [x] Email volume verified not excessive for message threads.
- [ ] DB backups confirmed enabled and recent. (Atlas backups are manual only; scheduled/continuous not enabled.)
- [x] Rollback plan documented and tested (<4 hours) (Render tabletop drill recorded).

## Should‑Do Before Tuesday
- [x] Audit logging verified for messages, documents, disputes.
- [x] “Last viewed” updates verified for email suppression accuracy.
- [x] Attorney onboarding flow validated (tour → profile → payment → post case) (`npm run test:e2e:onboarding`).
- [x] Step cards validated (no disappearing/glitching) (`npm run test:e2e:onboarding`).
- [x] `case-detail.html` status never shows “pending funding” (now only “In Progress” / “Disputed”).
- [x] Complete & Release modal centered (title + buttons).
- [x] Case detail 2‑panel layout verified on smaller screens (`npm run test:e2e:onboarding`).
- [x] Load test: 10+ active cases with messages + documents.

## Nice‑To‑Have
- [x] Admin system‑status banner added (uses `/api/health`).
- [ ] Uptime + error alerting to owner email.
- [x] Contact Support link moved into Help page.
- [x] Rollback plan drafted (`ROLLBACK_PLAN.md`).
- [x] Support macros drafted (payment failure, disputes, onboarding).
