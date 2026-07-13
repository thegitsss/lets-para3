# LPC Premium Product Upgrade Spec

Date: July 7, 2026

Purpose: convert vague upgrade language into concrete, testable product requirements. This is the execution standard for making LPC feel like a modern $150,000-$500,000 legal-tech marketplace that attorneys and paralegals trust, understand, and return to regularly.

## What The Vague Words Mean

### "Better"

An experience is better when it removes user uncertainty or repeated effort.

Concrete standard:

- The user always knows what status they are in.
- The user always knows the next action available to them.
- The user understands why an action is disabled.
- The user does not need to remember where something lives.
- The screen reduces typing, guessing, searching, or support requests.
- The workflow prevents obvious mistakes before they happen.
- The page has useful empty states, loading states, and error states.

Example:

- Weak: "No applications yet."
- Better: "No applications yet. Your matter is live. Attorneys usually receive better responses when the scope, budget, deadline, and required skills are clear."

### "Stronger"

An experience is stronger when it increases trust, safety, reliability, and confidence.

Concrete standard:

- Money-impacting actions clearly explain the financial result before confirmation.
- Destructive or irreversible actions require a clear confirmation and reason where appropriate.
- Sensitive workflows show status, timestamp, actor, and outcome.
- Admin can recover from stuck states without guessing.
- Role boundaries are visible and enforced.
- High-risk actions create audit evidence.
- Failure states are actionable, not generic.

Example:

- Weak: "Payment failed."
- Stronger: "Payment was not completed. No paralegal payout was scheduled. Update the payment method or retry funding from Billing."

### "More Polished"

An experience is more polished when it feels intentionally designed, visually consistent, and free of rough edges.

Concrete standard:

- Buttons, filters, modals, form fields, cards, tabs, and status badges behave consistently across pages.
- Text fits inside containers on mobile and desktop.
- Layout does not jump when filters, states, data, or loading results change.
- Empty screens feel designed, not abandoned.
- Copy uses professional legal-tech language.
- Visual hierarchy makes the most important action obvious.
- The same concept uses the same label everywhere.
- There are no dead-end pages, duplicate/conflicting CTAs, or confusing redirects.

Example:

- Weak: different pages using "Cases," "Matters," "Jobs," and "Assignments" inconsistently.
- More polished: attorney-facing work is consistently labeled "Matters"; paralegal-facing work can say "Opportunities" before hiring and "Assigned Matters" after hiring.

### "Cleaner"

An experience is cleaner when the screen is easier to scan and act on.

Concrete standard:

- Each page has one primary purpose.
- Secondary actions are visually secondary.
- Dense admin data is grouped by urgency and risk.
- Repeated cards use consistent structure.
- Status labels are short and meaningful.
- Users do not have to read paragraphs to decide what to do next.
- Tables/cards avoid visual noise and expose the most relevant fields first.

Example:

- Weak: a dashboard with many equal-weight cards.
- Cleaner: "Needs attention" first, then "Active matters," then "Recent activity," then secondary account/profile links.

### "Professional"

An experience is professional when it reflects the seriousness of legal work and money movement.

Concrete standard:

- Copy is precise and calm.
- Legal/payment disclaimers appear where decisions are made, not buried after the fact.
- The interface does not look playful, experimental, or unfinished.
- Records have timestamps and accountability.
- Case, payment, dispute, and document workflows feel traceable.
- Attorney and paralegal profiles read like professional work credentials, not social profiles.

### "Highly Amenable"

For LPC, "amenable" means easy to work with and adaptive to the user's intent without feeling complicated.

Concrete standard:

- Users can recover from mistakes.
- Users can save progress.
- Users can pause and return later.
- Users can filter, clear filters, and refine without page jumps.
- Users get suggested next actions based on current state.
- Users can contact support from relevant workflows with context attached.
- Repeated users get shortcuts instead of starting from scratch.

### "Incredibly Reliable"

Reliable means predictable, observable, recoverable, and tested.

Concrete standard:

