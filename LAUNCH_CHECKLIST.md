# Launch Checklist (Target: Tuesday, Feb 17, 2026)

## Must‑Do Before Tuesday
- [ ] MongoDB reliability verified (no `ETIMEDOUT`, no `PoolClearedError`) under typical load.
- [ ] SSE + polling fallback verified in `case-detail.html` (messages, documents, tasks).
- [x] Message email suppression window set to 2 hours (`MESSAGE_EMAIL_SUPPRESS_MINUTES=120`).
- [ ] Stripe live keys confirmed in production environment.
- [ ] Full escrow lifecycle test completed end‑to‑end.
- [ ] Payment failure handling verified in fund flow and case completion flow.
- [ ] Role separation validated (attorney‑only vs paralegal‑only views).
- [x] Client access pages removed (`case-dashboard.html`, `case-invoices.html`).
- [x] Platform disclosures shown in `create-case.html` review step.
- [x] Terms updated to explicitly state no clients on platform and attorney supervision.
- [ ] Notification dropdown verified on attorney + paralegal dashboards.
- [ ] Notifications verified for: paralegal applies, attorney hires, payout released.
- [ ] Email volume verified not excessive for message threads.
- [ ] DB backups confirmed enabled and recent.
- [ ] Rollback plan documented and tested (<4 hours).

## Should‑Do Before Tuesday
- [ ] Audit logging verified for messages, documents, disputes.
- [ ] “Last viewed” updates verified for email suppression accuracy.
- [ ] Attorney onboarding flow validated (tour → profile → payment → post case).
- [ ] Step cards validated (no disappearing/glitching).
- [x] `case-detail.html` status never shows “pending funding” (now only “In Progress” / “Disputed”).
- [x] Complete & Release modal centered (title + buttons).
- [ ] Case detail 2‑panel layout verified on smaller screens.
- [ ] Load test: 10+ active cases with messages + documents.

## Nice‑To‑Have
- [x] Admin system‑status banner added (uses `/api/health`).
- [ ] Uptime + error alerting to owner email.
- [x] Contact Support link moved into Help page.
- [x] Rollback plan drafted (`ROLLBACK_PLAN.md`).
- [x] Support macros drafted (payment failure, disputes, onboarding).
