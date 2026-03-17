# Attorney Tester Checklist

Use this for a manual pass through the attorney experience on Let’s-ParaConnect.

## Tester Info
- Tester name:
- Date:
- Device/browser:
- Environment/URL:
- New account or existing account:

## Before You Start
- [ ] Use a fresh browser session or Incognito window.
- [ ] If payments are tested, use only approved test payment details.
- [ ] Keep notes on anything confusing, broken, slow, or misleading.
- [ ] If something fails, write down the exact page, action, and error message.

## 1. Landing + Access
- [ ] Homepage loads without broken layout, missing images, or console-visible errors.
- [ ] Main navigation links work.
- [ ] `signup.html` opens correctly.
- [ ] `login.html` opens correctly.
- [ ] `forgot-password.html` opens correctly.

## 2. Attorney Sign Up
- [ ] Select the `Attorney` role.
- [ ] Required attorney-only fields appear.
- [ ] Terms checkbox is visible and required.
- [ ] Good-standing confirmation is visible and required.
- [ ] Price acknowledgement is visible and required.
- [ ] Validation catches missing or invalid fields clearly.
- [ ] Successful sign-up leads to the correct next step without a dead end.

## 3. Login
- [ ] Valid attorney credentials log in successfully.
- [ ] Attorney lands on `dashboard-attorney.html`.
- [ ] Invalid login shows a clear error message.
- [ ] Logout works and returns to `login.html`.
- [ ] Logging back in returns to the attorney dashboard cleanly.

## 4. First-Time Onboarding
- [ ] First login experience feels clear and not overwhelming.
- [ ] Any attorney onboarding tour or prompts display correctly.
- [ ] Tour steps point to real elements and do not get stuck.
- [ ] Skipping or closing onboarding does not break the dashboard.
- [ ] Returning to the dashboard after onboarding feels consistent.

## 5. Attorney Profile / Account Settings
- [ ] Open account settings/profile from the attorney dashboard.
- [ ] Profile fields load with the current user data.
- [ ] Update core profile details successfully.
- [ ] Save confirms success and persists after refresh.
- [ ] Profile photo/avatar flow works if tested.
- [ ] Preview/public profile links work if shown.
- [ ] Notification/settings toggles save correctly if tested.

## 6. Billing / Payment Method
- [ ] Open the Billing view.
- [ ] Billing page loads without broken sections.
- [ ] Add payment method flow opens correctly. (Use test card: 4242 4242 4242 4242 cvc: any 3  digits. date: any future date)
- [ ] Payment form loads correctly.
- [ ] Saving a payment method succeeds, or any failure is explained clearly.
- [ ] Saved payment method summary appears after setup.
- [ ] Stripe billing portal button works.
- [ ] Billing page remains usable after refresh.

## 7. Create a Case
- [ ] Create a new case.
- [ ] Multi-step case flow is understandable.
- [ ] Required fields are enforced clearly.
- [ ] Practice area/state/details/tasks can be entered without layout issues.
- [ ] Add at least 2-3 tasks successfully.
- [ ] Step navigation works forward and backward without losing data unexpectedly.
- [ ] Review step reflects the entered information accurately.
- [ ] Final submit/post succeeds without confusion.
- [ ] New case appears in the attorney dashboard afterward.

## 8. Drafts / Case Management
- [ ] If drafts are available, saving a draft works.
- [ ] Draft appears in the drafts section.
- [ ] Re-opening a draft restores the saved information.
- [ ] Active cases list loads correctly in `dashboard-attorney.html#cases`.
- [ ] Search/filter on the cases view works if used.
- [ ] Case row actions menu opens and closes correctly (Active, Drafts, Archive, Inquiries, etc).

## 9. Browse Paralegals / Applications
attn: do not interact with any paralegals on browse-paralegals.html! Clicking and viewing is ok, but do not 'hire' etc.
- [ ] `browse-paralegals.html` loads correctly if used.
- [ ] Paralegal cards/details are understandable.
- [ ] Opening a paralegal profile works if used.
- [ ] Applicant list on an attorney case opens correctly (only seen after a paralegal applies to your case).
- [ ] Applicant details render clearly.
- [ ] Reject/remove applicant works if tested.
- [ ] Rejected applicants no longer appear as active candidates.

## 10. Hire + Funding Flow
- [ ] Hiring is available only when expected.
- [ ] If no payment method is on file, the product clearly directs the attorney to Billing.
- [ ] After adding payment, the hire/funding flow can be resumed.
- [ ] Hiring a paralegal succeeds without duplicate or confusing state.
- [ ] Case status updates appropriately after hire.
- [ ] Other applicants are handled correctly after a hire.

## 11. Case Workspace
- [ ] Open the case workspace in `case-detail.html` (only available after a paralegal has been hired.)
- [ ] Case title, status, task list, and participant info load correctly.
- [ ] Messaging works in the workspace.
- [ ] Message sending feels immediate and readable.
- [ ] File/document section loads correctly.
- [ ] Uploading a document works if tested.
- [ ] Download/open actions work for uploaded files if tested.
- [ ] Task completion/status behavior feels clear.
- [ ] Refreshing the page preserves the correct case state.

## 12. Notifications
- [ ] Notification dropdown loads on the dashboard.
- [ ] New notifications are understandable and linked to the right place.
- [ ] Opening a notification routes to the expected view.
- [ ] Read/unread state updates correctly if tested.

## 13. Completion / Archive / Payment History
- [ ] Complete-and-release button is only available when all tasks are checked.
- [ ] Completion language is clear about what happens next.
- [ ] Successful completion updates the case status correctly.
- [ ] Archived/completed matter appears in the correct section afterward.
- [ ] Billing/payment history reflects the completed payment if applicable.
- [ ] Archive or receipt links work if shown.

## 14. Overall Quality
- [ ] Desktop layout feels polished and trustworthy.
- [ ] Mobile or narrow-window layout is usable if tested.
- [ ] Buttons, links, and menus feel consistent.
- [ ] Pages load at a reasonable speed.
- [ ] Error messages are clear and actionable.
- [ ] Nothing feels legally risky, confusing, or misleading for an attorney user.

## Bug Report Format
- Page/link:
- What you tried to do:
- What happened:
- What you expected:
- Screenshot/video:

## Final Questions
- [ ] Would you trust this enough to use for a real legal workflow?
- [ ] What felt confusing?
- [ ] What felt polished?
- [ ] What would make you hesitate to continue?