- Critical workflows have regression tests.
- Payment and webhook outcomes are idempotent.
- Admin can see failed/stuck background work.
- The same action always produces the same type of feedback.
- No silent failures.
- No stale status labels after mutations.
- No local cache is treated as source of truth for permissions or money.
- Errors include enough context for user recovery or admin triage.

### "Keeps Users Coming Back"

Retention comes from useful ongoing value, not decoration.

Concrete standard:

- Attorneys can quickly post another matter.
- Attorneys can find previously used or saved paralegals.
- Attorneys see matter progress without asking.
- Paralegals see profile readiness and relevant opportunities.
- Paralegals understand how to stay visible and competitive.
- Both sides receive useful, timely notifications.
- Dashboards answer: "What changed?" and "What do I need to do today?"

## Upgrade Standards By Surface

### Public Visitor Experience

Done means:

- Landing page explains LPC's value in less than 10 seconds.
- Visitor can distinguish attorney path from paralegal path immediately.
- Browse paralegals feels stable, credible, and useful.
- Public paralegal profiles show enough professional signal without exposing private information.
- Signup path explains approval and platform expectations.
- Contact/support forms confirm receipt and set expectations.

Upgrade requirements:

- Clear attorney CTA.
- Clear paralegal admission CTA.
- Trust-oriented copy around vetting, payment infrastructure, role limitations, and professional standards.
- Public no-results state that guides the visitor instead of feeling empty.
- Consistent public navigation and footer.
- Mobile public pages without overlapping text, hidden CTAs, or unusable filters.

### Attorney Dashboard

Done means:

- Attorney sees exactly what needs attention today.
- Attorney can create, fund, monitor, message, and complete matters without hunting.
- Each matter card shows status, next action, money state, paralegal/applicant state, and last activity.
- Empty dashboard guides first action.
- Billing/funds area explains readiness and required action.

Upgrade requirements:

- "Needs attention" section.
- First-time attorney checklist: profile, payment method, first matter.
- Recently updated matters.
- Draft matters with "continue" action.
- Open matters with applicant/invite state.
- Active matters with message/file/task indicators.
- Payment states using consistent language.
- Cleaner case/matter cards.
- Stronger mobile layout for tabs, filters, and matter cards.

### Case Posting / Create Case

Done means:

- Attorney can create a well-scoped matter confidently.
- The form guides scope, tasks, budget, state, deadline, and expectations.
- Save and resume is obvious.
- Errors explain what to fix.
- Review screen makes the post feel professional before submission.

Upgrade requirements:

- Step-level progress that does not feel heavy.
- Scope/task suggestions.
- Budget minimum explanation.
- State/jurisdiction clarity.
- Deadline guidance.
- Preview before posting.
- Stronger draft recovery.
- No ambiguous "case/job/matter" language.

### Browse Paralegals

Done means:

- Attorneys can find credible available paralegals quickly.
- Filtering feels stable and predictable.
- Cards expose the right decision fields.
- Profile and invite actions are obvious.

Upgrade requirements:

- Stable filter panel.
- Multi-state filtering already completed.
- Clear all filters action.
- No layout jump on filter changes.
- Availability handled server-side; unavailable paralegals hidden.
- Consistent cards: name, state, practice areas, experience, availability, profile strength/trust signals.
- Empty results with useful next steps.
- Optional saved/favorite paralegals.

### Paralegal Profile

Done means:

- Attorney can assess fit and professionalism quickly.
- Paralegal owner understands profile readiness.
- Profile visibility status is explicit.

Upgrade requirements:

- Attorney-facing trust signals: approved, visible, practice areas, state, experience, documents where allowed.
- Paralegal owner visibility status: visible, hidden due to availability, pending photo, incomplete profile.
- Profile strength/completion checklist.
- Clear edit path for owner.
- Invite/contact actions only for authorized attorney states.
- Mobile profile without oversized or buried critical information.

### Case Workspace / Case Detail

Done means:

- This is the professional hub for the matter.
- Both sides can tell what is happening, what changed, what is due, and what action is next.
- Files, messages, tasks, payment, and status are connected.

Upgrade requirements:

