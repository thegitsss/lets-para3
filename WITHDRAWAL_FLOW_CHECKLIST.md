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
- [ ] Payout finalized + receipts generated
- [ ] Case relists automatically with remaining balance/tasks
- [ ] Case is visible + hireable on `browse-jobs.html`

**C. Withdraw With 1+ Tasks Checked, Attorney Rejects Payout**
- [ ] Paralegal withdraws
- [ ] Attorney selects Reject Payout
- [ ] Dispute window opens for 24 hours
- [ ] Case is NOT visible on `browse-jobs.html`
- [ ] Hiring is blocked while window is active
- [ ] Paralegal Completed Cases shows dispute window + “Flag dispute”

**D. Dispute Opened, Admin Resolves With Partial Payout**
- [ ] Paralegal flags dispute in Completed Cases
- [ ] Admin sets partial payout + finalizes
- [ ] Receipts generated for both parties
- [ ] Case does NOT auto‑relist
- [ ] Attorney can manually relist

**E. Dispute Opened, Admin Resolves With $0 (Reset)**
- [ ] Admin finalizes $0 payout
- [ ] Tasks reset to unchecked
- [ ] Workspace reset (messages/files cleared from active workspace)
- [ ] Archive remains available
- [ ] Attorney can manually relist as a fresh case

**F. All Tasks Checked (No Withdrawal/Dispute)**
- [ ] All tasks checked complete
- [ ] Paralegal cannot request withdrawal
- [ ] Attorney releases full funds normally
- [ ] No disputes/withdrawals available

**Access Control**
- [ ] After withdrawal, paralegal cannot access `case-detail.html` for that case

**Relist / Hire Lock**
- [ ] No relist while payout is unresolved
- [ ] No relist during dispute window or active dispute
- [ ] Hire is disabled until payout finalized

**UI / Styling**
- [ ] Case Actions popup styled, headers centered
- [ ] Notifications have no shadows and solid blue background
- [ ] Send button is upward arrow with slow gold hover fade
