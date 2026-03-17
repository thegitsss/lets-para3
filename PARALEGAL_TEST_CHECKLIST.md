# Paralegal Tester Checklist

Use this for a manual pass through the paralegal experience on Let’s-ParaConnect.

## Tester Info
- Tester name:
- Date:
- Device/browser:

## Before You Start
- [ ] Use a fresh browser session or Incognito window.
- [ ] If payouts or payments are involved, use only approved test details. (use 5555 5555 5555 4444 cvc: any 3 digits. date: any future date.)
- [ ] Keep notes on anything confusing, broken, slow, or misleading.
- [ ] If something fails, write down the exact page, action, and error message.

## 1. Landing + Access
- [ ] Homepage loads without broken layout, missing images, or obvious errors.
- [ ] Main navigation links work.
- [ ] `signup.html` opens correctly.
- [ ] `login.html` opens correctly.
- [ ] `forgot-password.html` opens correctly.

## 2. Paralegal Sign Up
- [ ] Select the `Paralegal` role.
- [ ] Paralegal-only fields appear.
- [ ] Terms checkbox is visible and required.
- [ ] Admission requirements link is visible and understandable.
- [ ] Validation catches missing or invalid fields clearly.
- [ ] LinkedIn / experience / optional upload fields behave correctly if tested.
- [ ] Successful sign-up leads to a clear next step.
- [ ] If the account enters review/pending status, that message is understandable.

## 3. Login
- [ ] Valid paralegal credentials log in successfully.
- [ ] Approved paralegal lands on `dashboard-paralegal.html`.
- [ ] Invalid login shows a clear error message.
- [ ] Logout works and returns to `login.html`.
- [ ] Logging back in returns to the correct paralegal experience cleanly.

## 4. First-Time Onboarding
- [ ] First login experience feels clear and not overwhelming.
- [ ] Any paralegal onboarding tour or welcome prompt displays correctly.
- [ ] Tour steps point to real elements and do not get stuck.
- [ ] Tour can continue into profile/settings correctly.
- [ ] Skipping or closing onboarding does not break the dashboard.

## 5. Paralegal Profile / Account Settings
- [ ] Open account settings/profile from the dashboard.
- [ ] Profile fields load with the current user data.
- [ ] Update bio, skills, and practice areas successfully.
- [ ] Save confirms success and persists after refresh.
- [ ] Profile photo/avatar flow works if tested.
- [ ] Resume upload works if tested.
- [ ] Certificate upload works if tested.
- [ ] Writing sample upload works if tested.
- [ ] Removing and re-saving profile documents works if tested.
- [ ] Preview/public profile links work if shown.

## 6. Stripe Connect / Payout Setup
- [ ] Stripe payout status is visible in settings or dashboard.
- [ ] `Connect Stripe Account` / update button opens correctly.
- [ ] Stripe onboarding flow starts without a dead end.
- [ ] Returning from Stripe leaves the account in a clear state.
- [ ] Connected status is shown correctly after completion.
- [ ] If Stripe is not connected, the app explains what actions are blocked.

## 7. Dashboard
- [ ] `dashboard-paralegal.html` loads without broken sections.
- [ ] Key metrics/cards render correctly.
- [ ] Unread messages / activity / invitations / applications areas make sense.
- [ ] Any profile or approval banners are understandable.
- [ ] Refreshing the dashboard preserves the correct state.

## 8. Browse Open Jobs
- [ ] `browse-jobs.html` loads available jobs correctly.
- [ ] Job cards are clear and easy to scan.
- [ ] Opening a job modal/detail works.
- [ ] Attorney preview/profile link works if shown.
- [ ] If Stripe is required, the gating message is clear before applying.
- [ ] If no jobs are available, the empty state feels intentional.

## 9. Apply to a Job
- [ ] Apply action is available only when expected.
- [ ] Cover letter prompt/form is understandable.
- [ ] Application validation is clear.
- [ ] Successful application shows confirmation.
- [ ] Duplicate/confusing application state does not occur.
- [ ] Applied job appears in `paralegal-applications.html`.

## 10. My Applications
- [ ] `paralegal-applications.html` loads correctly.
- [ ] Submitted applications list is accurate.
- [ ] Status labels are understandable.
- [ ] Opening an application detail view/modal works.
- [ ] Application detail shows the correct job info and cover message.
- [ ] Deep links with a specific application still open correctly if tested.

## 11. Assigned Cases (after applying to a case and getting hired)
- [ ] `paralegal-assigned.html` loads correctly.
- [ ] Assigned matters list shows the right attorney/case info.
- [ ] Workspace access becomes available only when attorney funding/status allow it. 
- [ ] Opening an eligible hired/assigned case goes to `case-detail.html`.

## 12. Case Workspace
- [ ] Open the case workspace in `case-detail.html`.
- [ ] Case title, status, tasks, and attorney info load correctly.
- [ ] Messaging works in the workspace.
- [ ] Message sending feels immediate and readable.
- [ ] File/document section loads correctly.
- [ ] Uploading a file works if tested.
- [ ] Download/open actions work for shared files if tested.
- [ ] Task status behavior feels clear.
- [ ] Refreshing the page preserves the correct case state.

## 14. Withdrawal / Dispute Flow
- [ ] If testing an active case, the paralegal can find the withdrawal option when eligible.
- [ ] Withdrawal messaging is understandable before confirming.
- [ ] After withdrawal, the next state is clear to the paralegal.
- [ ] If a dispute window exists, that is explained clearly.
- [ ] If dispute actions are available, they are easy to find.
- [ ] Completed/withdrawn matter status is shown correctly afterward.

## 15. Notifications + Earnings / Payouts
- [ ] Notification bell loads on the dashboard.
- [ ] New notifications are understandable and linked to the right place when clicked.
- [ ] Read/unread notification state updates correctly if tested.
- [ ] Earnings/payout information is understandable if shown.
- [ ] Stripe/payout state does not feel misleading.

## 16. Overall Quality
- [ ] Desktop layout feels polished and trustworthy.
- [ ] Mobile or narrow-window layout is usable if tested.
- [ ] Buttons, links, and menus feel consistent.
- [ ] Pages load at a reasonable speed.
- [ ] Error messages are clear and actionable.
- [ ] Nothing feels confusing or risky for a professional paralegal user.

## Bug Report Format
- Page:
- What you tried to do:
- What happened:
- What you expected:
- Screenshot/video:

## Final Questions
- [ ] Would you trust this enough to use for real work?
- [ ] What felt confusing?
- [ ] What felt polished?
- [ ] What would make you hesitate to continue?