- Matter status header with next action.
- Case timeline/activity feed.
- Payment/release status visible without leaving workspace.
- Task checklist with ownership and completion state.
- Document area with version, status, uploader, timestamp, and next action.
- Message area with unread state and stable layout.
- Completion/release flow with strong confirmation.
- Dispute/withdraw/relist states with clear consequences.

### Paralegal Dashboard

Done means:

- Paralegal knows how to stay eligible, visible, and paid.
- Applications, invites, assigned matters, and payout readiness are obvious.

Upgrade requirements:

- Visibility/readiness card.
- Stripe payout readiness card.
- Availability status card.
- Relevant opportunities / browse jobs entry.
- Application tracker with statuses.
- Invite/pre-engagement queue.
- Assigned matters with next action and payment state.
- Profile improvement guidance.

### Admin Control Room

Done means:

- Admin can operate LPC daily without guessing.
- Urgent items surface first.
- Money, case, user, dispute, and support risks are visible and recoverable.

Upgrade requirements:

- "Needs attention today" queue.
- Pending approvals queue.
- Profile photo review queue.
- Payment-risk queue.
- Case-risk queue.
- Dispute queue.
- Support/incident queue with affected user/case/payment context.
- Admin action history per user/case/payment.
- Destructive actions require reason and confirmation.
- Test/dev harness behavior clearly separated from production admin flows.

### Payments / Escrow-Like Workflow

Done means:

- Users understand exactly where money stands.
- Admin can reconcile and recover stuck payment states.
- Critical money paths are tested.

Upgrade requirements:

- Attorney payment readiness state.
- Funding state.
- Failed/requires-action recovery.
- Release/payment completion state.
- Paralegal payout readiness and payout pending state.
- Refund/dispute state.
- Admin reconciliation view.
- Professional receipts.
- Consistent payment language across dashboard, case detail, billing, emails/notifications.

### AI Assistance

Done means:

- AI reduces work in high-friction workflows without bypassing permissions or creating legal-risk confusion.

Upgrade requirements:

- Attorney matter-scope assistant.
- Task generator from case description.
- Budget/scope completeness review.
- Paralegal profile polish assistant.
- Admin risk summarizer.
- Dispute/case timeline summarizer.
- AI output always editable and confirm-before-save.
- AI cannot take money, account, case, or admin actions without authorized human confirmation.

### Production Operations

Done means:

- LPC is observable, recoverable, and safe to operate with real users.

Upgrade requirements:

- Health checks.
- Error tracking.
- Payment webhook monitoring.
- Scheduler/job visibility.
- Admin alerting for failed money/case workflows.
- Regression tests for critical attorney/paralegal/admin paths.
- Release checklist.
- Rollback plan.
- Environment-variable checklist.

## Execution Order

### Phase 1: Attorney Trust And Repeat Use

1. Attorney dashboard "Needs attention" and first-time checklist.
2. Matter card redesign with status, next action, money state, and last activity.
3. Case posting guidance and preview polish.
4. Browse/profile trust signals and saved paralegal path.
5. Attorney payment language cleanup.

### Phase 2: Case Workspace Premium Upgrade

1. Workspace status header.
2. Matter timeline/activity feed.
3. Document version/status polish.
4. Task ownership/next-action clarity.
5. Completion/release/dispute state clarity.

### Phase 3: Paralegal Retention And Professionalism

1. Visibility/readiness card.
2. Profile completion score/checklist.
3. Payout readiness card.
4. Application/invite/pre-engagement tracker.
5. Assigned matter next-action cards.

### Phase 4: Admin Operations

1. Needs-attention queue.
2. Payment-risk queue.
3. Case-risk queue.
4. Dispute/support queue improvements.
5. Admin action history and confirmation hardening.

### Phase 5: Reliability, AI, And Production Proof

1. Payment/case lifecycle regression tests.
2. Mobile screenshot pass.
3. Monitoring and operational alerts.
4. AI assistance for scope/profile/admin summaries.
5. Release checklist and evidence bundle.

## Acceptance Evidence

Each completed upgrade must provide:

- Files changed.
- Screens affected.
- Before/after behavior summary.
- Desktop verification.
- Mobile verification where relevant.
- Test command output if logic changed.
- Remaining gaps and severity.
