# Withdrawal + Dispute + Relist QA Checklist

Use separate sessions for Attorney, Paralegal, Admin.

**Setup**
- [ ] Record the exact environment and release commit; use only named test accounts and authorized Stripe test fixtures.
- [ ] Start the web, incident-worker, automation, and operations-monitor processes required by the environment.
- [ ] Create a Matter with 3+ tasks, confirm payment, and hire a paralegal.
- [ ] Open `case-detail.html` for the Attorney and Paralegal.

**A. Withdraw With 0 Tasks Checked**
- [ ] Paralegal uses flag menu → Request Withdrawal
- [ ] Paralegal redirected to `dashboard-paralegal.html#cases`
- [ ] Matter appears in completed Matters as Withdrawn.
- [ ] Paralegal receives withdrawal notification
- [ ] Paralegal receipt available for $0 payout
- [ ] Attorney receives $0 payout notification
- [ ] Attorney receives a second notification that the Matter was relisted.
- [ ] Matter is visible on `browse-jobs.html`.
- [ ] Matter becomes eligible for hire only after the relisted state is confirmed.

**B. Withdraw With 1+ Tasks Checked, Attorney Partial Payout**
- [ ] Check 1 task, leave at least 1 unchecked
- [ ] Paralegal withdraws
- [ ] Attorney auto‑prompt appears (Paralegal Withdrawal popup)
- [ ] Attorney selects Enter Partial Payout, enters valid amount
- [ ] Modal shows finality disclaimer + Terms/Help links
- [ ] The UI and API enforce a maximum attorney-selected partial payout of 70% of the original Matter payout.
- [ ] Payout finalized + receipts generated
- [ ] Matter relists automatically with remaining balance/tasks.
- [ ] Matter is visible and hireable on `browse-jobs.html`.
- [ ] Paralegal cannot open dispute after partial payout

**C. Withdraw With 1+ Tasks Checked, Attorney Close Without Release**
- [ ] Paralegal withdraws
- [ ] Attorney selects Close Without Release
- [ ] 24‑hour dispute window begins (paralegal can open a dispute)
- [ ] Matter is not visible on `browse-jobs.html`.
- [ ] Hiring is blocked while window is active
- [ ] The Paralegal completed-Matters view explains the 24-hour review window.
- [ ] If no review is requested within 24 hours, the Matter is relisted automatically and completed task state remains intact.
- [ ] If dispute is filed → admin receives email + in‑app notification

**D. Dispute Opened, Admin Resolves With Partial Payout**
- [ ] Paralegal requests review from the completed-Matters view.
- [ ] Admin sets partial payout + finalizes
- [ ] Receipts generated for both parties
- [ ] Matter is relisted automatically after admin resolution.
- [ ] If admin goes beyond 24h → attorney + paralegal receive “still reviewing” email + in‑app

**E. Dispute Opened, Admin Resolves With $0 (Reset)**
- [ ] Admin finalizes $0 payout
- [ ] Tasks/messages/files remain intact
- [ ] Matter is relisted automatically after admin resolution.

**F. All Tasks Checked (No Withdrawal/Dispute)**
- [ ] All tasks checked complete
- [ ] Paralegal cannot request withdrawal
- [ ] Attorney confirms completion and the full Matter payment release through the canonical workflow.
- [ ] No disputes/withdrawals available

**Access Control**
- [ ] After withdrawal, the Paralegal cannot access `case-detail.html` for that Matter except through an explicitly authorized review path.
- [ ] Review access appears where permitted; the withdrawn Paralegal can request review from completed Matters.

**Relist / Hire Lock**
- [ ] No relist during dispute window or active dispute
- [ ] Hire is disabled until payout finalized

**Applicants**
- [ ] Attorney can remove an applicant (rejects applicant + sends notification)
- [ ] Removed applicant disappears from the applicant list and cannot reapply unless the Matter is relisted.

**UI / Styling**
- [ ] Matter Actions dialog is readable, keyboard operable, and correctly labelled.
- [ ] Notifications have no shadows and solid blue background
- [ ] Send button is upward arrow with slow gold hover fade
