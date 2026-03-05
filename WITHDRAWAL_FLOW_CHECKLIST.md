# Withdrawal + Dispute + Relist QA Checklist

Use separate sessions for Attorney, Paralegal, Admin.

**Setup**
- [ ] Start backend + frontend
- [ ] Create case with 3+ tasks, fund case, hire paralegal
- [ ] Open `case-detail.html` for Attorney + Paralegal

**A. Withdraw With 0 Tasks Checked**
- [ ] Paralegal uses flag menu → Request Withdrawal
- [ ] Paralegal redirected to `dashboard-paralegal.html#cases`
- [ ] Case appears in Completed Cases as Withdrawn
- [ ] Paralegal receives withdrawal notification
- [ ] Paralegal receipt available for $0 payout
- [ ] Attorney receives $0 payout notification
- [ ] Attorney receives second notification: case relisted
- [ ] Case visible on `browse-jobs.html`
- [ ] Case is hireable immediately

**B. Withdraw With 1+ Tasks Checked, Attorney Partial Payout**
- [ ] Check 1 task, leave at least 1 unchecked
- [ ] Paralegal withdraws
- [ ] Attorney auto‑prompt appears (Paralegal Withdrawal popup)
- [ ] Attorney selects Enter Partial Payout, enters valid amount
- [ ] Modal shows finality disclaimer + Terms/Help links
- [ ] Modal shows “Recommended: no more than 70%” hint (no hard cap)
- [ ] Payout finalized + receipts generated
- [ ] Case relists automatically with remaining balance/tasks
- [ ] Case is visible + hireable on `browse-jobs.html`
- [ ] Paralegal cannot open dispute after partial payout

**C. Withdraw With 1+ Tasks Checked, Attorney Close Without Release**
- [ ] Paralegal withdraws
- [ ] Attorney selects Close Without Release
- [ ] 24‑hour dispute window begins (paralegal can open a dispute)
- [ ] Case is NOT visible on `browse-jobs.html`
- [ ] Hiring is blocked while window is active
- [ ] Paralegal Completed Cases shows: “You may open a dispute within 24 hours of case closure.”
- [ ] If no dispute is filed by 24h → case auto‑relisted, tasks remain checked
- [ ] If dispute is filed → admin receives email + in‑app notification

**D. Dispute Opened, Admin Resolves With Partial Payout**
- [ ] Paralegal flags dispute in Completed Cases
- [ ] Admin sets partial payout + finalizes
- [ ] Receipts generated for both parties
- [ ] Case auto‑relisted after admin resolution
- [ ] If admin goes beyond 24h → attorney + paralegal receive “still reviewing” email + in‑app

**E. Dispute Opened, Admin Resolves With $0 (Reset)**
- [ ] Admin finalizes $0 payout
- [ ] Tasks/messages/files remain intact
- [ ] Case auto‑relisted after admin resolution

**F. All Tasks Checked (No Withdrawal/Dispute)**
- [ ] All tasks checked complete
- [ ] Paralegal cannot request withdrawal
- [ ] Attorney releases full funds normally
- [ ] No disputes/withdrawals available

**Access Control**
- [ ] After withdrawal, paralegal cannot access `case-detail.html` for that case
- [ ] Dispute access appears in workspace; withdrawn paralegal can also dispute from Completed Cases

**Relist / Hire Lock**
- [ ] No relist during dispute window or active dispute
- [ ] Hire is disabled until payout finalized

**Applicants**
- [ ] Attorney can remove an applicant (rejects applicant + sends notification)
- [ ] Removed applicant disappears from applicants list and cannot reapply unless case is relisted

**UI / Styling**
- [ ] Case Actions popup styled, headers centered
- [ ] Notifications have no shadows and solid blue background
- [ ] Send button is upward arrow with slow gold hover fade
